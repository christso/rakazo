import { randomUUID } from "node:crypto";
import { deadlineSignal, pollUntil } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import type {
  CloudDiskSnapshots,
  CloudMachine,
  CloudMachineClient,
} from "./cloud-runtime-sandbox.js";

type Receipt = Awaited<ReturnType<PrismaClient["computerDiskSnapshot"]["findMany"]>>[number];
type Target = {
  home: string;
  spaceId: string;
  connectionId: string;
  labels: Record<string, string>;
};

const SNAPSHOT_SLICE_MS = 90_000;

/** All callers hold the connection's per-home provider lease. */
export class CloudDiskHibernation {
  constructor(
    private readonly db: PrismaClient,
    private readonly client: CloudMachineClient,
    private readonly snapshots: CloudDiskSnapshots,
  ) {}

  private async receipts(target: Target) {
    const computer = await this.db.computer.findFirstOrThrow({
      where: {
        homeKey: target.home,
        spaceId: target.spaceId,
        providerConnectionId: target.connectionId,
      },
      select: { id: true, diskSnapshots: true },
    });
    const active = computer.diskSnapshots.filter((receipt) => receipt.phase !== "retired");
    if (active.length > 1) throw new Error("Cloud computer has multiple active snapshots");
    return { ...computer, active: active[0] };
  }

  async hibernate(
    target: Target,
    parent: AbortSignal,
    findSource: (signal: AbortSignal) => Promise<CloudMachine | null>,
    stopSource: (signal: AbortSignal) => Promise<void>,
  ) {
    return runAsSystem("hibernate an owned cloud computer", async () => {
      const signal = deadlineSignal(SNAPSHOT_SLICE_MS, parent);
      const { id: computerId, active, diskSnapshots } = await this.receipts(target);
      if (active?.phase === "released" || active?.phase === "releasing") {
        if (active.restorePending) throw new Error("A cloud disk restore is still pending");
        if (active.phase === "releasing") await this.release(active, target, signal);
        for (const old of diskSnapshots)
          if (old.phase === "retired") await this.removeSnapshot(old, signal);
        return;
      }
      const machine = await findSource(signal);
      if (!machine) throw new Error("Cloud computer disappeared before its disk was saved");
      const sourceId = String(machine.id);
      if (active && active.sourceId !== sourceId) throw new Error("Cloud snapshot source changed");
      let receipt = active;
      if (machine.status !== "off") {
        // A running VM could have changed since this attempt started.
        if (receipt) await this.retire(receipt);
        receipt = undefined;
        await stopSource(signal);
      }
      signal.throwIfAborted();
      if (!receipt) {
        receipt = await this.db.$transaction(async (tx) => {
          // Preserve the existing lifecycle claim's updatedAt stamp.
          await tx.$executeRaw`UPDATE computers SET "hibernationProtected" = true WHERE id = ${computerId}`;
          return tx.computerDiskSnapshot.create({
            data: { marker: `rakazo-${randomUUID()}`, computerId, sourceId, phase: "capturing" },
          });
        });
        try {
          const snapshotId = await this.snapshots.create(machine.id, receipt.marker, signal);
          signal.throwIfAborted();
          receipt = await this.db.computerDiskSnapshot.update({
            where: { marker: receipt.marker },
            data: { snapshotId },
          });
        } catch (error) {
          if (this.snapshots.createWasRejected(error))
            await this.db.computerDiskSnapshot.delete({ where: { marker: receipt.marker } });
          throw error;
        }
      }
      const capturing = receipt;
      const snapshot = await pollUntil(
        async () => {
          const current = await this.snapshot(capturing, signal);
          if (current?.status === "failed") {
            await this.removeSnapshot(capturing, signal);
            throw new Error("Cloud disk snapshot failed");
          }
          return current?.status === "ready" && current;
        },
        {
          intervalMs: 2_000,
          timeoutMs: SNAPSHOT_SLICE_MS,
          signal,
          waitingFor: "cloud disk snapshot",
        },
      );
      signal.throwIfAborted();
      receipt = await this.db.computerDiskSnapshot.update({
        where: { marker: receipt.marker },
        data: { snapshotId: snapshot.id, snapshotSeen: true, phase: "releasing" },
      });
      await this.release(receipt, target, signal);
      for (const old of diskSnapshots)
        if (old.phase === "retired") await this.removeSnapshot(old, signal);
    });
  }

  isReleased(target: Target) {
    return runAsSystem("check a hibernated cloud disk", async () => {
      const { active } = await this.receipts(target);
      return active?.phase === "released" || active?.phase === "releasing";
    });
  }

