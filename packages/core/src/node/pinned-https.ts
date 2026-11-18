import { createHash, timingSafeEqual } from "node:crypto";
import https from "node:https";
import type { TLSSocket } from "node:tls";
import { connect } from "node:tls";

export function isTlsCertificateSha256(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

interface PinnedTlsOptions {
  host: string;
  port: number;
  fingerprint: string;
  signal?: AbortSignal;
}

/** Releases a socket only after the certificate matches an authenticated, out-of-band pin. */
export function connectPinnedTls(
  options: PinnedTlsOptions,
  callback: (error: Error | null, socket?: TLSSocket) => void,
): void {
  if (!isTlsCertificateSha256(options.fingerprint)) {
    callback(new Error("Invalid runtime TLS certificate fingerprint"));
    return;
  }
  if (options.signal?.aborted) {
    callback(new Error("Runtime TLS connection aborted"));
    return;
  }
  const socket = connect({
    host: options.host,
    port: options.port,
    // This one connection authenticates the exact certificate instead of a public CA/name.
    rejectUnauthorized: false,
    minVersion: "TLSv1.2",
  });
  let settled = false;
  const failed = (error: Error) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    callback(error);
  };
  const aborted = () => socket.destroy(new Error("Runtime TLS connection aborted"));
  options.signal?.addEventListener("abort", aborted, { once: true });
  socket.once("close", () => options.signal?.removeEventListener("abort", aborted));
  socket.once("error", failed);
  socket.setTimeout(10_000, () => failed(new Error("Runtime TLS certificate handshake timed out")));
  socket.once("secureConnect", () => {
    if (settled) return;
    const certificate = socket.getPeerCertificate().raw;
    const actual = certificate ? createHash("sha256").update(certificate).digest() : null;
    const expected = Buffer.from(options.fingerprint, "base64url");
    if (!actual || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      failed(new Error("Runtime TLS certificate does not match its fingerprint"));
      return;
    }
    socket.setTimeout(0);
    socket.off("error", failed);
    settled = true;
    callback(null, socket);
  });
}

/** HTTP cannot flush its queued headers/body until createConnection calls back with a pin-checked socket. */
export function pinnedHttpsAgent(fingerprint: string): https.Agent {
  if (!isTlsCertificateSha256(fingerprint))
    throw new Error("Invalid runtime TLS certificate fingerprint");
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (options, callback) => {
    if (!callback) throw new Error("Pinned HTTPS requires asynchronous socket creation");
    connectPinnedTls(
      {
        host: options.hostname ?? options.host ?? "localhost",
        port: Number(options.port ?? 443),
        fingerprint,
        signal: options.signal,
      },
      (error, socket) => {
        if (error) callback(error, undefined!);
        else callback(null, socket!);
      },
    );
    return undefined;
  };
  return agent;
}
