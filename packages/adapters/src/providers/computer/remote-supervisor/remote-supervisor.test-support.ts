import { vi } from "vitest";
import { MachineRecords } from "../../../computers/sandbox/sandbox-test-support.js";
import { simpleCommand } from "../../../computers/screens/linux-desktop.test-support.js";
import { RemoteSupervisorSandboxProvider } from "./remote-supervisor.js";

/** Offline supervisor wire protocol on an existing host; unknown requests never reach a network. */
export function emulatedRemoteRuntime() {
  const settings = {
    apiUrl: "https://runtime.example.test",
    apiToken: "fixture-runtime-token",
    certificateSha256: "A".repeat(43),
    connectionIdentity: "connection-a",
  };
  const homes = new Map<string, { space: string; running: boolean; files: Map<string, string> }>();
  const calls: { url: string; method?: string; body?: Record<string, unknown> }[] = [];
  const resolveHostname = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (
      !["https://93.184.216.34", "https://100.64.10.8"].includes(url.origin) ||
      headers.get("authorization") !== `Bearer ${settings.apiToken}` ||
      headers.get("host") !== "runtime.example.test"
    )
      throw new Error("Unexpected remote fixture request");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: url.toString(), method: init?.method, body });
    if (url.pathname === "/health") return Response.json({ ok: true });
    const homeKey = headers.get("x-rakazo-bot-id")!;
    const space = headers.get("x-rakazo-space-id")!;
    let home = homes.get(homeKey);
    if (home && home.space !== space)
      return Response.json({ error: "computer identity mismatch" }, { status: 403 });
    if (url.pathname === "/computers" && init?.method === "POST") {
      const resumed = Boolean(home);
      if (!home) {
        home = { space, running: true, files: new Map() };
        homes.set(homeKey, home);
      }
      home.running = true;
      return Response.json({ id: `container-${homeKey}`, resumed, started: true });
    }
    if (!home) return Response.json({ error: "computer not found" }, { status: 404 });
    if (init?.method === "DELETE") {
      homes.delete(homeKey);
      return Response.json({});
    }
    if (url.pathname.endsWith("/stop")) {
      home.running = false;
      return Response.json({});
    }
    if (url.pathname.endsWith("/exec")) {
      const { stdout = "", exitCode = 0 } = simpleCommand(body.argv, body.env ?? {});
      return Response.json({ stdout, stderr: "", code: exitCode });
    }
    if (url.pathname.endsWith("/files")) {
      if (init?.method === "POST") {
        home.files.set(body.path, body.content);
        return Response.json({});
      }
      return Response.json({ content: home.files.get(url.searchParams.get("path") ?? "") ?? "" });
    }
    if (url.pathname.endsWith("/screen-mode"))
      return Response.json({ screenUrl: "http://127.0.0.1:32123/embed.html?token=screen-token" });
    if (url.pathname.endsWith("/terminal"))
      return Response.json({
        terminalUrl: "http://127.0.0.1:32124/terminal.html?token=terminal-token",
      });
    if (/^\/computers\/rakazo-bot-[A-Za-z0-9_.-]+$/.test(url.pathname))
      return Response.json({ running: home.running });
    throw new Error("Unexpected remote fixture operation");
  };
  const dependencies = {
    fetch: fetcher,
    resolveHostname,
    unreferencedMachines: new MachineRecords(),
  };
  return {
    settings,
    calls,
    homes,
    resolveHostname,
    dependencies,
    provider: () => new RemoteSupervisorSandboxProvider(settings, dependencies),
  };
}
