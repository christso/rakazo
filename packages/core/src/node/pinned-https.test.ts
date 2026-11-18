import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { connectPinnedTls, pinnedHttpsAgent } from "./pinned-https.js";

// Synthetic certificate and key used only by offline transport tests.
const TEST_TLS_KEY = readFileSync(
  new URL("./fixtures/runtime-tls/key.pem", import.meta.url),
  "utf8",
);
const TEST_TLS_CERTIFICATE = readFileSync(
  new URL("./fixtures/runtime-tls/certificate.pem", import.meta.url),
  "utf8",
);

const fingerprint = createHash("sha256")
  .update(new X509Certificate(TEST_TLS_CERTIFICATE).raw)
  .digest("base64url");
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function runtime() {
  const received: string[] = [];
  const applicationBytes: number[] = [];
  const serverNames: (string | false | null)[] = [];
  const server = https.createServer(
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERTIFICATE },
    (request, response) => {
      received.push(request.headers.authorization ?? "");
      response.end("ready");
    },
  );
  server.on("secureConnection", (socket) => {
    serverNames.push(socket.servername);
    socket.on("data", (chunk) => applicationBytes.push(chunk.length));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { port: (server.address() as AddressInfo).port, received, applicationBytes, serverNames };
}

async function readRuntime(port: number, pin: string, serverName?: string) {
  const agent = pinnedHttpsAgent(pin, serverName);
  cleanups.push(() => agent.destroy());
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    https
      .get(
        { host: "127.0.0.1", port, agent, headers: { authorization: "Bearer synthetic-token" } },
        resolve,
      )
      .on("error", reject);
  });
  response.resume();
  await once(response, "end");
  return response.statusCode;
}

describe("pinned runtime HTTPS", () => {
  it("preserves an approved hostname for SNI while dialing an exact numeric address", async () => {
    const server = await runtime();
    expect(await readRuntime(server.port, fingerprint, "runtime.example.test")).toBe(200);
    expect(server.serverNames).toEqual(["runtime.example.test"]);
  });
  it("authenticates a self-signed certificate before sending a request", async () => {
    const server = await runtime();
    expect(await readRuntime(server.port, fingerprint)).toBe(200);
    expect(server.received).toEqual(["Bearer synthetic-token"]);
  });

  it("sends no request headers when the certificate does not match", async () => {
    const server = await runtime();
    await expect(readRuntime(server.port, "A".repeat(43))).rejects.toThrow("certificate");
    expect(server.received).toEqual([]);
    expect(server.applicationBytes).toEqual([]);
  });

  it("does not hand an unverified socket to a websocket transport", async () => {
    const server = await runtime();
    const result = await new Promise<{ error: Error | null; socket: unknown }>((resolve) => {
      connectPinnedTls(
        { host: "127.0.0.1", port: server.port, fingerprint: "A".repeat(43) },
        (error, socket) => resolve({ error, socket }),
      );
    });
    expect(result.error?.message).toContain("certificate");
    expect(result.socket).toBeUndefined();
    expect(server.received).toEqual([]);
    expect(server.applicationBytes).toEqual([]);
  });
});
