import type {
  AdapterContext,
  UnreferencedMachine,
  UnreferencedMachineRecords,
} from "@rakazo/adapter-kit";
import { deferred, flush } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, expect, it, vi } from "vitest";
import { retryMachineCleanup } from "../../../computers/machine-cleanup.js";
import { MachineRecords } from "../../../computers/sandbox/sandbox-test-support.js";
import { HetznerSandboxProvider } from "./hetzner-sandbox.js";
import { emulatedHetzner } from "./hetzner-sandbox.test-support.js";

const context: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};
const settings = {
  apiToken: "test-cloud-key",
  runtimeSecret: "test-runtime-secret",
  connectionIdentity: "connection-a",
  location: "fsn1",
  serverType: "cx23",
  appImage: `registry.example.test/app@sha256:${"a".repeat(64)}`,
  computerImage: `registry.example.test/computer@sha256:${"b".repeat(64)}`,
};
afterEach(() => vi.unstubAllGlobals());

it("rejects unexpected fixture requests without falling through to the network", async () => {
  const network = vi.fn().mockRejectedValue(new Error("Network must not be reached"));
  vi.stubGlobal("fetch", network);
  const fake = emulatedHetzner();
  await expect(fake.fetch("https://unconfigured.example.test/")).rejects.toThrow(
    "Unexpected cloud fixture request",
  );
  await expect(
    fake.fetch("https://api.hetzner.cloud/v1/servers", {
      headers: { authorization: "Bearer wrong-fixture-token" },
    }),
  ).rejects.toThrow("Unexpected cloud fixture request");
  expect(network).not.toHaveBeenCalled();
});

it("removes the abandoned VM after provisioning fails before activation", async () => {
  const fake = emulatedHetzner();
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/computers") && init?.method === "POST")
      return new Response("Runtime refused provisioning", { status: 500 });
    return fake.fetch(input, init);
  });
  const records = new MachineRecords();
  const provider = new HetznerSandboxProvider(fake.settings, records);
  await expect(
    provider.provision({ botId: "bot-a", homePath: "/unused" }, context),
  ).rejects.toThrow();
  expect(fake.servers.size).toBe(1);
  expect(records.due.size).toBe(1);
  const machine = records.due.values().next().value!.machine;
  const prisma = {
    computer: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaClient;
  await retryMachineCleanup({ prisma, sandbox: provider }, machine);
  expect(fake.servers.size).toBe(0);
});

it("requires a cleanup store before creating a cloud computer", async () => {
  const fake = emulatedHetzner();
  vi.stubGlobal("fetch", fake.fetch);
  await expect(
    new HetznerSandboxProvider(fake.settings).provision(
      { botId: "bot-a", homePath: "/unused" },
      context,
    ),
  ).rejects.toThrow("requires durable machine cleanup");
  expect(fake.servers.size).toBe(0);
});

it("creates no billable VM when its durable cleanup record cannot be saved", async () => {
  const fake = emulatedHetzner();
  vi.stubGlobal("fetch", fake.fetch);
  const records = {
    record: vi.fn().mockRejectedValue(new Error("Cleanup store unavailable")),
    clear: vi.fn().mockResolvedValue(undefined),
  };
  const provider = new HetznerSandboxProvider(fake.settings, records);
  await expect(
    provider.provision({ botId: "bot-a", homePath: "/unused" }, context),
  ).rejects.toThrow("Cleanup store unavailable");
  expect(fake.servers.size).toBe(0);
  expect(
    fake.calls.some(({ url, init }) => url.endsWith("/servers") && init?.method === "POST"),
  ).toBe(false);
});

