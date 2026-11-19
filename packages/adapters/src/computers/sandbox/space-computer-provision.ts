import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem, withLease } from "@rakazo/db";

export const COMPUTER_CONNECTION_PROVISION_LEASE_PREFIX = "computer-provision:";

export const computerConnectionProvisionKey = (connectionId: string, homeKey: string) =>
  `${COMPUTER_CONNECTION_PROVISION_LEASE_PREFIX}${connectionId}:${homeKey}`;

/** Keep credentials available until a provider call has settled, including before its first job. */
export function provisionSpaceComputer(
  prisma: PrismaClient,
  connectionId: string,
  homeKey: string,
  context: AdapterContext,
  provision: (context: AdapterContext) => Promise<ComputerRef>,
) {
  return runAsSystem("protect an in-flight Space computer provisioning operation", () =>
    withLease(
      prisma,
      computerConnectionProvisionKey(connectionId, homeKey),
      {
        ttlMs: 30_000,
        signal: context.signal,
      },
      async (lease) => {
        const computer = await prisma.computer.findFirst({
          where: {
            homeKey,
            providerConnectionId: connectionId,
            spaceId: context.spaceId,
            space: { deletingAt: null },
          },
          select: { id: true },
        });
        if (!computer)
          throw new ClientError(
            "CONFLICT",
            "Computer is unavailable while its Space is being deleted",
          );
        return provision({ ...context, signal: lease.signal });
      },
    ),
  );
}
