import { isIP } from "node:net";
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
  const dispatchers = new Map<string, Agent>();
  const send = fetchPairedWithDispatcher(fetcher);
  return (input, init) => {
    const target = new URL(String(input));
    const address = target.hostname.replace(/^\[|\]$/g, "");
    if (target.protocol !== "https:" || !isIP(address) || target.username || target.password)
      throw new Error("Runtime transport requires a checked numeric HTTPS address");
    let dispatcher = dispatchers.get(target.origin);
    if (!dispatcher) {
      const port = Number(target.port || 443);
      dispatcher = new Agent({
        connect: (_options, callback) =>
          connectPinnedTls(
            { host: address, port, fingerprint, servername: serverName },
            (error, socket) => (error ? callback(error, null) : callback(null, socket!)),
          ),
      });
      dispatchers.set(target.origin, dispatcher);
    }
    // fetch ignores a caller's Host header. Keep the approved logical authority in its URL,
    // while the connector above dials only the checked address and performs no DNS lookup.
    if (serverName) target.hostname = serverName;
    return send(target, { ...init, dispatcher, redirect: "error" } as RequestInit & {
      dispatcher: Agent;
    });
  };
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
