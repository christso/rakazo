import { deadlineSignal, parseRetryAfter, retry } from "@rakazo/core";

const API = "https://api.hetzner.cloud/v1";

export interface CloudServer {
  id: number;
  name: string;
  status: string;
  labels: Record<string, string>;
  public_net: { ipv4?: { ip: string } | null };
}

export class HetznerApiError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`Cloud provider request failed (${status})`);
  }
}

/** Fixed HTTPS origin; request bodies and provider error text can contain bootstrap secrets. */
export class HetznerClient {
  constructor(private readonly token: string) {}

  async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<T> {
    const perform = async () => {
      const response = await fetch(`${API}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: deadlineSignal(30_000, signal),
      });
      if (!response.ok) {
        void response.body?.cancel();
        throw new HetznerApiError(
          response.status,
          parseRetryAfter(response.headers.get("retry-after")),
        );
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    };
    // POST is deliberately never retried: its lost response is reconciled by the unique server name.
    return method === "GET"
      ? retry(perform, {
          attempts: 3,
          signal,
          retryable: (error) =>
            error instanceof HetznerApiError && (error.status === 429 || error.status >= 500),
        })
      : perform();
  }

  async find(name: string, signal: AbortSignal) {
    const response = await this.request<{ servers: CloudServer[] }>(
      "GET",
      `/servers?name=${encodeURIComponent(name)}&per_page=2`,
      signal,
    );
    if (response.servers.length > 1) throw new Error("Cloud computer name is ambiguous");
    return response.servers[0] ?? null;
  }

  async server(id: number, signal: AbortSignal) {
    try {
      return (await this.request<{ server: CloudServer }>("GET", `/servers/${id}`, signal)).server;
    } catch (error) {
      if (error instanceof HetznerApiError && error.status === 404) return null;
      throw error;
    }
  }

  async findByLabels(labels: Record<string, string>, signal: AbortSignal) {
    const selector = Object.entries(labels)
      .map(([key, value]) => `${key}=${value}`)
      .join(",");
    const response = await this.request<{ servers: CloudServer[] }>(
      "GET",
      `/servers?label_selector=${encodeURIComponent(selector)}&per_page=2`,
      signal,
    );
    if (response.servers.length > 1) throw new Error("Cloud computer generation is ambiguous");
    return response.servers[0] ?? null;
  }
}
