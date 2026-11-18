import { lookup } from "node:dns/promises";
import {
  ipVersion,
  isCloudMetadataAddress,
  isCloudMetadataHost,
  isInternalHostname,
  isLinkLocalAddress,
  isLocalhostOrLoopbackIp,
  isNonPublicAddress,
  isPrivateNetworkAddress,
} from "@rakazo/contracts";
import { deadlineSignal } from "@rakazo/core";
import type { ResolveHostname } from "../../../network/network-address.js";
import { egressRefused } from "../../../network/network-address.js";
import { withAbort } from "../../../web/web-ssrf.js";

function privateOrigins() {
  return (process.env.COMPUTER_RUNTIME_PRIVATE_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => parseOrigin(entry).origin);
}
function parseOrigin(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.href.includes("?") ||
    url.href.includes("#")
  )
    throw new Error("Runtime URL must be an HTTPS origin without credentials, path or query");
  return url;
}
function blocked(host: string) {
  return (
    isLocalhostOrLoopbackIp(host) ||
    isCloudMetadataHost(host) ||
    isCloudMetadataAddress(host) ||
    isLinkLocalAddress(host)
  );
}
/** Synchronous settings check. DNS and its operator grant are rechecked before each request. */
export function assertRuntimeEndpoint(value: string) {
  const url = parseOrigin(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (blocked(host)) throw egressRefused(host, new Error("Runtime endpoint is blocked"));
  if (
    (isInternalHostname(host) || (ipVersion(host) && isNonPublicAddress(host))) &&
    !privateOrigins().includes(url.origin)
  )
    throw new Error("Private runtime requires an operator-approved origin");
  return url;
}

/** Return a checked numeric dial target. The screen proxy receives this address, never a DNS lookup. */
export async function pinRuntimeEndpoint(
  value: string,
  options: { resolveHostname?: ResolveHostname; signal?: AbortSignal } = {},
) {
  const url = assertRuntimeEndpoint(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const family = ipVersion(host);
  const resolve =
    options.resolveHostname ??
    ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));
  const addresses = family
    ? [{ address: host, family }]
    : await withAbort(resolve(host), deadlineSignal(10_000, options.signal));
  if (!addresses.length) throw new Error("Runtime hostname did not resolve");
  if (
    addresses.some(
      ({ address }) =>
        blocked(address) || (isNonPublicAddress(address) && !isPrivateNetworkAddress(address)),
    )
  )
    throw egressRefused(host, new Error("Runtime address is blocked"));
  const privateCount = addresses.filter(({ address }) => isPrivateNetworkAddress(address)).length;
  if (privateCount && privateCount !== addresses.length)
    throw egressRefused(host, new Error("Runtime DNS has mixed public and private addresses"));
  if (privateCount && !privateOrigins().includes(url.origin))
    throw egressRefused(host, new Error("Private runtime requires an operator-approved origin"));
  const target = new URL(url);
  target.hostname = addresses[0]!.address.includes(":")
    ? `[${addresses[0]!.address}]`
    : addresses[0]!.address;
  return { origin: target.origin, hostHeader: url.host, ...(!family ? { serverName: host } : {}) };
}
