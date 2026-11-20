import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { CloudDiskHibernation } from "./cloud-disk-hibernation.js";
import type {
  CloudDiskSnapshot,
  CloudDiskSnapshots,
  CloudMachine,
  CloudMachineClient,
} from "./cloud-runtime-sandbox.js";

type Receipt = Awaited<ReturnType<PrismaClient["computerDiskSnapshot"]["findMany"]>>[number];

const target = {
  home: "home",
  spaceId: "space",
  connectionId: "connection",
  labels: { owner: "home" },
};

function fixture() {
  const receipts = new Map<string, Receipt>();
  const images = new Map<string, CloudDiskSnapshot>();
  const machines = new Map<string, CloudMachine>([
    ["source", { id: "source", status: "running", labels: target.labels }],
  ]);
  const order: string[] = [];
  const store = {
    create: vi.fn(
      async ({ data }: { data: Pick<Receipt, "marker" | "computerId" | "sourceId" | "phase"> }) => {
        const row = {
          snapshotId: null,
          snapshotSeen: false,
          restorePending: false,
          restoreId: null,
          ...data,
        };
        receipts.set(row.marker, row);
        order.push("receipt");
        return row;
      },
    ),
    update: vi.fn(
      async ({ where, data }: { where: { marker: string }; data: Partial<Receipt> }) => {
        const next = { ...receipts.get(where.marker)!, ...data };
        receipts.set(next.marker, next);
        return next;
      },
    ),
    delete: vi.fn(async ({ where }: { where: { marker: string } }) =>
      receipts.delete(where.marker),
    ),
  };
  const db = {
    computerDiskSnapshot: store,
    computer: {
      findFirstOrThrow: vi.fn(async () => ({
        id: "computer",
        diskSnapshots: [...receipts.values()],
      })),
    },
    $executeRaw: vi.fn(async () => 1),
    $transaction: async (run: (connection: unknown) => Promise<unknown>) => run(db),
  };
  const snapshots = {
    create: vi.fn(async (_id, marker) => {
      expect(machines.get("source")?.status).toBe("off");
      images.set("snapshot", { id: "snapshot", marker, status: "ready" });
      order.push("capture");
      return "snapshot";
    }),
    find: vi.fn(
      async (marker) => [...images.values()].find((image) => image.marker === marker) ?? null,
    ),
    get: vi.fn(async (id) => images.get(id) ?? null),
    delete: vi.fn(async (id) => void images.delete(id)),
    createWasRejected: vi.fn(() => false),
  } satisfies CloudDiskSnapshots;
  const client = {
    find: vi.fn(async () => machines.get("source") ?? null),
    findByLabels: vi.fn(
      async (labels) =>
        [...machines.values()].find((machine) =>
          Object.entries(labels).every(([key, value]) => machine.labels[key] === value),
        ) ?? null,
    ),
    get: vi.fn(async (id) => machines.get(String(id)) ?? null),
    create: vi.fn(async ({ labels, snapshotId }) => {
      expect(snapshotId).toBe("snapshot");
      const restored = { id: "restored", status: "running", labels };
      machines.set(restored.id, restored);
      return restored;
    }),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    delete: vi.fn(async (id) => {
      order.push(`delete:${id}`);
      machines.delete(String(id));
    }),
  } satisfies CloudMachineClient;
  const lifecycle = new CloudDiskHibernation(db as unknown as PrismaClient, client, snapshots);
  const signal = new AbortController().signal;
  return {
    db,
    receipts,
    images,
    machines,
    snapshots,
    client,
    lifecycle,
    order,
    signal,
    hibernate: () =>
      lifecycle.hibernate(target, signal, client.find, async () => {
        order.push("stop");
        machines.get("source")!.status = "off";
      }),
  };
}

describe("cloud disk hibernation", () => {
  it("records a ready snapshot before releasing the source and restores the same disk", async () => {
    const f = fixture();
    await f.hibernate();
    expect(f.order).toEqual(["stop", "receipt", "capture", "delete:source"]);
    expect(f.receipts.values().next().value?.phase).toBe("released");
    expect(f.machines.size).toBe(0);

    const restored = await f.lifecycle.wake(target, f.signal);
    expect(restored?.id).toBe("restored");
    expect(f.images.size).toBe(1);
    await f.lifecycle.confirmWake(target, restored!, f.signal);
    expect(f.receipts.values().next().value?.phase).toBe("retired");
    expect(f.images.size).toBe(1);
  });

  it("reconciles a lost snapshot response before issuing any other create", async () => {
    const f = fixture();
    f.snapshots.create.mockImplementationOnce(async (_id, marker) => {
      f.images.set("snapshot", { id: "snapshot", marker, status: "ready" });
      throw new Error("lost response");
    });
    await expect(f.hibernate()).rejects.toThrow("lost response");
    expect(f.machines.has("source")).toBe(true);
    await f.hibernate();
    expect(f.snapshots.create).toHaveBeenCalledTimes(1);
    expect(f.machines.has("source")).toBe(false);
  });

  it("keeps the stopped source when the provider reports a failed snapshot", async () => {
    const f = fixture();
    f.snapshots.create.mockImplementationOnce(async (_id, marker) => {
      f.images.set("snapshot", { id: "snapshot", marker, status: "failed" });
      return "snapshot";
    });
    await expect(f.hibernate()).rejects.toThrow("Cloud disk snapshot failed");
    expect(f.machines.get("source")?.status).toBe("off");
    expect(f.client.delete).not.toHaveBeenCalled();
    expect(f.receipts.size).toBe(0);
  });

  it("can resume the source of an incomplete snapshot without promoting an older disk", async () => {
    const f = fixture();
    f.snapshots.create.mockRejectedValueOnce(new Error("unknown outcome"));
    await expect(f.hibernate()).rejects.toThrow("unknown outcome");
    expect(await f.lifecycle.wake(target, f.signal)).toBeUndefined();
    expect(f.receipts.values().next().value?.phase).toBe("retired");
    expect(f.machines.has("source")).toBe(true);
    expect(f.client.create).not.toHaveBeenCalled();
  });

  it("keeps the recovery copy when restore fails and adopts a late matching VM", async () => {
    const f = fixture();
    await f.hibernate();
    f.client.create.mockImplementationOnce(async ({ labels }) => {
      f.machines.set("late", { id: "late", labels, status: "running" });
      throw new Error("lost restore response");
    });
    await expect(f.lifecycle.wake(target, f.signal)).rejects.toThrow("lost restore response");
    expect(f.images.size).toBe(1);
    expect((await f.lifecycle.wake(target, f.signal))?.id).toBe("late");
    expect(f.client.create).toHaveBeenCalledTimes(1);
  });

  it("keeps cleanup discoverable across a failed snapshot delete and leaves foreign images alone", async () => {
    const f = fixture();
    await f.hibernate();
    f.images.set("other", { id: "other", marker: "foreign", status: "ready" });
    f.snapshots.delete.mockRejectedValueOnce(new Error("provider outage"));
    await expect(f.lifecycle.destroy(target, f.signal)).rejects.toThrow("provider outage");
    expect(f.receipts.size).toBe(1);
    await f.lifecycle.destroy(target, f.signal);
    expect(f.receipts.size).toBe(0);
    expect([...f.images.keys()]).toEqual(["other"]);
  });
});
