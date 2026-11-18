import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { pinnedGatewayFetch } from "./gateway-transport.js";

const key = readFileSync(
  new URL("../../../../../core/src/node/fixtures/runtime-tls/key.pem", import.meta.url),
);
const cert = readFileSync(
  new URL("../../../../../core/src/node/fixtures/runtime-tls/certificate.pem", import.meta.url),
);
const pin = createHash("sha256").update(new X509Certificate(cert).raw).digest("base64url");
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
async function runtime() {
  const received: { host?: string; token?: string }[] = [];
  const names: (string | false | null)[] = [];
  const server = https.createServer({ key, cert }, (request, response) => {
    received.push({ host: request.headers.host, token: request.headers.authorization });
    response.end("ready");
  });
  server.on("secureConnection", (socket) => names.push(socket.servername));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { port: (server.address() as AddressInfo).port, received, names };
}

it("preserves logical HTTP Host and SNI while dialing only the checked numeric address", async () => {
  const server = await runtime();
  const send = pinnedGatewayFetch(pin, "runtime-does-not-resolve.invalid");
  const response = await send(`https://127.0.0.1:${server.port}/health`, {
    headers: {
      host: `runtime-does-not-resolve.invalid:${server.port}`,
      authorization: "Bearer synthetic-token",
    },
    signal: AbortSignal.timeout(1000),
  });
  expect(await response.text()).toBe("ready");
  expect(server.received).toEqual([
    { host: `runtime-does-not-resolve.invalid:${server.port}`, token: "Bearer synthetic-token" },
  ]);
  expect(server.names).toEqual(["runtime-does-not-resolve.invalid"]);
});

it("sends no credentials to a checked address with the wrong certificate", async () => {
  const server = await runtime();
  const send = pinnedGatewayFetch("A".repeat(43), "runtime-does-not-resolve.invalid");
  await expect(
    send(`https://127.0.0.1:${server.port}/health`, {
      headers: { authorization: "Bearer synthetic-token" },
      signal: AbortSignal.timeout(1000),
    }),
  ).rejects.toThrow("fetch failed");
  expect(server.received).toEqual([]);
});

it("refuses a hostname dial target before any request can leave the transport", () => {
  const fetcher = vi.fn<typeof fetch>();
  const send = pinnedGatewayFetch(pin, "runtime.example.test", fetcher);
  expect(() =>
    send("https://runtime.example.test/health", {
      headers: { authorization: "Bearer synthetic-token" },
    }),
  ).toThrow("checked numeric HTTPS");
  expect(fetcher).not.toHaveBeenCalled();
});
