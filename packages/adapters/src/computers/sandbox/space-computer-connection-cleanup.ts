import type { JobPublisher, SecretStore } from "@rakazo/adapter-kit";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { SecretCleanup } from "../../secrets/secret-cleanup.js";
import { finishSecretCleanup, recordSecretCleanup } from "../../secrets/secret-cleanup.js";

import { COMPUTER_CONNECTION_PROVISION_LEASE_PREFIX } from "./space-computer-provision.js";

type Deps = {
  prisma: PrismaClient;
  jobs: Pick<JobPublisher, "enqueue" | "enqueueIn" | "cancel" | "cancelIn">;
  secrets?: Pick<SecretStore, "delete"> & Partial<Pick<SecretStore, "isRemote">>;
};

/** Refuse deletion while a provider call or its durable cleanup still needs these credentials. */
export async function prepareSpaceComputerConnectionCleanup(deps: Deps, spaceId: string) {
  const retained = await deps.prisma.$transaction(async (tx) => {
    const rows = await tx.computerConnection.findMany({
      where: { spaceId },
      select: { id: true, ciphertext: true },
    });
    if (!rows.length) return { rows, pending: false };
    const [active] = await tx.$queryRaw<Array<{ active: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM "leases" l JOIN "computer_connections" c
          ON starts_with(l."key", ${COMPUTER_CONNECTION_PROVISION_LEASE_PREFIX} || c."id" || ':')
        WHERE c."spaceId" = ${spaceId} AND l."expiresAt" > clock_timestamp()
      ) AS active`;
    if (active?.active)
      throw new ClientError("CONFLICT", "Computer cleanup is waiting for provisioning to finish");
    // No provider call can begin while the Space is claimed for deletion. Its abandoned starts
    // no longer hold their cleanup jobs open; keep their home records until deletion commits.
    await tx.computer.updateMany({
      where: {
        spaceId,
        providerConnectionId: { in: rows.map((row) => row.id) },
        providerRef: null,
        state: "booting",
        space: { deletingAt: { not: null } },
      },
      data: { state: "error" },
    });
    const [queued] = await tx.$queryRaw<Array<{ pending: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM graphile_worker._private_jobs j
        JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        JOIN "computer_connections" c ON c."id" = COALESCE(
          j.payload->'payload'->>'providerConnectionId', j.payload->>'providerConnectionId')
        WHERE t.identifier = 'computer.machine-cleanup' AND c."spaceId" = ${spaceId}
      ) AS pending`;
    return { rows, pending: queued?.pending ?? false };
  });
  if (retained.pending)
    throw new ClientError(
      "CONFLICT",
      "Computer cleanup is still pending; try again when it finishes",
    );
  if (!deps.secrets) return [];
  const secrets = {
    delete: deps.secrets.delete.bind(deps.secrets),
    isRemote: deps.secrets.isRemote?.bind(deps.secrets) ?? (() => true),
  };
  return deps.prisma.$transaction(async (tx) => {
    const cleanups: SecretCleanup[] = retained.rows.map((row) => ({
      kind: "store_write",
      recordId: row.id,
      ref: row.ciphertext,
    }));
    for (const cleanup of cleanups) await recordSecretCleanup({ ...deps, secrets }, tx, cleanup);
    return cleanups;
  });
}

export async function finishSpaceComputerConnectionCleanup(deps: Deps, cleanups: SecretCleanup[]) {
  if (!deps.secrets) return;
  const secrets = {
    delete: deps.secrets.delete.bind(deps.secrets),
    isRemote: deps.secrets.isRemote?.bind(deps.secrets) ?? (() => true),
  };
  for (const cleanup of cleanups) await finishSecretCleanup({ ...deps, secrets }, cleanup);
}
