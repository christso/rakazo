import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, runAsSystem, withTransactionRetry } from "@rakazo/db";
import { computerProviderDescriptor } from "../computer-provider-registry.js";
import { parseStoredComputerSettings } from "./configured-sandbox.js";

/** Reads a named connection only in the owning computer's Space. Never substitutes a default. */
export async function loadComputerConnection(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  id: string,
  homeKey: string,
) {
  return runAsSystem("route a computer through its original Space connection", async () => {
    const computer = homeKey
      ? await prisma.computer.findUnique({ where: { homeKey }, select: { spaceId: true } })
      : null;
    if (homeKey && !computer) throw new Error("Computer connection unavailable");
    const row = await prisma.computerConnection.findFirst({
      where: { id, ...(computer ? { spaceId: computer.spaceId } : {}) },
    });
    if (!row) throw new Error("Computer connection unavailable");
    const settings = parseStoredComputerSettings(await secrets.load(row.ciphertext, row.id));
    if (!settings || settings.provider !== row.provider)
      throw new Error("Computer connection unavailable");
    if (
      computerProviderDescriptor(row.provider).capabilities.requiresSpendingApproval &&
      (!row.spendingApprovedAt || !row.spendingApprovedBy)
    )
      throw new Error("Computer connection spending approval required");
    return { ...settings, connectionId: row.id, ciphertext: row.ciphertext };
  });
}

/** Bind new machines before the provider call, so a crashed start retries with the same account. */
export async function bindSpaceComputerConnection(prisma: PrismaClient, homeKey: string) {
  return runAsSystem("bind a new computer to its Space connection", () =>
    withTransactionRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const computer = await tx.computer.findUnique({
            where: { homeKey },
            select: {
              id: true,
              spaceId: true,
              providerRef: true,
              providerConnectionId: true,
              providerConnectionPinned: true,
              updatedAt: true,
            },
          });
          if (!computer) return null;
          if (computer.providerConnectionId) return computer.providerConnectionId;
          // Existing machines keep their original deployment/account routing until an explicit reset.
          if (computer.providerConnectionPinned) return null;
          if (computer.providerRef) {
            await tx.computer.updateMany({
              where: {
                id: computer.id,
                providerConnectionPinned: false,
                updatedAt: computer.updatedAt,
              },
              data: { providerConnectionPinned: true, updatedAt: computer.updatedAt },
            });
            return null;
          }
          const space = await tx.space.findUnique({
            where: { id: computer.spaceId },
            select: { computerConnectionId: true },
          });
          const bound = await tx.computer.updateMany({
            where: {
              id: computer.id,
              providerConnectionId: null,
              providerConnectionPinned: false,
              providerRef: null,
              updatedAt: computer.updatedAt,
            },
            data: {
              providerConnectionId: space?.computerConnectionId ?? null,
              providerConnectionPinned: true,
              // Connection metadata must not invalidate an in-progress lifecycle claim.
              updatedAt: computer.updatedAt,
            },
          });
          if (bound.count !== 1) throw new Error("Computer connection changed during start");
          return space?.computerConnectionId ?? null;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    ),
  );
}
