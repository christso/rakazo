import type { UnreferencedMachineRecords } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import type { CloudMachine } from "../../../computers/sandbox/cloud-runtime/cloud-runtime-sandbox.js";
import { CloudRuntimeSandbox } from "../../../computers/sandbox/cloud-runtime/cloud-runtime-sandbox.js";
import type { CloudServer } from "./hetzner-client.js";
import { HetznerApiError, HetznerClient } from "./hetzner-client.js";

function machine(server: CloudServer | null): CloudMachine | null {
  return server && { ...server, ipv4: server.public_net.ipv4?.ip };
}

export class HetznerSandboxProvider extends CloudRuntimeSandbox {
  constructor(
    settings: Record<string, string>,
    machines?: UnreferencedMachineRecords,
    hibernationDb?: PrismaClient,
  ) {
    const client = new HetznerClient(settings.apiToken ?? "");
    super(
      "hetzner",
      {
        snapshots: client.snapshots,
        find: async (name, signal) => machine(await client.find(name, signal)),
        findByLabels: async (labels, signal) => machine(await client.findByLabels(labels, signal)),
        get: async (id, signal) => machine(await client.server(Number(id), signal)),
        async create({ name, labels, userData, snapshotId }, signal) {
          const { server } = await client.request<{ server: CloudServer }>(
            "POST",
            "/servers",
            signal,
            {
              name,
              image: snapshotId ? Number(snapshotId) : "debian-12",
              location: settings.location,
              server_type: settings.serverType,
              user_data: userData,
              start_after_create: true,
              labels,
              public_net: { enable_ipv4: true, enable_ipv6: false },
            },
          );
          return { ...server, ipv4: server.public_net.ipv4?.ip };
        },
        async start(id, signal) {
          await client.request("POST", `/servers/${id}/actions/poweron`, signal);
        },
        async stop(id, signal) {
          await client.request("POST", `/servers/${id}/actions/shutdown`, signal);
        },
        async delete(id, signal) {
          try {
            await client.request("DELETE", `/servers/${id}`, signal);
          } catch (error) {
            if (!(error instanceof HetznerApiError && error.status === 404)) throw error;
          }
        },
      },
      settings,
      machines,
      hibernationDb,
    );
    this.credentials = settings;
  }

  private readonly credentials: Record<string, string>;
  protected override validateSettings() {
    for (const key of ["apiToken", "runtimeSecret", "connectionIdentity", "location", "serverType"])
      if (!this.credentials[key]?.trim()) throw new Error(`Computer connection requires ${key}`);
    super.validateSettings();
  }
}
