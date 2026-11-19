import type {
  BackgroundJobAttempt,
  JobPublisher,
  SandboxProvider,
  UnreferencedMachine,
  UnreferencedMachineRecords,
} from "@rakazo/adapter-kit";
import { machineCleanupJob, machineCleanupJobKey, parseBackgroundJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem, withLease } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { computerConnectionProvisionKey } from "./sandbox/space-computer-provision.js";

/** One try's provider budget; the queue's backoff spaces the tries. */
const ATTEMPT_MS = 30_000;
const STARTING = "A start that may keep this machine is still in progress";

/** Keeps each record as its keyed cleanup job, whose payload is the record. */
export function machineCleanupRecords(
  jobs: Pick<JobPublisher, "enqueue" | "cancel">,
  prisma?: PrismaClient,
): UnreferencedMachineRecords {
  return {
    ...(prisma && {
      pendingCreate: (provider, connectionId, homeKey) =>
        pendingCreate(prisma, provider, connectionId, homeKey),
    }),
    record: (machine, deleteAt) => jobs.enqueue(machineCleanupJob(machine, deleteAt)),
    clear: (machine) =>
      jobs.cancel(
        machineCleanupJobKey(machine.provider, machine.machineId, machine.providerConnectionId),
      ),
  };
}

/** The persisted cleanup job is also the receipt for a create the cloud might have accepted. */
async function pendingCreate(
  prisma: PrismaClient,
  provider: string,
  connectionId: string,
  homeKey: string,
) {
  return runAsSystem("read a submitted computer creation", async () => {
    const rows = await prisma.$queryRaw<Array<{ payload: unknown }>>`
      SELECT COALESCE(j.payload::jsonb->'payload', j.payload::jsonb) AS payload
      FROM graphile_worker._private_jobs j
      JOIN graphile_worker._private_tasks t ON t.id = j.task_id
      WHERE t.identifier = 'computer.machine-cleanup'
        AND j.key IS NOT NULL
        AND COALESCE(j.payload->'payload'->>'providerConnectionId', j.payload->>'providerConnectionId') = ${connectionId}
        AND COALESCE(j.payload->'payload'->>'homeKey', j.payload->>'homeKey') = ${homeKey}
        AND COALESCE(j.payload->'payload'->>'provider', j.payload->>'provider') = ${provider}
      LIMIT 2`;
    if (rows.length > 1) throw new Error("Computer creation has multiple receipts");
    if (!rows[0]) return undefined;
    const job = parseBackgroundJob("computer.machine-cleanup", rows[0].payload);
    if (job.name !== "computer.machine-cleanup")
      throw new Error("Invalid computer creation receipt");
    return job.payload;
  });
}

/**
 * The cleanup job, which runs only for a record nothing removed: a start that stores the machine
 * removes its record in that write. It finishes once the machine is gone or a stored computer
 * points at it, and rejects otherwise so the queue tries again; the last try to fail reports the
 * machine.
 */
export async function retryMachineCleanup(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  machine: UnreferencedMachine,
  attempt?: BackgroundJobAttempt,
): Promise<void> {
  try {
    const { providerConnectionId, homeKey } = machine;
    const signal = AbortSignal.timeout(ATTEMPT_MS);
    if (machine.requiresCreateReconciliation && providerConnectionId && homeKey) {
      // A late create can be adopted or deleted, never concurrently. Acquire the same lease
      // around the holder check and provider call that protects a start's reconciliation.
      await runAsSystem("protect connection computer cleanup", () =>
        withLease(
          deps.prisma,
          computerConnectionProvisionKey(providerConnectionId, homeKey),
          { ttlMs: ATTEMPT_MS, signal },
          (lease) => deleteUnlessKept(deps, machine, lease.signal),
        ),
      );
    } else await deleteUnlessKept(deps, machine, signal);
  } catch (error) {
    if (attempt && attempt.number >= attempt.max)
      getLogger().error("sandbox.cleanup_exhausted", error, {
        provider: machine.provider,
        machineId: machine.machineId,
      });
    throw error;
  }
}

async function deleteUnlessKept(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  machine: UnreferencedMachine,
  signal: AbortSignal,
): Promise<void> {
  const { provider, machineId, homeKey } = machine;
  // One read, so it cannot fall between a start storing the machine and leaving "booting":
  // activation does both in a single write. A start's later writes are fenced on its claim, so
  // once its computer has left "booting" without storing the machine it never will. A start that
  // died stays "booting" until the computer is started again, so its machine waits here and the
  // last try reports it.
  const holders = await runAsSystem("check whether a computer keeps a provider machine", () =>
    deps.prisma.computer.findMany({
      where: {
        OR: [
          {
            kind: provider,
            providerRef: machineId,
            ...(machine.providerConnectionId
              ? { providerConnectionId: machine.providerConnectionId }
              : {}),
          },
          ...(homeKey ? [{ homeKey, state: "booting" }] : []),
        ],
      },
      select: { state: true },
    }),
  );
  if (holders.some((holder) => holder.state === "booting")) throw new Error(STARTING);
  if (holders.length > 0) return;
  if (!deps.sandbox.deleteMachine)
    throw new Error("This computer provider cannot delete a machine by its id");
  await deps.sandbox.deleteMachine(machine, signal);
}
