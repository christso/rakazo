import type {
  AdapterContext,
  ComputerRef,
  SandboxProvider,
  ScreenSession,
  UnreferencedMachine,
  UnreferencedMachineRecords,
} from "@rakazo/adapter-kit";
import { ipVersion } from "@rakazo/contracts";
import { cancelResponseBody, deadlineSignal } from "@rakazo/core";
import { supervisorComputerName } from "@rakazo/core/node/supervisor-identity";
import { recordUnreferencedMachine } from "../../../computers/sandbox/sandbox-cleanup.js";
import { sandboxNotFoundError } from "../../../computers/sandbox/sandbox-errors.js";
import { pinRuntimeEndpoint } from "../../../computers/sandbox/supervisor/gateway-endpoint.js";
import {
  gatewayScreenTransport,
  pinnedGatewayFetch,
} from "../../../computers/sandbox/supervisor/gateway-transport.js";
import { SupervisorSandboxProvider } from "../../../computers/sandbox/supervisor/supervisor-sandbox.js";
import type { ResolveHostname } from "../../../network/network-address.js";
import { credentialDigest } from "../../../secrets/credential-digest.js";
import { readBodyCapped } from "../../../web/web-ssrf.js";

import { validateRemoteRuntimeSettings } from "./remote-settings.js";

const KIND = "remote-supervisor";
function validHome(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_.-]{1,128}$/.test(value) &&
    value !== "." &&
    value !== ".."
  );
}
interface Reference {
  connection: string;
  space: string;
  home: string;
}
export interface RemoteRuntimeDependencies {
  fetch?: typeof fetch;
  resolveHostname?: ResolveHostname;
  unreferencedMachines?: UnreferencedMachineRecords;
}

/** Dedicated desktops on an operator-prepared host. This adapter has no VM/cloud control API. */
export class RemoteSupervisorSandboxProvider extends SupervisorSandboxProvider {
  private readonly connection: string;
  private readonly send: typeof fetch;
  constructor(
    private readonly settings: Record<string, string>,
    private readonly dependencies: RemoteRuntimeDependencies = {},
  ) {
    super("https://runtime.invalid", "runtime-placeholder", KIND, (input, init) =>
      this.runtimeRequest(input, init),
    );
    this.connection = credentialDigest(settings.connectionIdentity ?? "");
    const serverName = settings.apiUrl
      ? new URL(settings.apiUrl).hostname.replace(/^\[|\]$/g, "")
      : undefined;
    this.send = pinnedGatewayFetch(
      settings.certificateSha256 ?? "",
      serverName && !ipVersion(serverName) ? serverName : undefined,
      dependencies.fetch,
    );
  }
  async verifyConnection(signal: AbortSignal) {
    validateRemoteRuntimeSettings(this.settings);
    const endpoint = await this.endpoint(signal);
    const response = await this.send(`${endpoint.origin}/health`, {
      signal,
      headers: { authorization: `Bearer ${this.settings.apiToken}`, host: endpoint.hostHeader },
    });
    if (!response.ok) {
      cancelResponseBody(response);
      throw new Error("Remote runtime is unavailable");
    }
    const body = JSON.parse(
      new TextDecoder().decode(await readBodyCapped(response, 8192, signal)),
    ) as { ok?: unknown };
    if (body.ok !== true) throw new Error("Invalid remote runtime health response");
  }
  billsWhileRunning() {
    return false;
  }
  async keepsHome() {
    return true;
  }
  ownsReference(computer: Pick<ComputerRef, "providerRef">) {
    try {
      this.reference(computer.providerRef);
      return true;
    } catch {
      return false;
    }
  }

