import { deadlineSignal, parseRetryAfter, retry } from "@rakazo/core";
import { z } from "zod";
import type {
  CloudDiskSnapshots,
  CloudMachine,
  CloudMachineClient,
} from "../../../computers/sandbox/cloud-runtime/cloud-runtime-sandbox.js";

const API = "https://api.vultr.com/v2";
// The Debian 13 guest completes the runtime image pull on Vultr. Its Debian 12 image stalled.
const DEBIAN_13_X64 = 2625;

const resourceId = z.string().uuid();
const instanceShape = z.object({
  id: resourceId,
  label: z.string(),
  tags: z.array(z.string()).nullish(),
  status: z.string().optional(),
  server_status: z.string().optional(),
  power_status: z.string().optional(),
  main_ip: z.string().optional(),
});
const instanceResult = z.object({ instance: instanceShape });
const listResult = z.object({
  instances: z.array(instanceShape),
  meta: z.object({ links: z.object({ next: z.string().nullish() }) }),
});

const snapshotShape = z.object({
  id: resourceId,
  description: z.string(),
  status: z.enum(["pending", "complete", "deleted", "error"]),
});
const snapshotList = z.object({ snapshots: z.array(snapshotShape), meta: listResult.shape.meta });

function toSnapshot(snapshot: z.infer<typeof snapshotShape>) {
  return {
    id: snapshot.id,
    marker: snapshot.description,
    status:
      snapshot.status === "complete"
        ? ("ready" as const)
        : snapshot.status === "pending"
          ? ("pending" as const)
          : ("failed" as const),
  };
}

class VultrRequestError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`Cloud provider request failed (${status})`);
  }
}

function toMachine(instance: z.infer<typeof instanceShape>): CloudMachine {
  const active = instance.status === "active" && instance.server_status === "ok";
  const status = !active
    ? "pending"
    : instance.power_status === "stopped"
      ? "off"
      : instance.power_status === "running" && instance.main_ip && instance.main_ip !== "0.0.0.0"
        ? "running"
        : "pending";
  const labels: Record<string, string> = {};
  for (const tag of instance.tags ?? []) {
    const [name, value] = tag.split("=");
    if (!name?.startsWith("rakazo-") || !value) continue;
    if (Object.hasOwn(labels, name))
      throw new Error("Cloud computer has conflicting ownership tags");
    labels[name] = value;
  }
  return { id: instance.id, status, ipv4: instance.main_ip, labels };
}

export class VultrClient implements CloudMachineClient {
  constructor(
    private readonly token: string,
    private readonly region: string,
    private readonly plan: string,
  ) {}

  readonly snapshots: CloudDiskSnapshots = {
    create: async (id, marker, signal) => {
      const result = await this.request("POST", "/snapshots", signal, {
        instance_id: resourceId.parse(id),
        description: marker,
      });
      return z.object({ snapshot: z.object({ id: resourceId }) }).parse(result).snapshot.id;
    },
    find: async (marker, signal) => {
      const params = new URLSearchParams({ per_page: "500" });
      const cursors = new Set<string>();
      let found: ReturnType<typeof toSnapshot> | null = null;
      while (true) {
        const page = snapshotList.parse(await this.request("GET", `/snapshots?${params}`, signal));
        for (const snapshot of page.snapshots) {
          if (snapshot.description !== marker) continue;
          if (found) throw new Error("Cloud disk snapshot ownership is ambiguous");
          found = toSnapshot(snapshot);
        }
        const next = page.meta.links.next;
        if (!next) return found;
        if (cursors.has(next)) throw new Error("Cloud provider repeated a snapshot list cursor");
        cursors.add(next);
        params.set("cursor", next);
      }
    },
    get: async (id, signal) => {
      try {
        const { snapshot } = z
          .object({ snapshot: snapshotShape })
          .parse(await this.request("GET", `/snapshots/${resourceId.parse(id)}`, signal));
        if (snapshot.id !== id) throw new Error("Cloud disk snapshot identity mismatch");
        return toSnapshot(snapshot);
      } catch (error) {
        if (error instanceof VultrRequestError && error.status === 404) return null;
        throw error;
      }
    },
    delete: async (id, signal) => {
      try {
        await this.request("DELETE", `/snapshots/${resourceId.parse(id)}`, signal);
      } catch (error) {
        if (!(error instanceof VultrRequestError && error.status === 404)) throw error;
      }
    },
    createWasRejected: (error) => this.createWasRejected(error),
  };

  async verify(signal: AbortSignal) {
    listResult.parse(await this.request("GET", "/instances?per_page=1", signal));
  }

