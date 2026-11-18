import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { openScreenCapability, sealScreenCapability } from "@rakazo/core/node/screen-capability";
import { createLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it } from "vitest";
import type { Middleware } from "./preview-middleware.js";
import { attachNovncProxy, webServerSettings } from "./preview-middleware.js";

// Synthetic certificate and key used only by offline transport tests.
const TEST_TLS_KEY = readFileSync(
  new URL("../../../packages/core/src/node/fixtures/runtime-tls/key.pem", import.meta.url),
  "utf8",
);
const TEST_TLS_CERTIFICATE = readFileSync(
  new URL("../../../packages/core/src/node/fixtures/runtime-tls/certificate.pem", import.meta.url),
  "utf8",
);

const fingerprint = createHash("sha256")
  .update(new X509Certificate(TEST_TLS_CERTIFICATE).raw)
  .digest("base64url");
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return (server.address() as AddressInfo).port;
}

async function proxy(pin: string, runtimePath = "/embed.html") {
  const received: { transport: string; authorization?: string }[] = [];
  const runtime = https.createServer(
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERTIFICATE },
    (request, response) => {
      received.push({ transport: "http", authorization: request.headers.authorization });
      response.setHeader("content-type", "text/plain");
      response.end("runtime");
    },
  );
  runtime.on("upgrade", (request, socket) => {
    received.push({ transport: "websocket", authorization: request.headers.authorization });
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
  });
  const runtimePort = await listen(runtime);
  const secret = "synthetic-screen-proxy-secret";
  const capability = new URL(
    sealScreenCapability(
      `https://127.0.0.1:${runtimePort}${runtimePath}`,
      secret,
      "https://app.example",
      {
        botId: "bot",
        computerId: "computer",
        botGeneration: 1,
        computerGeneration: 1,
        controlLeaseId: null,
      },
      undefined,
      { authorization: "Bearer synthetic-runtime-token" },
      pin,
    ),
  );
  const capabilityPath = `${capability.pathname}${capability.search}`;
  const authority = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const opened = openScreenCapability(JSON.parse(body).path, secret);
    response.statusCode = opened ? 200 : 403;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(opened?.target ?? {}));
  });
  const authorityPort = await listen(authority);
  let middleware: Middleware | undefined;
  const web = http.createServer((request, response) => {
    middleware!(request, response, () => {
      response.statusCode = 404;
      response.end();
    });
  });
  attachNovncProxy(
    {
      middlewares: {
        use: (handler) => {
          middleware = handler;
        },
      },
      httpServer: web,
    },
    webServerSettings(
      (key) =>
        ({
          API_PROXY_TARGET: `http://127.0.0.1:${authorityPort}`,
          SCREEN_PROXY_SECRET: "synthetic-screen-proxy-secret",
        })[key],
      createLogger({ service: "test", sinks: [] }),
    ),
  );
  return { port: await listen(web), received, capabilityPath };
}

function page(port: number, capabilityPath: string) {
  return new Promise<number | undefined>((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: capabilityPath }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      })
      .on("error", reject);
  });
}

function websocket(port: number, capabilityPath: string) {
  return new Promise<number>((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: capabilityPath,
      headers: { connection: "Upgrade", upgrade: "websocket" },
    });
    request.once("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    request.once("error", (error) => {
      if ("code" in error && error.code === "ECONNRESET") resolve(0);
      else reject(error);
    });
    request.end();
  });
}

describe("cloud runtime screen transport", () => {
  it("passes authorized HTTP and WebSocket traffic through a matching pin", async () => {
    const server = await proxy(fingerprint);
    expect(await page(server.port, server.capabilityPath)).toBe(200);
    expect(await websocket(server.port, server.capabilityPath)).toBe(101);
    expect(server.received).toEqual([
      { transport: "http", authorization: "Bearer synthetic-runtime-token" },
      { transport: "websocket", authorization: "Bearer synthetic-runtime-token" },
    ]);
  });

  it("keeps nested gateway credentials within the authorized screen directory", async () => {
    const server = await proxy(fingerprint, "/desktop/32123/embed.html");
    expect(await page(server.port, server.capabilityPath)).toBe(200);
    const escaped = server.capabilityPath.replace("/desktop/32123/embed.html", "/computers");
    expect(await page(server.port, escaped)).toBe(403);
    expect(await websocket(server.port, escaped)).toBe(0);
    expect(server.received).toEqual([
      { transport: "http", authorization: "Bearer synthetic-runtime-token" },
    ]);
  });

  it("sends neither HTTP nor WebSocket credentials to a mismatched runtime", async () => {
    const server = await proxy("A".repeat(43));
    expect(await page(server.port, server.capabilityPath)).toBe(502);
    expect(await websocket(server.port, server.capabilityPath)).toBe(0);
    expect(server.received).toEqual([]);
  });
});
