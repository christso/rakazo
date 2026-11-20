import type { JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { queueComputerTeardown, retryComputerTeardown } from "./computer-teardown.js";

it("holds a dedicated computer and retries provider cleanup before dropping its reference", async () => {
  const row = {
    id: "computer",
    providerRef: "vm",
    providerConnectionId: "connection",
    homeKey: "home",
    kind: "cloud",
    userId: "owner",
    spaceId: "space",
  };
  const prisma = {
    computer: {
      findFirst: vi.fn(async () => row),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(prisma),
  };
  const jobs = {
    enqueueIn: vi.fn(async () => undefined),
    enqueue: vi.fn(async () => undefined),
    cancelIn: vi.fn(async () => undefined),
  };
  const sandbox = { destroy: vi.fn(async () => undefined) };
  sandbox.destroy.mockRejectedValueOnce(new Error("provider offline"));
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    jobs: jobs as unknown as JobPublisher,
    sandbox: sandbox as unknown as SandboxProvider,
  };
  await expect(queueComputerTeardown(deps, row.id)).rejects.toThrow("provider offline");
  expect(prisma.computer.updateMany).toHaveBeenCalledTimes(1);
  expect(prisma.computer.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ id: row.id, scope: "dedicated" }),
      data: { maintenanceId: "computer.teardown:computer", state: "quarantined" },
    }),
  );
  expect(jobs.enqueueIn.mock.invocationCallOrder[0]!).toBeLessThan(
    sandbox.destroy.mock.invocationCallOrder[0]!,
  );
  expect(jobs.enqueue).toHaveBeenCalledOnce();
  expect(jobs.cancelIn).not.toHaveBeenCalled();
  await retryComputerTeardown(deps, row.id);
  expect(sandbox.destroy).toHaveBeenLastCalledWith(
    expect.objectContaining({ providerRef: "vm", providerConnectionId: "connection" }),
    expect.objectContaining({ spaceId: "space" }),
  );
  expect(prisma.computer.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ providerRef: "vm" }),
      data: expect.objectContaining({ providerRef: null }),
    }),
  );
  expect(jobs.cancelIn).toHaveBeenCalledOnce();
});
