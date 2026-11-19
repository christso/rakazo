import { randomUUID } from "node:crypto";
import { emulatedCloudRuntime } from "../../../computers/sandbox/cloud-runtime/cloud-runtime.test-support.js";
import { MachineRecords } from "../../../computers/sandbox/sandbox-test-support.js";
import { vultrComputer } from "./vultr-computer.js";

interface Instance {
  id: string;
  label: string;
  tags: string[];
  status: string;
  server_status: string;
  power_status: string;
  main_ip: string;
}

class CreateReceipts extends MachineRecords {
  async pendingCreate(provider: string, connectionId: string, homeKey: string) {
    return [...this.due.values()]
      .map(({ machine }) => machine)
      .find(
        (machine) =>
          machine.provider === provider &&
          machine.providerConnectionId === connectionId &&
          machine.homeKey === homeKey,
      );
  }
}

export function emulatedVultr(fallback?: typeof globalThis.fetch) {
  const settings = {
    apiToken: "test-vps-key",
    runtimeSecret: "test-vps-runtime-secret",
    connectionIdentity: "test-vps-connection",
    region: "ewr",
    plan: "vc2-2c-4gb",
    appImage: `registry.example.test/app@sha256:${"a".repeat(64)}`,
    computerImage: `registry.example.test/computer@sha256:${"b".repeat(64)}`,
  };
  const wire = emulatedCloudRuntime("93.184.216.35");
  const instances = new Map<string, Instance>();
  const records = new CreateReceipts();
  const calls: { path: string; method: string }[] = [];
  const controls = {
    visible: true,
    loseCreateResponse: false,
    rejectCreate: false,
    splitPages: false,
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (wire.matches(url, headers)) return wire.respond(url, init, headers, body);
    if (url.origin !== "https://api.vultr.com") {
      if (url.hostname === wire.address || !fallback) throw new Error("Unexpected fixture request");
      return fallback(input, init);
    }
    if (
      headers.get("authorization") !== `Bearer ${settings.apiToken}` ||
      init?.redirect !== "error"
    )
      throw new Error("Unexpected provider request credentials");
    calls.push({ path: url.pathname, method });
    if (url.pathname === "/v2/instances" && method === "POST") {
      if (records.due.size === 0) throw new Error("Provider create has no recorded cleanup");
      if (
        body.region !== settings.region ||
        body.plan !== settings.plan ||
        body.os_id !== 2625 ||
        body.backups !== "disabled" ||
        body.enable_ipv6 !== false ||
        body.activation_email !== false ||
        !Array.isArray(body.block_devices) ||
        body.block_devices.length > 0
      )
        throw new Error("Unexpected cloud VM options");
      if (controls.rejectCreate) return new Response("untrusted body", { status: 400 });
      const instance: Instance = {
        id: randomUUID(),
        label: body.label,
        tags: body.tags,
        status: "active",
        server_status: "ok",
        power_status: "running",
        main_ip: wire.address,
      };
      wire.addBootstrap(Buffer.from(body.user_data, "base64").toString());
      instances.set(instance.id, instance);
      if (controls.loseCreateResponse) throw new Error("Create response was lost");
      return Response.json({ instance }, { status: 202 });
    }
    if (url.pathname === "/v2/instances") {
      const label = url.searchParams.get("label");
      const visible = controls.visible
        ? [...instances.values()].filter((instance) => !label || instance.label === label)
        : [];
      const secondPage = url.searchParams.get("cursor") === "continuation-opaque-value";
      return Response.json({
        instances: controls.splitPages && !secondPage ? [] : visible,
        meta: {
          links: { next: controls.splitPages && !secondPage ? "continuation-opaque-value" : "" },
        },
      });
    }
    const id = url.pathname.split("/")[3]!;
    const instance = controls.visible && instances.get(id);
    if (!instance) return new Response(null, { status: 404 });
    if (method === "DELETE") {
      instances.delete(id);
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/start")) instance.power_status = "running";
    if (url.pathname.endsWith("/halt")) instance.power_status = "stopped";
    if (method === "POST") return new Response(null, { status: 204 });
    return Response.json({ instance });
  };
  return {
    settings,
    records,
    controls,
    instances,
    calls,
    fetch,
    provider: () =>
      vultrComputer.create({ providerSettings: settings, unreferencedMachines: records }),
  };
}
