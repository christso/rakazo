import { simpleCommand } from "../../screens/linux-desktop.test-support.js";

type RuntimeRequest = {
  argv: string[];
  env?: Record<string, string>;
  path: string;
  content: string;
  executable?: boolean;
  actions: unknown[];
};

export function emulatedCloudRuntime(address = "93.184.216.34") {
  const tokens = new Set<string>();
  const files = new Map<string, Map<string, { content: string; executable?: boolean }>>();
  return {
    address,
    matches(url: URL, headers: Headers) {
      return url.hostname === address && tokens.has(headers.get("authorization") ?? "");
    },
    addBootstrap(userData: string) {
      const [, configLine] = userData.split("\n");
      if (!configLine) throw new Error("Missing runtime cloud config");
      const config = JSON.parse(configLine);
      const environment = config.write_files.find(
        (file: { path: string }) => file.path === "/etc/rakazo-runtime/environment",
      );
      tokens.add(
        `Bearer ${Buffer.from(environment.content, "base64").toString().trim().split("=")[1]}`,
      );
    },
    respond(url: URL, init: RequestInit | undefined, headers: Headers, body: RuntimeRequest) {
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
          if (
            maxBytes !== null &&
            Buffer.from(file.content, "base64").byteLength > Number(maxBytes)
          )
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
    },
  };
}
