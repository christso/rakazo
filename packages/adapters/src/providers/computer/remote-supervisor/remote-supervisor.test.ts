import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, expect, it, vi } from "vitest";
import { RemoteSupervisorSandboxProvider } from "./remote-supervisor.js";
import { emulatedRemoteRuntime } from "./remote-supervisor.test-support.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "space-a",
  userId: "owner",
  signal: new AbortController().signal,
};
afterEach(() => vi.unstubAllEnvs());

it("uses an existing host for normal shell, files, headed screen and terminal without a cloud API", async () => {
  const host = emulatedRemoteRuntime();
  const provider = host.provider();
  const computer = await provider.provision({ botId: "bot-a", homePath: "/local-only" }, context);
  await provider.prepare(computer, context);
  const events = [];
  for await (const event of provider.execute(computer, { argv: ["echo", "desktop-ok"] }, context))
    events.push(event);
  expect(events).toContainEqual({ type: "stdout", data: "desktop-ok\n" });
  await provider.writeFile(
    computer,
    { path: "note.txt", content: new TextEncoder().encode("saved") },
    context,
  );
  expect(new TextDecoder().decode(await provider.readFile(computer, "note.txt", context))).toBe(
    "saved",
  );
  const screen = await provider.connectScreen(
    computer,
    { view: "stream", interactive: true, controlToken: "human-control" },
    context,
  );
  expect(screen).toMatchObject({
    url: "https://93.184.216.34/desktop/32123/embed.html?token=screen-token",
    headers: { authorization: "Bearer fixture-runtime-token" },
    tlsServerName: "runtime.example.test",
    tlsCertificateSha256: host.settings.certificateSha256,
  });
  const terminal = await provider.connectTerminal(
    computer,
    { controlToken: "human-control" },
    context,
  );
  expect(terminal.url).toContain("/desktop/32124/terminal.html");
  await provider.stop(computer, context);
  const resumed = await provider.provision(
    {
      botId: "bot-a",
      homePath: "/unused",
      providerKind: computer.kind,
      providerRef: computer.providerRef,
    },
    context,
  );
  expect(resumed.fresh).toBe(false);
  expect(new TextDecoder().decode(await provider.readFile(resumed, "note.txt", context))).toBe(
    "saved",
  );
  await provider.destroy(resumed, context);
  expect(
    host.calls.every((call) => new URL(call.url).origin === "https://runtime.example.test"),
  ).toBe(true);
  expect(host.calls.find((call) => call.body?.homePath)?.body).toMatchObject({
    homePath: "/var/lib/rakazo/homes/bot-a",
    spaceId: "space-a",
  });
});

it("keeps references on their original connection and refuses another Space before HTTP", async () => {
  const host = emulatedRemoteRuntime();
  const computer = await host
    .provider()
    .provision({ botId: "bot-a", homePath: "/unused" }, context);
  const other = new RemoteSupervisorSandboxProvider(
    { ...host.settings, connectionIdentity: "connection-b" },
    host.dependencies,
  );
  const count = host.calls.length;
  expect(other.ownsReference(computer)).toBe(false);
  await expect(other.stop(computer, context)).rejects.toThrow(/connection/);
  await expect(
    host.provider().destroy(computer, { ...context, spaceId: "space-b" }),
  ).rejects.toThrow(/ownership/);
  expect(host.calls).toHaveLength(count);
});

it("rechecks DNS rebinding before credentials or commands leave the server", async () => {
  const host = emulatedRemoteRuntime();
  const provider = host.provider();
  const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
  const count = host.calls.length;
  host.resolveHostname.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
  await expect(provider.stop(computer, context)).rejects.toThrow(/blocked/);
  expect(host.calls).toHaveLength(count);
});

it("requires an exact operator origin to use a private runtime and seals its checked address", async () => {
  const host = emulatedRemoteRuntime();
  host.resolveHostname.mockResolvedValue([{ address: "100.64.10.8", family: 4 }]);
  const provider = host.provider();
  await expect(
    provider.provision({ botId: "bot-a", homePath: "/unused" }, context),
  ).rejects.toThrow(/operator/);
  expect(host.calls).toHaveLength(0);
  vi.stubEnv("COMPUTER_RUNTIME_PRIVATE_ORIGINS", "https://runtime.example.test");
  const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
  expect(await provider.connectScreen(computer, { view: "stream" }, context)).toMatchObject({
    url: "https://100.64.10.8/desktop/32123/embed.html?token=screen-token",
    tlsServerName: "runtime.example.test",
  });
});

it("reports an unreachable runtime instead of treating it as stopped or falling back", async () => {
  const host = emulatedRemoteRuntime();
  const computer = await host
    .provider()
    .provision({ botId: "bot-a", homePath: "/unused" }, context);
  const provider = new RemoteSupervisorSandboxProvider(host.settings, {
    ...host.dependencies,
    fetch: async () => {
      throw new Error("Runtime connection refused");
    },
  });
  await expect(provider.isRunning(computer, context)).rejects.toThrow("Runtime connection refused");
  await expect(provider.isStopped(computer, context)).rejects.toThrow("Runtime connection refused");
});

it("cleans up only a desktop belonging to its recorded connection and home", async () => {
  const host = emulatedRemoteRuntime();
  const provider = host.provider();
  const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
  const machine = {
    provider: computer.kind,
    machineId: computer.providerRef,
    homeKey: computer.botId,
    providerConnectionId: host.settings.connectionIdentity,
  };
  const count = host.calls.length;
  await expect(
    provider.deleteMachine(
      { ...machine, providerConnectionId: "another-connection" },
      context.signal,
    ),
  ).rejects.toThrow("ownership");
  await expect(
    provider.deleteMachine({ ...machine, homeKey: "another-home" }, context.signal),
  ).rejects.toThrow("ownership");
  expect(host.calls).toHaveLength(count);
  await provider.deleteMachine(machine, context.signal);
  expect(host.homes.size).toBe(0);
  expect(host.calls.at(-1)).toMatchObject({ method: "DELETE" });
});

it.each([".", ".."])(
  "rejects special home segment %s before provisioning or following a reference",
  async (home) => {
    const host = emulatedRemoteRuntime();
    const provider = host.provider();
    await expect(provider.provision({ botId: home, homePath: "/unused" }, context)).rejects.toThrow(
      "home identity",
    );
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    const ref = JSON.parse(Buffer.from(computer.providerRef.slice(8), "base64url").toString());
    ref.home = home;
    const forged = `runtime.${Buffer.from(JSON.stringify(ref)).toString("base64url")}`;
    const count = host.calls.length;
    await expect(
      provider.stop({ ...computer, id: forged, botId: home, providerRef: forged }, context),
    ).rejects.toThrow("reference");
    expect(host.calls).toHaveLength(count);
  },
);