it("creates and bootstraps a desktop, resumes its disk, and destroys only its own server", async () => {
  let server: Record<string, unknown> | undefined;
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.includes("api.hetzner.cloud")) {
        if (init?.method === "POST" && url.endsWith("/servers")) {
          server = {
            id: 123,
            name: body.name,
            labels: body.labels,
            status: "running",
            public_net: { ipv4: { ip: "93.184.216.34" } },
          };
          return Response.json({ server });
        }
        if (url.includes("/servers?")) return Response.json({ servers: server ? [server] : [] });
        if (init?.method === "DELETE") {
          server = undefined;
          return Response.json({});
        }
        if (url.endsWith("/actions/shutdown")) {
          server!.status = "off";
          return Response.json({ action: { id: 1 } });
        }
        if (url.endsWith("/actions/poweron")) {
          server!.status = "running";
          return Response.json({ action: { id: 2 } });
        }
        return Response.json({ server });
      }
      if (url.endsWith("/health")) return Response.json({ ok: true });
      if (url.endsWith("/computers") && init?.method === "POST")
        return Response.json({ id: "container-a", resumed: true });
      if (url.endsWith("/screen-mode"))
        return Response.json({ screenUrl: "http://127.0.0.1:32123/embed.html?token=screen-token" });
      if (url.endsWith("/exec"))
        return Response.json({ stdout: "desktop-ready", stderr: "", code: 0 });
      return Response.json({ running: true });
    }),
  );
  const provider = new HetznerSandboxProvider(settings, new MachineRecords());
  const computer = await provider.provision({ botId: "bot-a", homePath: "/local/home" }, context);
  const create = calls.find(
    ({ url, init }) => url.endsWith("/servers") && init?.method === "POST",
  )!;
  const request = JSON.parse(String(create.init!.body));
  expect(request).toMatchObject({ image: "debian-12", location: "fsn1", server_type: "cx23" });
  const cloudInit = JSON.parse(request.user_data.split("\n")[1]);
  const bootstrap = cloudInit.write_files
    .map((file: { content: string }) => Buffer.from(file.content, "base64").toString())
    .join("\n");
  expect(bootstrap).toContain(settings.appImage);
  expect(bootstrap).toContain(settings.computerImage);
  expect(bootstrap).toContain("nginx");
  expect(request.user_data).not.toContain(settings.apiToken);
  expect(Buffer.byteLength(request.user_data)).toBeLessThan(32768);
  expect(computer.providerRef).not.toContain(settings.runtimeSecret);
  await provider.prepare(computer, context);
  const events = [];
  for await (const event of provider.execute(
    computer,
    { argv: ["echo", "desktop-ready"] },
    context,
  ))
    events.push(event);
  expect(events).toContainEqual({ type: "stdout", data: "desktop-ready" });
  const screen = await provider.connectScreen(computer, { view: "stream" }, context);
  expect(screen.url).toBe("https://93.184.216.34/desktop/32123/embed.html?token=screen-token");
  expect(screen.headers?.authorization).toMatch(/^Bearer /);
  expect(screen.tlsCertificateSha256).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await provider.stop(computer, context);
  expect(server!.status).toBe("off");
  expect(calls.filter(({ init }) => init?.method === "DELETE")).toHaveLength(0);
  const resumed = await provider.provision(
    {
      botId: "bot-a",
      homePath: "/local/home",
      providerKind: computer.kind,
      providerRef: computer.providerRef,
    },
    context,
  );
  expect(resumed.fresh).toBe(false);
  expect(
    calls.filter(({ url, init }) => url.endsWith("/servers") && init?.method === "POST"),
  ).toHaveLength(1);
  server!.labels = {
    ...(server!.labels as Record<string, string>),
    "rakazo-home": "different-owner",
  };
  await expect(provider.destroy(computer, context)).rejects.toThrow(/ownership/);
  expect(calls.filter(({ init }) => init?.method === "DELETE")).toHaveLength(0);
});

it("reconciles a lost create response and a restarted process without another VM", async () => {
  const fake = emulatedHetzner();
  let loseResponse = true;
  vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
    const response = await fake.fetch(...args);
    if (String(args[0]).endsWith("/servers") && args[1]?.method === "POST" && loseResponse) {
      loseResponse = false;
      throw new TypeError("connection closed before the create response arrived");
    }
    return response;
  });
  const first = await fake.provider().provision({ botId: "bot-a", homePath: "/unused" }, context);
  const second = await fake.provider().provision(
    {
      botId: "bot-a",
      homePath: "/unused",
      providerKind: first.kind,
      providerRef: first.providerRef,
    },
    context,
  );
  expect(second.providerRef).toBe(first.providerRef);
  expect(second.fresh).toBe(false);
  expect(fake.servers.size).toBe(1);
  expect(
    fake.calls.filter(({ url, init }) => url.endsWith("/servers") && init?.method === "POST"),
  ).toHaveLength(1);
});

