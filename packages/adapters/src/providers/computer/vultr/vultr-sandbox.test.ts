import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, expect, it, vi } from "vitest";
import { emulatedVultr } from "./vultr-sandbox.test-support.js";

vi.mock("../../../network/undici-fetch.js", async (original) => ({
  ...(await original()),
  fetchPairedWithDispatcher: (fetcher?: typeof fetch) => fetcher ?? globalThis.fetch,
}));

afterEach(() => vi.unstubAllGlobals());

const context: AdapterContext = {
  operationId: "operation-a",
  traceId: "trace-a",
  spaceId: "space-a",
  userId: "user-a",
  signal: new AbortController().signal,
};
const request = { botId: "bot-a", homePath: "/unused" };

function setup() {
  const cloud = emulatedVultr();
  vi.stubGlobal("fetch", cloud.fetch);
  const createCount = () =>
    cloud.calls.filter(({ path, method }) => path === "/v2/instances" && method === "POST").length;
  return { cloud, createCount };
}

it("recovers a delayed create by its exact receipt after a provider restart", async () => {
  const { cloud, createCount } = setup();
  const first = await cloud.provider();
  cloud.controls.loseCreateResponse = true;
  cloud.controls.visible = false;
  await expect(first.provision(request, context)).rejects.toThrow("not yet confirmed");
  expect(createCount()).toBe(1);
  expect(cloud.records.due.size).toBe(1);
  const next = await cloud.provider();
  await expect(next.provision(request, context)).rejects.toThrow("not yet confirmed");
  expect(createCount()).toBe(1);

  cloud.controls.visible = true;
  cloud.controls.splitPages = true;
  const instance = [...cloud.instances.values()][0]!;
  // Tags keep the original operation discoverable even after a customer renames its label.
  instance.label = "renamed-instance";
  const computer = await next.provision(request, context);
  expect(computer.kind).toBe("vultr");
  expect(createCount()).toBe(1);
  expect(cloud.records.due.get(computer.providerRef)?.machine.providerResourceId).toBe(instance.id);
  await next.stop(computer, context);
  await expect(next.isStopped?.(computer, context)).resolves.toBe(true);
  const resumed = await next.provision(
    { ...request, providerKind: computer.kind, providerRef: computer.providerRef },
    context,
  );
  expect(resumed).toMatchObject({ providerRef: computer.providerRef, started: true });
  expect(createCount()).toBe(1);
  await next.destroy(computer, context);
  expect(cloud.instances.size).toBe(0);
});

it("releases the receipt after a definitive rejection so a corrected request can start", async () => {
  const { cloud, createCount } = setup();
  cloud.controls.rejectCreate = true;
  const provider = await cloud.provider();
  await expect(provider.provision(request, context)).rejects.toThrow("(400)");
  expect(cloud.records.due.size).toBe(0);
  cloud.controls.rejectCreate = false;
  await provider.provision(request, context);
  expect(createCount()).toBe(2);
  expect(cloud.instances.size).toBe(1);
});

it("retains an invisible orphan and only deletes its exact generation when it appears", async () => {
  const { cloud, createCount } = setup();
  const provider = await cloud.provider();
  cloud.controls.loseCreateResponse = true;
  cloud.controls.visible = false;
  await expect(provider.provision(request, context)).rejects.toThrow("not yet confirmed");
  const receipt = [...cloud.records.due.values()][0]!.machine;
  await expect(provider.deleteMachine?.(receipt, context.signal)).rejects.toThrow(
    "not yet confirmed",
  );
  expect(cloud.calls.some((request) => request.method === "DELETE")).toBe(false);
  expect(cloud.records.due.size).toBe(1);
  cloud.controls.visible = true;
  const instance = [...cloud.instances.values()][0]!;
  const foreign = { ...instance, id: "99999999-9999-4999-8999-999999999999", tags: [] };
  cloud.instances.set(foreign.id, foreign);
  await provider.deleteMachine?.(receipt, context.signal);
  expect(cloud.instances.has(instance.id)).toBe(false);
  expect(cloud.instances.has(foreign.id)).toBe(true);
  expect(createCount()).toBe(1);
});
