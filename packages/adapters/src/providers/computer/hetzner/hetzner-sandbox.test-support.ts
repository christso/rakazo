import { emulatedCloudRuntime } from "../../../computers/sandbox/cloud-runtime/cloud-runtime.test-support.js";
import { MachineRecords } from "../../../computers/sandbox/sandbox-test-support.js";
import type { CloudServer } from "./hetzner-client.js";
import { HetznerSandboxProvider } from "./hetzner-sandbox.js";

/** Offline cloud API plus the existing supervisor wire protocol, with persistent VM disks. */
export function emulatedHetzner(fallback?: typeof globalThis.fetch) {
  const settings = {
    apiToken: "test-cloud-token",
    runtimeSecret: "test-runtime-secret",
    connectionIdentity: "test-cloud-connection",
    location: "fsn1",
    serverType: "cx23",
    appImage: `registry.example.test/app@sha256:${"a".repeat(64)}`,
    computerImage: `registry.example.test/computer@sha256:${"b".repeat(64)}`,
  };
  const servers = new Map<string, CloudServer>();
  const calls: { url: string; init?: RequestInit }[] = [];
  const wire = emulatedCloudRuntime();
  let sequence = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const provider =
      url.hostname === "api.hetzner.cloud" &&
      headers.get("authorization") === `Bearer ${settings.apiToken}`;
    const runtime = wire.matches(url, headers);
    if (!provider && !runtime) {
      if (!fallback || url.hostname === "api.hetzner.cloud" || url.hostname === "93.184.216.34")
        throw new Error("Unexpected cloud fixture request");
      return fallback(input, init);
    }
    calls.push({ url: url.toString(), init });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (provider) {
      if (url.pathname === "/v1/servers" && init?.method === "POST") {
        const server: CloudServer = {
          id: ++sequence,
          name: body.name,
          labels: body.labels,
          status: "running",
          public_net: { ipv4: { ip: "93.184.216.34" } },
        };
        servers.set(server.name, server);
        wire.addBootstrap(body.user_data);
        return Response.json({ server });
      }
      if (url.searchParams.has("name"))
        return Response.json({
          servers: [...servers.values()].filter(
            (server) => server.name === url.searchParams.get("name"),
          ),
        });
      if (url.searchParams.has("label_selector"))
        return Response.json({
          servers: [...servers.values()].filter((server) =>
            url.searchParams
              .get("label_selector")!
              .split(",")
              .every((selector) => {
                const [key, value] = selector.split("=");
                return server.labels[key!] === value;
              }),
          ),
        });
      const id = Number(url.pathname.split("/")[3]);
      const server = [...servers.values()].find((entry) => entry.id === id);
      if (!server) return Response.json({}, { status: 404 });
      if (init?.method === "DELETE") {
        servers.delete(server.name);
        return Response.json({});
      }
      if (url.pathname.endsWith("/shutdown")) server.status = "off";
      if (url.pathname.endsWith("/poweron")) server.status = "running";
      return Response.json({ server, action: { id: 1 } });
    }
    return wire.respond(url, init, headers, body);
  };
  return {
    settings,
    servers,
    calls,
    fetch,
    provider: () => new HetznerSandboxProvider(settings, new MachineRecords()),
  };
}