it("keeps files and browser profiles on a stopped disk and exposes the usual file and terminal transport", async () => {
  const fake = emulatedHetzner();
  vi.stubGlobal("fetch", fake.fetch);
  const provider = fake.provider();
  const first = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
  const path = ".browser-profiles/profile/state.json";
  const content = new TextEncoder().encode("retained browser state");
  await provider.writeFile(first, { path, content }, context);
  await provider.stop(first, context);
  expect(await provider.isStopped(first, context)).toBe(true);
  expect(provider.billsWhileRunning()).toBe(true);
  expect(await provider.keepsHome()).toBe(true);
  const resumed = await fake.provider().provision(
    {
      botId: "bot-a",
      homePath: "/unused",
      providerKind: first.kind,
      providerRef: first.providerRef,
    },
    context,
  );
  expect(await provider.readFile(resumed, path, context)).toEqual(content);
  const terminal = await provider.connectTerminal(
    resumed,
    { controlToken: "human-control" },
    context,
  );
  expect(terminal.url).toBe(
    "https://93.184.216.34/desktop/32124/terminal.html?token=terminal-token",
  );
  expect(terminal.headers?.authorization).toMatch(/^Bearer /);
  expect(terminal.tlsCertificateSha256).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await provider.destroy(resumed, context);
  expect(fake.servers.size).toBe(0);
});

it("refuses references from another connection or Space before touching that machine", async () => {
  const fake = emulatedHetzner();
  vi.stubGlobal("fetch", fake.fetch);
  const provider = fake.provider();
  const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
  const other = new HetznerSandboxProvider({
    ...fake.settings,
    connectionIdentity: "another-connection",
  });
  const count = fake.calls.length;
  expect(other.ownsReference(computer)).toBe(false);
  await expect(other.destroy(computer, context)).rejects.toThrow(/ownership/);
  await expect(provider.stop(computer, { ...context, spaceId: "another-space" })).rejects.toThrow(
    /ownership/,
  );
  expect(fake.calls).toHaveLength(count);
});

it("reports a vanished recorded VM without provisioning an empty replacement", async () => {
  const fake = emulatedHetzner();
  vi.stubGlobal("fetch", fake.fetch);
  const provider = fake.provider();
  const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
  fake.servers.clear();
  const creates = fake.calls.filter(
    ({ init, url }) => init?.method === "POST" && url.endsWith("/servers"),
  ).length;
  await expect(
    provider.provision(
      {
        botId: "bot-a",
        homePath: "/unused",
        providerKind: computer.kind,
        providerRef: computer.providerRef,
      },
      context,
    ),
  ).rejects.toThrow(/no longer exists/);
  expect(
    fake.calls.filter(({ init, url }) => init?.method === "POST" && url.endsWith("/servers")),
  ).toHaveLength(creates);
});

it("does not schedule deletion of a persistent VM that a stored computer already owns", async () => {
  const fake = emulatedHetzner();
  vi.stubGlobal("fetch", fake.fetch);
  const computer = await fake
    .provider()
    .provision({ botId: "bot-a", homePath: "/unused" }, context);
  const records = new MachineRecords();
  const provider = new HetznerSandboxProvider(fake.settings, records);
  await provider.provision(
    {
      botId: "bot-a",
      homePath: "/unused",
      providerKind: computer.kind,
      providerRef: computer.providerRef,
    },
    context,
  );
  expect(records.due.size).toBe(0);
});

it("retains an activated VM when cancelling its provisional cleanup fails", async () => {
  const fake = emulatedHetzner();
  vi.stubGlobal("fetch", fake.fetch);
  const outstanding = new Map<string, UnreferencedMachine>();
  const records: UnreferencedMachineRecords = {
    record: async (machine) => {
      outstanding.set(machine.machineId, machine);
    },
    clear: async () => {
      throw new Error("cleanup cancellation unavailable");
    },
  };
  const provider = new HetznerSandboxProvider(fake.settings, records);
  const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
  await expect(records.clear(outstanding.values().next().value!)).rejects.toThrow(
    "cleanup cancellation unavailable",
  );
  const row = {
    homeKey: computer.botId,
    kind: computer.kind,
    providerRef: computer.providerRef,
    providerConnectionId: fake.settings.connectionIdentity,
    state: "running",
  };
  const prisma = {
    computer: {
      findMany: async ({ where }: { where: { OR: Record<string, unknown>[] } }) =>
        where.OR.some((filter) =>
          Object.entries(filter).every(([key, value]) => row[key as keyof typeof row] === value),
        )
          ? [row]
          : [],
    },
  } as unknown as PrismaClient;
  for (const machine of outstanding.values())
    await retryMachineCleanup({ prisma, sandbox: provider }, machine);
  expect(fake.servers.size).toBe(1);
  expect(fake.calls.some(({ init }) => init?.method === "DELETE")).toBe(false);
  // The same home retaining another generation must not protect this unreferenced VM.
  row.providerRef = "another-generation";
  for (const machine of outstanding.values())
    await retryMachineCleanup({ prisma, sandbox: provider }, machine);
  expect(fake.servers.size).toBe(0);
});

