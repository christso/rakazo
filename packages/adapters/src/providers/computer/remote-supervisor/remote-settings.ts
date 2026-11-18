import { isTlsCertificateSha256 } from "@rakazo/core/node/pinned-https";
import { assertRuntimeEndpoint } from "../../../computers/sandbox/supervisor/gateway-endpoint.js";

export function validateRemoteRuntimeSettings(values: Record<string, string>) {
  assertRuntimeEndpoint(values.apiUrl ?? "");
  if (!isTlsCertificateSha256(values.certificateSha256))
    throw new Error("Invalid runtime certificate fingerprint");
  if (!values.apiToken?.trim()) throw new Error("Runtime access token is required");
}
