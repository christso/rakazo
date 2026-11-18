import { MachineRecords } from "../../../computers/sandbox/sandbox-test-support.js";
import { simpleCommand } from "../../../computers/screens/linux-desktop.test-support.js";
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
  const tokens = new Set<string>();
  const files = new Map<string, Map<string, { content: string; executable?: boolean }>>();
  let sequence = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const provider =
      url.hostname === "api.hetzner.cloud" &&
      headers.get("authorization") === `Bearer ${settings.apiToken}`;
    const runtime =
      url.hostname === "93.184.216.34" && tokens.has(headers.get("authorization") ?? "");
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
        const config = JSON.parse(body.user_data.split("\n")[1]);
        const environment = config.write_files.find(
          (file: { path: string }) => file.path === "/etc/rakazo-runtime/environment",
        );
        tokens.add(
          `Bearer ${Buffer.from(environment.content, "base64").toString().trim().split("=")[1]}`,
        );
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
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname === "/computers")
      return Response.json({ id: `container-${headers.get("x-rakazo-bot-id")}`, resumed: true });
    if (url.pathname.endsWith("/exec")) {
      const { exitCode = 0, stdout = "" } = simpleCommand(body.argv, body.env ?? {});
      return Response.json({ stdout, stderr: "", code: exitCode });
    }
    if (url.pathname.endsWith("/files")) {
      const home = headers.get("x-rakazo-bot-id")!;
      let workspace = files.get(home);
      if (!workspace) {
        workspace = new Map();
        files.set(home, workspace);
      }
      if (init?.method === "POST") {
        workspace.set(body.path, { content: body.content, executable: body.executable });
        return Response.json({});
      }
      const filePath = url.searchParams.get("path") ?? "";
      if (url.searchParams.get("mode") === "read") {
        const file = workspace.get(filePath);
        if (!file) return Response.json({}, { status: 404 });
        const maxBytes = url.searchParams.get("maxBytes");
        if (maxBytes !== null && Buffer.from(file.content, "base64").byteLength > Number(maxBytes))
          return Response.json({}, { status: 413 });
        return Response.json({ content: file.content });
      }
      const prefix = filePath ? `${filePath}/` : "";
      const entries = new Map<string, unknown>();
      for (const [name, file] of workspace) {
        if (!name.startsWith(prefix)) continue;
        const tail = name.slice(prefix.length);
        const first = tail.split("/")[0]!;
        const directory = tail.includes("/");
        entries.set(first, {
          path: `${prefix}${first}`,
          kind: directory ? "dir" : "file",
          size: directory ? 0 : Buffer.from(file.content, "base64").byteLength,
          ...(!directory && file.executable ? { executable: true } : {}),
        });
      }
      return Response.json([...entries.values()]);
    }
    if (url.pathname.endsWith("/terminal"))
      return Response.json({
        terminalUrl: "http://127.0.0.1:32124/terminal.html?token=terminal-token",
      });
    if (url.pathname.endsWith("/actions"))
      return Response.json({
        completed: body.actions.length,
        observation: {
          image:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          mimeType: "image/png",
          width: 1,
          height: 1,
        },
      });
    if (url.pathname.endsWith("/screen-mode"))
      return Response.json({ screenUrl: "http://127.0.0.1:32123/embed.html?token=screen-token" });
    return Response.json({ running: true });
  };
  return {
    settings,
    servers,
    calls,
    fetch,
    provider: () => new HetznerSandboxProvider(settings, new MachineRecords()),
  };
}
