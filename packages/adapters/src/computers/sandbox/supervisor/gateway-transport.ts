import type { ScreenSession } from "@rakazo/adapter-kit";
import { connectPinnedTls } from "@rakazo/core/node/pinned-https";
import { Agent } from "undici";
import { fetchPairedWithDispatcher } from "../../../network/undici-fetch.js";

/** Callers check and pin the dial address; this transport authenticates its certificate before HTTP. */
export function pinnedGatewayFetch(
  fingerprint: string,
  serverName?: string,
  fetcher?: typeof fetch,
): typeof fetch {
  const dispatcher = new Agent({
    connect: (options, callback) =>
      connectPinnedTls(
        {
          host: options.hostname,
          port: Number(options.port || 443),
          fingerprint,
          servername: serverName,
        },
        (error, socket) => (error ? callback(error, null) : callback(null, socket!)),
      ),
  });
  const send = fetchPairedWithDispatcher(fetcher);
  return (input, init) =>
    send(input, { ...init, dispatcher, redirect: "error" } as RequestInit & { dispatcher: Agent });
}

/** Turn supervisor loopback screen ports into one authenticated, pin-checked gateway origin. */
export function gatewayScreenTransport(
  value: string | null,
  endpoint: { origin: string; serverName?: string },
  token: string,
  pin: string,
): Pick<ScreenSession, "headers" | "tlsCertificateSha256" | "tlsServerName"> & { url: string } {
  if (!value) throw new Error("Computer returned no screen");
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !/^\d+$/.test(url.port) ||
    Number(url.port) < 1024 ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Computer returned an invalid screen endpoint");
  return {
    url: `${endpoint.origin}/desktop/${url.port}${url.pathname}${url.search}`,
    headers: { authorization: `Bearer ${token}` },
    tlsCertificateSha256: pin,
    ...(endpoint.serverName ? { tlsServerName: endpoint.serverName } : {}),
  };
}
