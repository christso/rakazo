import { randomUUID } from "node:crypto";
import type { StoredComputerSettings } from "@rakazo/adapters";
import {
  cleanUpUnsavedSecret,
  computerProviderDescriptor,
  loadComputerProviderSelection,
  parseStoredComputerSettings,
  refreshComputerProvider,
  savedSecretIn,
} from "@rakazo/adapters";
import type { Actor, ComputerProviderSettings, ComputerProviderUpdate } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import { isOwnerRole, lockSpaceDeletion, organizationRole, withTransactionRetry } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ComputerProviderConfigDeps } from "./computer-provider-config.js";
import { checkedComputerSettings, computerSettingsView } from "./computer-provider-config.js";

async function spaceAccess(db: Pick<Prisma.TransactionClient, "spaceMember">, actor: Actor) {
  const membership = await db.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    select: {
      role: true,
      member: { select: { role: true } },
      space: { select: { deletingAt: true } },
    },
  });
  if (!membership || membership.space.deletingAt)
    throw new ClientError("NOT_FOUND", "Space unavailable");
  return (
    isOwnerRole(membership.role) ||
    ["owner", "admin"].includes(organizationRole(membership.member.role))
  );
}

async function readableSettings(
  deps: ComputerProviderConfigDeps,
  connection: { id: string; ciphertext: string } | null,
): Promise<StoredComputerSettings | null> {
  if (!connection) return null;
  try {
    return parseStoredComputerSettings(
      await deps.secrets.load(connection.ciphertext, connection.id),
    );
  } catch (error) {
    getLogger().warn("computer_connection.settings_unreadable", {
      "error.name": error instanceof Error ? error.name : typeof error,
    });
    return null;
  }
}

export async function getSpaceComputerSettings(
  deps: ComputerProviderConfigDeps,
  actor: Actor,
): Promise<ComputerProviderSettings> {
  const canManage = await spaceAccess(deps.prisma, actor);
  const space = await deps.prisma.space.findUniqueOrThrow({
    where: { id: actor.spaceId },
    select: { computerConnection: true, computerIdlePolicy: true },
  });
  const connection = space.computerConnection;
  const settings = canManage ? await readableSettings(deps, connection) : null;
  const selection = await loadComputerProviderSelection(deps.prisma, deps.secrets);
  const view = computerSettingsView(
    connection?.provider ?? "default",
    settings,
    selection.provider === "default" ? deps.env.sandboxProvider : selection.provider,
    { scope: "space", enabled: canManage && Boolean(deps.env.computerSettingsEnabled) },
  );
  return {
    ...view,
    idlePolicy: space.computerIdlePolicy === "hibernate" ? "hibernate" : "keep-vm",
    ...(connection ? { connectionId: connection.id } : {}),
  };
}

export async function updateSpaceComputerSettings(
  deps: ComputerProviderConfigDeps,
  actor: Actor,
  input: ComputerProviderUpdate,
): Promise<ComputerProviderSettings> {
  if (!(await spaceAccess(deps.prisma, actor)))
    throw new ClientError("FORBIDDEN", "Only the Space owner and organization admins can do that");
  if (input.provider !== "default" && !deps.env.computerSettingsEnabled)
    throw new ClientError("BAD_REQUEST", "Computer settings are unavailable");
  const current = await deps.prisma.space.findUniqueOrThrow({
    where: { id: actor.spaceId },
    select: { computerConnectionId: true, computerConnection: true },
  });
  const expectedConnectionId = input.expectedConnectionId ?? null;
  if (current.computerConnectionId !== expectedConnectionId)
    throw new ClientError("CONFLICT", "Computer settings changed; reload before saving");
  const previous =
    input.provider === "default" ? null : await readableSettings(deps, current.computerConnection);
  const settings =
    input.provider === "default"
      ? null
      : await checkedComputerSettings(deps, actor, input, previous, "space");
  const supportsHibernation = settings
    ? computerProviderDescriptor(settings.provider).capabilities.hibernate === true
    : false;
  if (input.idlePolicy === "hibernate" && !supportsHibernation)
    throw new ClientError("BAD_REQUEST", "This computer connection cannot hibernate");
  const id = randomUUID();
  const stored = settings
    ? await deps.secrets.put(
        JSON.stringify({
          provider: settings.provider,
          values: settings.values,
          spendingApproved: settings.spendingApproved,
        }),
        {
          operationId: "space-computer-provider",
          traceId: "space-computer-provider",
          spaceId: actor.spaceId,
          userId: actor.userId,
          signal: new AbortController().signal,
        },
        { recordId: id },
      )
    : null;
  try {
    await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        await lockSpaceDeletion(tx, actor.spaceId);
        if (!(await spaceAccess(tx, actor)))
          throw new ClientError(
            "FORBIDDEN",
            "Only the Space owner and organization admins can do that",
          );
        if (settings && stored) {
          const paid = computerProviderDescriptor(settings.provider).capabilities
            .requiresSpendingApproval;
          await tx.computerConnection.create({
            data: {
              id,
              spaceId: actor.spaceId,
              provider: settings.provider,
              ciphertext: stored.ciphertext,
              ...(paid ? { spendingApprovedBy: actor.userId, spendingApprovedAt: new Date() } : {}),
            },
          });
          await savedSecretIn(deps, tx, stored.ciphertext);
        }
        // Prior rows remain until Space teardown: a bound machine or crashed start may still need them.
        const selected = await tx.space.updateMany({
          where: { id: actor.spaceId, computerConnectionId: expectedConnectionId },
          data: {
            computerConnectionId: settings ? id : null,
            computerIdlePolicy: supportsHibernation ? input.idlePolicy : "keep-vm",
          },
        });
        if (selected.count !== 1)
          throw new ClientError("CONFLICT", "Computer settings changed; reload before saving");
      }),
    );
  } catch (error) {
    if (stored)
      await cleanUpUnsavedSecret(deps, {
        kind: "store_write",
        recordId: id,
        ref: stored.ciphertext,
      });
    throw error;
  }
  await refreshComputerProvider(deps.sandbox);
  return getSpaceComputerSettings(deps, actor);
}