  async find(name: string, signal: AbortSignal) {
    return this.findInstance((instance) => instance.label === name, signal, name);
  }

  async findByLabels(labels: Record<string, string>, signal: AbortSignal) {
    const tags = Object.entries(labels).map(([name, value]) => `${name}=${value}`);
    return this.findInstance(
      (instance) => tags.every((tag) => instance.tags?.includes(tag)),
      signal,
    );
  }

  async get(id: CloudMachine["id"], signal: AbortSignal) {
    try {
      const path = this.instancePath(id);
      const { instance } = instanceResult.parse(await this.request("GET", path, signal));
      if (instance.id !== id) throw new Error("Cloud computer response has a different identity");
      return toMachine(instance);
    } catch (error) {
      if (error instanceof VultrRequestError && error.status === 404) return null;
      throw error;
    }
  }

  async create(
    { name, labels, userData, snapshotId }: Parameters<CloudMachineClient["create"]>[0],
    signal: AbortSignal,
  ) {
    const { instance } = instanceResult.parse(
      await this.request("POST", "/instances", signal, {
        region: this.region,
        plan: this.plan,
        label: name,
        hostname: name,
        ...(snapshotId
          ? { snapshot_id: resourceId.parse(snapshotId) }
          : { os_id: DEBIAN_13_X64, user_data: Buffer.from(userData!).toString("base64") }),
        tags: Object.entries(labels).map(([key, value]) => `${key}=${value}`),
        activation_email: false,
        backups: "disabled",
        enable_ipv6: false,
        block_devices: [],
      }),
    );
    return toMachine(instance);
  }

  // Only explicit request rejections release the pre-submit receipt. Timeout, conflict,
  // invalid responses and server errors can leave a create running on the provider.
  createWasRejected(error: unknown) {
    return (
      error instanceof VultrRequestError && [400, 401, 403, 404, 422, 429].includes(error.status)
    );
  }

  async start(id: CloudMachine["id"], signal: AbortSignal) {
    await this.request("POST", `${this.instancePath(id)}/start`, signal);
  }
  async stop(id: CloudMachine["id"], signal: AbortSignal) {
    await this.request("POST", `${this.instancePath(id)}/halt`, signal);
  }
  async delete(id: CloudMachine["id"], signal: AbortSignal) {
    try {
      await this.request("DELETE", this.instancePath(id), signal);
    } catch (error) {
      if (!(error instanceof VultrRequestError && error.status === 404)) throw error;
    }
  }

  private instancePath(id: CloudMachine["id"]) {
    return `/instances/${resourceId.parse(id)}`;
  }

  private async findInstance(
    matches: (instance: z.infer<typeof instanceShape>) => boolean,
    signal: AbortSignal,
    label?: string,
  ) {
    let found: CloudMachine | null = null;
    const cursors = new Set<string>();
    const params = new URLSearchParams({ per_page: "500" });
    if (label) params.set("label", label);
    let cursor: string | null | undefined;
    do {
      if (cursor) params.set("cursor", cursor);
      const page = listResult.parse(await this.request("GET", `/instances?${params}`, signal));
      for (const instance of page.instances) {
        if (!matches(instance)) continue;
        if (found) throw new Error("Cloud computer ownership is ambiguous");
        found = toMachine(instance);
      }
      cursor = page.meta.links.next;
      if (!cursor) break;
      if (cursors.has(cursor)) throw new Error("Cloud provider repeated an instance list cursor");
      cursors.add(cursor);
    } while (cursor);
    return found;
  }

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<unknown> {
    const perform = async () => {
      let response: Response;
      try {
        response = await fetch(`${API}${path}`, {
          method,
          headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal: deadlineSignal(30_000, signal),
        });
      } catch {
        // Fetch errors can include the supplied header value, for example for an invalid key.
        signal.throwIfAborted();
        throw new Error("Cloud provider could not be reached");
      }
      if (!response.ok) {
        void response.body?.cancel();
        throw new VultrRequestError(
          response.status,
          parseRetryAfter(response.headers.get("retry-after")),
        );
      }
      if (method === "DELETE" || response.status === 204) {
        await response.body?.cancel();
        return;
      }
      try {
        return await response.json();
      } catch {
        // Provider error messages and response bodies can include submitted bootstrap secrets.
        throw new Error("Cloud provider returned an invalid response");
      }
    };
    if (method !== "GET") return perform();
    return retry(perform, {
      attempts: 3,
      signal,
      retryable: (error) =>
        error instanceof VultrRequestError && (error.status === 429 || error.status >= 500),
    });
  }
}
