import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { FakeSandboxProvider } from "../../providers/computer/fake/fake-sandbox.js";
import type { StoredComputerSettings } from "./configured-sandbox.js";
import { ConfiguredSandbox } from "./configured-sandbox.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "space-a",
  userId: "owner",
  signal: new AbortController().signal,
};

describe("durable computer connections", () => {
  function fixture() {
    let selected = "connection-a";
    const connections = new Map<string, StoredComputerSettings>(
      ["connection-a", "connection-b"].map((id) => [
        id,
        {
          connectionId: id,
          provider: "remote",
          values: { endpoint: id },
        },
      ]),
    );
    const calls: string[] = [];
    const loadConnection = vi.fn(async (id: string) => {
      const found = connections.get(id);
      if (!found) throw new Error("Computer connection unavailable");
      return found;
    });
    const sandbox = new ConfiguredSandbox(
      new FakeSandboxProvider(),
      async () => ({ provider: "default", settings: null }),
      {
        loadOwn: async () => connections.get(selected)!,
        loadConnection,
        createProvider: async (settings) =>
          Object.assign(new FakeSandboxProvider(), {
            describe: () => ({ id: "remote", displayName: "Remote", capabilities: {} }),
            provision: async () => ({
              id: "same-id",
              botId: "home",
              kind: "remote",
              providerRef: "same-id",
            }),
            execute: async function* () {
              calls.push(`${settings.connectionId}:execute`);
              yield { type: "exit" as const, code: 0 };
            },
            connectScreen: async () => {
              calls.push(`${settings.connectionId}:screen`);
              return { url: "https://example.invalid" };
            },
            stop: async () => {
              calls.push(`${settings.connectionId}:stop`);
            },
            destroy: async () => {
              calls.push(`${settings.connectionId}:destroy`);
            },
          }),
      },
    );
    return {
      sandbox,
      calls,
      loadConnection,
      connections,
      select: (id: string) => {
        selected = id;
      },
    };
  }

  it("keeps command, screen, stop, delete and restart on the original same-provider connection", async () => {
    const f = fixture();
    const original = await f.sandbox.provision({ botId: "home", homePath: "/home" }, context);
    expect(original.providerConnectionId).toBe("connection-a");
    f.select("connection-b");
    await f.sandbox.refresh();
    const other = await f.sandbox.provision({ botId: "other", homePath: "/home" }, context);
    expect(other.providerConnectionId).toBe("connection-b");
    for await (const _event of f.sandbox.execute(original, { argv: ["true"] }, context)) {
    }
    await f.sandbox.connectScreen(original, { view: "stream" }, context);
    await f.sandbox.stop(original, context);
    await f.sandbox.destroy(original, context);
    const restarted = await f.sandbox.provision(
      {
        botId: "home",
        homePath: "/home",
        providerRef: original.providerRef,
        providerKind: original.kind,
        providerConnectionId: original.providerConnectionId,
      },
      context,
    );
    expect(restarted.providerConnectionId).toBe("connection-a");
    expect(f.calls).toEqual([
      "connection-a:execute",
      "connection-a:screen",
      "connection-a:stop",
      "connection-a:destroy",
    ]);
  });

  it("fails closed when a bound connection is missing", async () => {
    const f = fixture();
    const computer: ComputerRef = {
      id: "same-id",
      botId: "home",
      kind: "remote",
      providerRef: "same-id",
      providerConnectionId: "missing",
    };
    await expect(f.sandbox.stop(computer, context)).rejects.toThrow(
      "Computer connection unavailable",
    );
    await expect(
      f.sandbox.provision(
        { botId: "home", homePath: "/home", providerConnectionId: "missing" },
        context,
      ),
    ).rejects.toThrow("Computer connection unavailable");
    expect(f.calls).toEqual([]);
  });
});
