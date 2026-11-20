import type { BackgroundJob, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import { MACHINE_CLEANUP_MAX_ATTEMPTS } from "@rakazo/adapter-kit";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { toComputerRef } from "./screens/computer-support.js";

type Deps = {
  prisma: PrismaClient;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
};

const ATTEMPT_MS = 90_000;
const key = (computerId: string) => `computer.teardown:${computerId}`;

export async function queueComputerTeardown(deps: Deps, computerId: string) {
  const replaceKey = key(computerId);
  const backup: BackgroundJob = {
    name: "computer.teardown",
    payload: { computerId },
    replaceKey,
    availableAt: new Date(Date.now() + ATTEMPT_MS + 15_000),
    maxAttempts: MACHINE_CLEANUP_MAX_ATTEMPTS,
  };
  await deps.prisma.$transaction(async (tx) => {
    const claimed = await tx.computer.updateMany({
      where: {
        id: computerId,
        scope: "dedicated",
        OR: [{ maintenanceId: null }, { maintenanceId: replaceKey }],
      },
      data: { maintenanceId: replaceKey, state: "quarantined" },
    });
    if (!claimed.count) {
      if (!(await tx.computer.findUnique({ where: { id: computerId }, select: { id: true } })))
        return;
      throw new ClientError("CONFLICT", "Wait for computer maintenance to finish before deleting");
    }
    await deps.jobs.enqueueIn(tx, backup);
  });
  try {
    await retryComputerTeardown(deps, computerId);
  } catch (error) {
    await bestEffort(
      "expedite provider cleanup after bot deletion",
      deps.jobs.enqueue({ ...backup, availableAt: new Date() }),
    );
    throw error;
  }
}

export async function retryComputerTeardown(deps: Deps, computerId: string) {
  await runAsSystem("finish a dedicated computer teardown recorded by bot deletion", async () => {
    const maintenanceId = key(computerId);
    const computer = await deps.prisma.computer.findFirst({
      where: { id: computerId, maintenanceId, scope: "dedicated" },
    });
    if (!computer?.providerRef) return;
    await deps.sandbox.destroy(toComputerRef(computer), {
      operationId: maintenanceId,
      traceId: "computer.teardown",
      userId: computer.userId,
      spaceId: computer.spaceId,
      signal: AbortSignal.timeout(ATTEMPT_MS),
    });
    await deps.prisma.$transaction(async (tx) => {
      await tx.computer.updateMany({
        where: { id: computerId, maintenanceId, providerRef: computer.providerRef },
        data: { providerRef: null, runningSince: null, screenUrl: null },
      });
      await deps.jobs.cancelIn(tx, maintenanceId);
    });
  });
}