it.each(["destroy", "deleteMachine"] as const)(
  "confirms server disappearance after %s before returning success",
  async (operation) => {
    const fake = emulatedHetzner();
    vi.stubGlobal("fetch", fake.fetch);
    const provider = fake.provider();
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    const absent = deferred<Response>();
    let requested = false;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      if (args[1]?.method === "DELETE") {
        requested = true;
        return Response.json({ action: { id: 1 } });
      }
      if (requested && /api\.hetzner\.cloud\/v1\/servers\/\d+$/.test(String(args[0])))
        return absent.promise;
      return fake.fetch(...args);
    });
    let completed = false;
    const work = (
      operation === "destroy"
        ? provider.destroy(computer, context)
        : provider.deleteMachine(
            {
              provider: computer.kind,
              machineId: computer.providerRef,
              homeKey: computer.botId,
              providerConnectionId: fake.settings.connectionIdentity,
            },
            context.signal,
          )
    ).then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(requested).toBe(true));
    await flush();
    expect(completed).toBe(false);
    absent.resolve(Response.json({}, { status: 404 }));
    await work;
    expect(completed).toBe(true);
  },
);

it("confirms the old server is gone when its name is reused without deleting the replacement", async () => {
  const fake = emulatedHetzner();
  vi.stubGlobal("fetch", fake.fetch);
  const provider = fake.provider();
  const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
  const original = [...fake.servers.values()][0]!;
  const deletes: string[] = [];
  vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
    if (args[1]?.method === "DELETE") {
      deletes.push(String(args[0]));
      fake.servers.set(original.name, {
        ...original,
        id: original.id + 100,
        labels: { ...original.labels, "rakazo-cert": "replacement-certificate-generation" },
      });
      return Response.json({ action: { id: 1 } });
    }
    return fake.fetch(...args);
  });
  await provider.destroy(computer, context);
  expect(deletes).toEqual([`https://api.hetzner.cloud/v1/servers/${original.id}`]);
  expect(fake.servers.get(original.name)?.id).toBe(original.id + 100);
});

it("finds and deletes the same generation after a cloud-console rename", async () => {
  const fake = emulatedHetzner();
  vi.stubGlobal("fetch", fake.fetch);
  const provider = fake.provider();
  const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
  const server = [...fake.servers.values()][0]!;
  fake.servers.delete(server.name);
  server.name = "operator-renamed-computer";
  fake.servers.set(server.name, server);
  expect(await provider.isRunning(computer, context)).toBe(true);
  const resumed = await provider.provision(
    {
      botId: "bot-a",
      homePath: "/unused",
      providerKind: computer.kind,
      providerRef: computer.providerRef,
    },
    context,
  );
  expect(resumed.providerRef).toBe(computer.providerRef);
  const reconciled = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
  expect(reconciled.providerRef).toBe(computer.providerRef);
  expect(
    fake.calls.filter(({ url, init }) => init?.method === "POST" && url.endsWith("/servers")),
  ).toHaveLength(1);
  await provider.destroy(computer, context);
  expect(fake.servers.size).toBe(0);
  expect(
    fake.calls.some(
      ({ url, init }) => init?.method === "DELETE" && url.endsWith(`/servers/${server.id}`),
    ),
  ).toBe(true);
});

it("finishes stale cleanup without deleting a replacement that reused the name", async () => {
  const fake = emulatedHetzner();
  vi.stubGlobal("fetch", fake.fetch);
  const records = new MachineRecords();
  const provider = new HetznerSandboxProvider(fake.settings, records);
  const original = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
  const oldMachine = records.due.values().next().value!.machine;
  await provider.destroy(original, context);
  const replacement = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
  expect(replacement.providerRef).not.toBe(original.providerRef);
  const server = [...fake.servers.values()][0]!;
  const deletesBefore = fake.calls.filter(({ init }) => init?.method === "DELETE").length;
  const prisma = {
    computer: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaClient;
  await retryMachineCleanup({ prisma, sandbox: provider }, oldMachine);
  expect(fake.servers.get(server.name)?.id).toBe(server.id);
  expect(fake.calls.filter(({ init }) => init?.method === "DELETE")).toHaveLength(deletesBefore);
});