  override async provision(
    request: Parameters<SandboxProvider["provision"]>[0],
    context: AdapterContext,
  ): Promise<ComputerRef> {
    validateRemoteRuntimeSettings(this.settings);
    if (!this.settings.connectionIdentity)
      throw new Error("Remote computer requires a Space connection");
    if (!validHome(request.botId)) throw new Error("Invalid computer home identity");
    const reference = { connection: this.connection, space: context.spaceId, home: request.botId };
    const providerRef = `runtime.${Buffer.from(JSON.stringify(reference)).toString("base64url")}`;
    if (request.providerRef)
      this.assertOwner(this.reference(request.providerRef), request.botId, context.spaceId);
    const endpoint = await this.endpoint(context.signal);
    if (!request.providerRef)
      await recordUnreferencedMachine(this.dependencies.unreferencedMachines, {
        provider: KIND,
        machineId: providerRef,
        homeKey: request.botId,
        providerConnectionId: this.settings.connectionIdentity,
      });
    const runtime = new SupervisorSandboxProvider(
      endpoint.origin,
      this.settings.apiToken,
      KIND,
      (input, init) =>
        this.send(input, {
          ...init,
          headers: { ...Object.fromEntries(new Headers(init?.headers)), host: endpoint.hostHeader },
        }),
    );
    const created = await runtime.provision(
      { ...request, homePath: `/var/lib/rakazo/homes/${request.botId}` },
      context,
    );
    return { ...created, id: providerRef, providerRef };
  }
  override isRunning(computer: ComputerRef, context: AdapterContext) {
    return this.running(computer, context);
  }
  async isStopped(computer: ComputerRef, context: AdapterContext) {
    return !(await this.running(computer, context));
  }
  override async connectScreen(
    ...args: Parameters<SupervisorSandboxProvider["connectScreen"]>
  ): Promise<ScreenSession> {
    const screen = await super.connectScreen(...args);
    return {
      ...screen,
      ...gatewayScreenTransport(
        screen.url,
        await this.endpoint(args[2].signal),
        this.settings.apiToken!,
        this.settings.certificateSha256!,
      ),
    };
  }
  override async connectTerminal(
    ...args: Parameters<SupervisorSandboxProvider["connectTerminal"]>
  ) {
    const terminal = await super.connectTerminal(...args);
    return {
      ...terminal,
      ...gatewayScreenTransport(
        terminal.url,
        await this.endpoint(args[2].signal),
        this.settings.apiToken!,
        this.settings.certificateSha256!,
      ),
    };
  }
  async deleteMachine(machine: UnreferencedMachine, signal: AbortSignal) {
    const ref = this.reference(machine.machineId);
    if (
      machine.provider !== KIND ||
      machine.providerConnectionId !== this.settings.connectionIdentity ||
      machine.homeKey !== ref.home
    )
      throw new Error("Remote computer cleanup ownership mismatch");
    await super.destroy(
      { id: machine.machineId, providerRef: machine.machineId, botId: ref.home, kind: KIND },
      { operationId: "cleanup", traceId: "cleanup", spaceId: ref.space, userId: "", signal },
    );
  }
  private endpoint(signal: AbortSignal) {
    return pinRuntimeEndpoint(this.settings.apiUrl!, {
      signal,
      resolveHostname: this.dependencies.resolveHostname,
    });
  }
  private reference(value: string): Reference {
    if (!value.startsWith("runtime.")) throw new Error("Invalid remote computer reference");
    const ref = JSON.parse(Buffer.from(value.slice(8), "base64url").toString("utf8")) as Reference;
    if (ref.connection !== this.connection) throw new Error("Remote computer connection mismatch");
    if (typeof ref.space !== "string" || !ref.space || !validHome(ref.home))
      throw new Error("Invalid remote computer reference");
    return ref;
  }
  private assertOwner(ref: Reference, home: string, space: string) {
    if (ref.home !== home || ref.space !== space)
      throw new Error("Remote computer ownership mismatch");
  }
  private async runtimeRequest(input: Parameters<typeof fetch>[0], init?: RequestInit) {
    const url = new URL(String(input));
    const match = /^\/computers\/(runtime\.[A-Za-z0-9_-]+)(.*)$/.exec(url.pathname);
    if (!match) throw new Error("Invalid remote runtime request");
    const ref = this.reference(match[1]!);
    const headers = new Headers(init?.headers);
    this.assertOwner(
      ref,
      headers.get("x-rakazo-bot-id") ?? "",
      headers.get("x-rakazo-space-id") ?? "",
    );
    const endpoint = await this.endpoint(init?.signal ?? deadlineSignal(30_000));
    headers.set("authorization", `Bearer ${this.settings.apiToken}`);
    headers.set("host", endpoint.hostHeader);
    return this.send(
      `${endpoint.origin}/computers/${encodeURIComponent(supervisorComputerName(ref.home))}${match[2]}${url.search}`,
      { ...init, headers },
    );
  }
  private async running(computer: ComputerRef, context: AdapterContext) {
    const response = await this.runtimeRequest(
      `https://runtime.invalid/computers/${computer.providerRef}`,
      {
        headers: { "x-rakazo-bot-id": computer.botId, "x-rakazo-space-id": context.spaceId },
        signal: context.signal,
      },
    );
    if (response.status === 404) {
      cancelResponseBody(response);
      throw sandboxNotFoundError("Remote desktop no longer exists");
    }
    if (!response.ok) {
      cancelResponseBody(response);
      throw new Error("Remote computer is unavailable");
    }
    const body = JSON.parse(
      new TextDecoder().decode(await readBodyCapped(response, 8192, context.signal)),
    ) as { running?: unknown };
    if (typeof body.running !== "boolean") throw new Error("Invalid remote computer state");
    return body.running;
  }
}