  async wake(target: Target, signal: AbortSignal): Promise<CloudMachine | undefined> {
    return runAsSystem("restore an owned cloud computer", async () => {
      const { active: receipt } = await this.receipts(target);
      if (!receipt) return;
      if (receipt.phase === "capturing") {
        // The request to release was never committed. Resume the authoritative source disk.
        await this.retire(receipt);
        return;
      }
      if (receipt.phase === "releasing") await this.release(receipt, target, signal);
      const snapshot = await this.snapshot(receipt, signal);
      if (snapshot?.status !== "ready")
        throw new Error("Cloud computer's saved disk is unavailable");
      const labels = { ...target.labels, "rakazo-resume": receipt.marker };
      const restored = receipt.restoreId
        ? await this.client.get(receipt.restoreId, signal)
        : await this.client.findByLabels(labels, signal);
      if (restored) {
        if (!Object.entries(labels).every(([key, value]) => restored.labels[key] === value))
          throw new Error("Cloud computer restore ownership mismatch");
        return restored;
      }
      if (receipt.restorePending)
        throw new Error("The submitted cloud disk restore is not yet confirmed");
      signal.throwIfAborted();
      await this.db.computerDiskSnapshot.update({
        where: { marker: receipt.marker },
        data: { restorePending: true },
      });
      try {
        const machine = await this.client.create(
          { name: receipt.marker, labels, snapshotId: snapshot.id },
          signal,
        );
        signal.throwIfAborted();
        await this.db.computerDiskSnapshot.update({
          where: { marker: receipt.marker },
          data: { restoreId: String(machine.id) },
        });
        return machine;
      } catch (error) {
        if (this.client.createWasRejected?.(error) || this.snapshots.createWasRejected(error))
          await this.db.computerDiskSnapshot.update({
            where: { marker: receipt.marker },
            data: { restorePending: false },
          });
        throw error;
      }
    });
  }

  async confirmWake(target: Target, machine: CloudMachine, signal: AbortSignal) {
    return runAsSystem("confirm a restored cloud computer", async () => {
      const { active } = await this.receipts(target);
      if (active?.phase === "released" && machine.labels["rakazo-resume"] === active.marker) {
        signal.throwIfAborted();
        // Keep this recovery point until a later operation can retire it.
        await this.retire(active);
      }
    });
  }

  async destroy(target: Target, signal: AbortSignal) {
    return runAsSystem("remove an owned computer's snapshots", async () => {
      const { diskSnapshots } = await this.receipts(target);
      for (const receipt of diskSnapshots) {
        if (receipt.restorePending && receipt.phase !== "retired") {
          const restoreTarget = {
            ...target,
            labels: { ...target.labels, "rakazo-resume": receipt.marker },
          };
          const restoreId =
            receipt.restoreId ??
            String((await this.client.findByLabels(restoreTarget.labels, signal))?.id ?? "");
          if (!restoreId) throw new Error("The submitted cloud disk restore is not yet confirmed");
          await this.db.computerDiskSnapshot.update({
            where: { marker: receipt.marker },
            data: { restoreId },
          });
          await this.deleteMachine(restoreId, restoreTarget, signal);
          await this.db.computerDiskSnapshot.update({
            where: { marker: receipt.marker },
            data: { restorePending: false },
          });
        }
        await this.removeSnapshot(receipt, signal);
      }
    });
  }

  private retire(receipt: Receipt) {
    return this.db.computerDiskSnapshot.update({
      where: { marker: receipt.marker },
      data: { phase: "retired" },
    });
  }

  private async release(receipt: Receipt, target: Target, signal: AbortSignal) {
    const snapshot = await this.snapshot(receipt, signal);
    if (snapshot?.status !== "ready") throw new Error("Cloud disk snapshot is unavailable");
    await this.deleteMachine(receipt.sourceId, target, signal, { stopped: true });
    signal.throwIfAborted();
    await this.db.computerDiskSnapshot.update({
      where: { marker: receipt.marker },
      data: { phase: "released" },
    });
  }

  private async deleteMachine(
    id: CloudMachine["id"],
    target: Target,
    signal: AbortSignal,
    options?: { stopped: true },
  ) {
    const original = await this.client.get(id, signal);
    if (!original) return;
    if (!Object.entries(target.labels).every(([key, value]) => original.labels[key] === value))
      throw new Error("Cloud computer ownership mismatch");
    if (options?.stopped && original.status !== "off")
      throw new Error("Cloud computer resumed before its saved disk could be released");
    signal.throwIfAborted();
    await this.client.delete(id, signal);
    await pollUntil(async () => (await this.client.get(id, signal)) === null, {
      intervalMs: 1_000,
      timeoutMs: 60_000,
      signal,
      waitingFor: "cloud computer deletion",
    });
  }

  private async snapshot(receipt: Receipt, signal: AbortSignal) {
    const snapshot = receipt.snapshotId
      ? await this.snapshots.get(receipt.snapshotId, signal)
      : await this.snapshots.find(receipt.marker, signal);
    if (snapshot && snapshot.marker !== receipt.marker)
      throw new Error("Cloud disk snapshot ownership mismatch");
    return snapshot;
  }

  private async removeSnapshot(receipt: Receipt, signal: AbortSignal) {
    const snapshot = await this.snapshot(receipt, signal);
    // Without a provider ID an interrupted create can still become visible. Keep its receipt.
    if (!snapshot && !receipt.snapshotSeen)
      throw new Error("The submitted cloud disk snapshot is not yet confirmed");
    if (snapshot) {
      await this.db.computerDiskSnapshot.update({
        where: { marker: receipt.marker },
        data: { snapshotId: snapshot.id, snapshotSeen: true },
      });
      await this.snapshots.delete(snapshot.id, signal);
      await pollUntil(async () => (await this.snapshots.get(snapshot.id, signal)) === null, {
        intervalMs: 1_000,
        timeoutMs: 60_000,
        signal,
        waitingFor: "cloud disk snapshot deletion",
      });
    }
    signal.throwIfAborted();
    await this.db.computerDiskSnapshot.delete({ where: { marker: receipt.marker } });
  }
}
