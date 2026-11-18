import { once } from "node:events";
import https from "node:https";
import type { AddressInfo } from "node:net";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type * as PinnedHttps from "@rakazo/core/node/pinned-https";
import { flush } from "@rakazo/core/test-async";
import { afterEach, expect, it, vi } from "vitest";
import { MachineRecords } from "../../../computers/sandbox/sandbox-test-support.js";
import { runtimeCertificate } from "./hetzner-bootstrap.js";
import { HetznerSandboxProvider } from "./hetzner-sandbox.js";
import { emulatedHetzner } from "./hetzner-sandbox.test-support.js";

const dial = vi.hoisted(() => ({ port: 0 }));
// Only the cloud-assigned fixture address is redirected; the real TLS pin check still runs.
vi.mock("@rakazo/core/node/pinned-https", async (original) => {
  const actual = await original<typeof PinnedHttps>();
  return {
    ...actual,
    connectPinnedTls: (
      options: Parameters<typeof actual.connectPinnedTls>[0],
      callback: Parameters<typeof actual.connectPinnedTls>[1],
    ) =>
      actual.connectPinnedTls(
        options.host === "93.184.216.34"
          ? { ...options, host: "127.0.0.1", port: dial.port }
          : options,
        callback,
      ),
  };
});

const nativeFetch = globalThis.fetch;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

async function fixture() {
  const cloud = emulatedHetzner();
  const authorizations: string[] = [];
  const modes = { execution: "json", oversizedFile: false, closed: false };
  const server = https.createServer({}, (request, response) => {
    authorizations.push(request.headers.authorization ?? "");
    const json = (value: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/health") return json({ ok: true });
    if (request.url === "/computers") {
      request.resume();
      return json({ id: "container-a" });
    }
    if (request.url?.includes("/files")) {
      if (modes.oversizedFile) {
        response.writeHead(200, { "content-type": "application/json", "content-length": "10000" });
        response.flushHeaders();
        return;
      }
      return json({ content: Buffer.from("wire-file").toString("base64") });
    }
    if (request.url?.endsWith("/exec")) {
      request.resume();
      if (modes.execution === "stream") {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(`${JSON.stringify({ type: "stdout", data: "stream-started" })}\n`);
        response.on("close", () => {
          modes.closed = true;
        });
        return;
      }
      if (modes.execution === "hang") {
        response.on("close", () => {
          modes.closed = true;
        });
        return;
      }
      return json({ stdout: "", stderr: "", code: 0 });
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  dial.port = (server.address() as AddressInfo).port;
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input).startsWith("https://api.hetzner.cloud/")) {
      if (init?.method === "POST" && String(input).endsWith("/servers")) {
        const data = JSON.parse(String(init.body));
        const config = JSON.parse(data.user_data.split("\n")[1]);
        const file = (ending: string) =>
          Buffer.from(
            config.write_files.find((entry: { path: string }) => entry.path.endsWith(ending))
              .content,
            "base64",
          ).toString();
        server.setSecureContext({ cert: file("server.crt"), key: file("server.key") });
      }
      return cloud.fetch(input, init);
    }
    return nativeFetch(input, init);
  });
  const provider = new HetznerSandboxProvider(cloud.settings, new MachineRecords());
  const context: AdapterContext = {
    operationId: "tls",
    traceId: "tls",
    spaceId: "space",
    userId: "owner",
    signal: AbortSignal.timeout(3_000),
  };
  const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
  return {
    provider,
    computer,
    server,
    modes,
    authorizations,
    context: { ...context, signal: new AbortController().signal },
  };
}

it("completes real pinned HTTPS readiness, execution and bounded file responses", async () => {
  const f = await fixture();
  await f.provider.prepare(f.computer, f.context);
  expect(
    new TextDecoder().decode(await f.provider.readFile(f.computer, "note.txt", f.context)),
  ).toBe("wire-file");
  expect(
    f.authorizations.every(
      (header) => header.startsWith("Bearer ") && !header.includes("test-cloud-token"),
    ),
  ).toBe(true);
  f.modes.oversizedFile = true;
  await expect(
    f.provider.readFile(f.computer, "note.txt", f.context, { maxBytes: 4 }),
  ).rejects.toThrow(/exceeds/);
});

it("sends no credentials when the runtime certificate changes", async () => {
  const f = await fixture();
  const replacement = await runtimeCertificate();
  f.server.setSecureContext({ cert: replacement.certificate, key: replacement.privateKey });
  f.server.closeAllConnections();
  await flush();
  const before = f.authorizations.length;
  await expect(f.provider.prepare(f.computer, f.context)).rejects.toMatchObject({
    name: "SandboxUnresponsiveError",
    cause: { cause: { message: "Runtime TLS certificate does not match its fingerprint" } },
  });
  expect(f.authorizations).toHaveLength(before);
});

it("cancels an active response stream and closes its upstream connection", async () => {
  const f = await fixture();
  f.modes.execution = "stream";
  const controller = new AbortController();
  const events = f.provider
    .execute(f.computer, { argv: ["fixture-stream"] }, { ...f.context, signal: controller.signal })
    [Symbol.asyncIterator]();
  expect((await events.next()).value).toEqual({ type: "stdout", data: "stream-started" });
  controller.abort(new Error("fixture cancellation"));
  await expect(events.next()).rejects.toThrow("fixture cancellation");
  await vi.waitFor(() => expect(f.modes.closed).toBe(true));
});

it("honors the caller deadline while the runtime leaves response headers pending", async () => {
  const f = await fixture();
  f.modes.execution = "hang";
  const work = async () => {
    for await (const _event of f.provider.execute(
      f.computer,
      { argv: ["fixture-hang"] },
      { ...f.context, signal: AbortSignal.timeout(50) },
    )) {
    }
  };
  await expect(work()).rejects.toMatchObject({ name: "TimeoutError" });
  await vi.waitFor(() => expect(f.modes.closed).toBe(true));
});
