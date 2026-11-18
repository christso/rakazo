import { createHash, createHmac } from "node:crypto";
import type {
  AdapterContext,
  ComputerRef,
  SandboxProvider,
  ScreenSession,
  UnreferencedMachine,
  UnreferencedMachineRecords,
} from "@rakazo/adapter-kit";
import { ipVersion, isNonPublicAddress } from "@rakazo/contracts";
import { deadlineSignal, pollUntil } from "@rakazo/core";
import { connectPinnedTls } from "@rakazo/core/node/pinned-https";
import { supervisorComputerName } from "@rakazo/core/node/supervisor-identity";
import { bestEffort } from "@rakazo/logging";
import { Agent } from "undici";
import { requireUnreferencedMachineRecord } from "../../../computers/sandbox/sandbox-cleanup.js";
import { sandboxNotFoundError } from "../../../computers/sandbox/sandbox-errors.js";
import { SupervisorSandboxProvider } from "../../../computers/sandbox/supervisor/supervisor-sandbox.js";
import { computerCloudInit, runtimeCertificate } from "./hetzner-bootstrap.js";
import type { CloudServer } from "./hetzner-client.js";
import { HetznerApiError, HetznerClient } from "./hetzner-client.js";

const KIND = "hetzner";
const READY_MS = 15 * 60_000;
interface Reference {
  connection: string;
  name: string;
  home: string;
  space: string;
  pin: string;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const encode = (value: Reference) =>
  `cloud.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;

export class HetznerSandboxProvider extends SupervisorSandboxProvider {
  private readonly client: HetznerClient;
  private readonly connection: string;
  private readonly transports = new Map<string, Agent>();

  constructor(
    private readonly settings: Record<string, string>,
    private readonly machines?: UnreferencedMachineRecords,
  ) {
    super("https://runtime.invalid", "runtime-placeholder", KIND, (input, init) =>
      this.runtimeRequest(input, init),
    );
    this.client = new HetznerClient(settings.apiToken ?? "");
    this.connection = digest(settings.connectionIdentity ?? "");
  }

  billsWhileRunning() {
    return true;
  }
  async keepsHome() {
    return true;
  }
  ownsReference(computer: Pick<ComputerRef, "providerRef">) {
    try {
      return this.reference(computer.providerRef).connection === this.connection;
    } catch {
      return false;
    }
  }

  override async provision(
    request: Parameters<SandboxProvider["provision"]>[0],
    context: AdapterContext,
  ): Promise<ComputerRef> {
    this.validateSettings();
    if (!/^[A-Za-z0-9_.-]+$/.test(request.botId)) throw new Error("Invalid computer home identity");
    const signal = deadlineSignal(READY_MS, context.signal);
    const owner = {
      connection: this.connection,
      home: digest(request.botId),
      space: digest(context.spaceId),
    };
    const name = `rakazo-${digest(`${this.connection}:${context.spaceId}:${request.botId}`)}`;
    const previous =
      request.providerKind === KIND && request.providerRef
        ? this.reference(request.providerRef)
        : undefined;
    if (
      previous &&
      (previous.name !== name || previous.home !== owner.home || previous.space !== owner.space)
    )
      throw new Error("Cloud computer ownership mismatch");
    let server = previous
      ? await this.findGeneration(previous, signal)
      : await this.client.find(name, signal);
    if (!server && !previous)
      server = await this.client.findByLabels(
        {
          "rakazo-connection": owner.connection,
          "rakazo-home": owner.home,
          "rakazo-space": owner.space,
        },
        signal,
      );
    let ref: Reference;
    let fresh = false;
    let pendingCreate: UnreferencedMachine | undefined;
    if (!server) {
      // A recorded server disappearing is an offline/gone computer, never permission to replace its disk silently.
      if (previous) throw sandboxNotFoundError("Cloud computer no longer exists");
      const certificate = await runtimeCertificate();
      ref = { ...owner, name, pin: certificate.fingerprint };
      pendingCreate = this.machine(ref, request.botId);
      await requireUnreferencedMachineRecord(this.machines, pendingCreate);
      const userData = computerCloudInit({
        appImage: this.settings.appImage!,
        computerImage: this.settings.computerImage!,
        homeKey: request.botId,
        token: this.runtimeToken(request.botId),
        ...certificate,
      });
      try {
        ({ server } = await this.client.request<{ server: CloudServer }>(
          "POST",
          "/servers",
          signal,
          {
            name,
            image: "debian-12",
            location: this.settings.location,
            server_type: this.settings.serverType,
            user_data: userData,
            start_after_create: true,
            labels: {
              "rakazo-connection": owner.connection,
              "rakazo-home": owner.home,
              "rakazo-space": owner.space,
              "rakazo-cert": ref.pin,
            },
            public_net: { enable_ipv4: true, enable_ipv6: false },
          },
        ));
      } catch (error) {
        // An accepted create may have lost its response. The provider's unique name prevents a duplicate across processes.
        server = await this.client.find(name, signal);
        if (!server) throw error;
      }
      fresh = true;
    }
    ref = { ...owner, name, pin: server.labels["rakazo-cert"]! };
    this.assertOwner(server, ref, previous);
    const initial = this.machine(ref, request.botId);
    // A stored computer already keeps this disk. A restart failure must never schedule its deletion.
    if (!previous) await requireUnreferencedMachineRecord(this.machines, initial);
    const started = server.status === "off";
    if (started) await this.client.request("POST", `/servers/${server.id}/actions/poweron`, signal);
    server = await pollUntil(
      async () => {
        const found = await this.findGeneration(ref, signal);
        if (!found) throw sandboxNotFoundError("Cloud computer no longer exists");
        this.assertOwner(found, ref);
        return found.status === "running" && found;
      },
      { intervalMs: 1_000, timeoutMs: READY_MS, signal, waitingFor: "cloud computer to start" },
    );
    const address = this.address(server);
    const runtimeFetch = this.pinnedFetch(ref.pin);
    await pollUntil(
      async () => {
        try {
          const response = await runtimeFetch(`https://${address}/health`, {
            headers: { authorization: `Bearer ${this.runtimeToken(request.botId)}` },
            signal: deadlineSignal(5_000, signal),
          });
          const ready = response.ok;
          await response.body?.cancel();
          return ready;
        } catch (error) {
          if (signal.aborted) throw error;
          return false;
        }
      },
      { intervalMs: 2_000, timeoutMs: READY_MS, signal, waitingFor: "computer desktop runtime" },
    );
    const runtime = new SupervisorSandboxProvider(
      `https://${address}`,
      this.runtimeToken(request.botId),
      KIND,
      runtimeFetch,
    );
    await runtime.provision(
      { ...request, homePath: `/var/lib/rakazo/homes/${request.botId}` },
      { ...context, signal },
    );
    const providerRef = encode(ref);
    if (!previous) {
      // The pre-create record and the stored computer use the same certificate-bound generation.
      // Keep its job until activation cancels it; a failed cancellation still sees an exact holder.
      await requireUnreferencedMachineRecord(this.machines, this.machine(ref, request.botId));
      if (pendingCreate && pendingCreate.machineId !== initial.machineId)
        await bestEffort(
          "clear a reconciled cloud create's cleanup",
          this.machines?.clear(pendingCreate),
        );
    }
    return { id: providerRef, providerRef, botId: request.botId, kind: KIND, fresh, started };
  }

  override async isRunning(computer: ComputerRef, context: AdapterContext) {
    const server = await this.serverFor(computer, context);
    return server.status === "running" && super.isRunning(computer, context);
  }
  async isStopped(computer: ComputerRef, context: AdapterContext) {
    return (await this.serverFor(computer, context)).status === "off";
  }

  override async connectScreen(
    ...args: Parameters<SupervisorSandboxProvider["connectScreen"]>
  ): Promise<ScreenSession> {
    const session = await super.connectScreen(...args);
    return { ...session, ...(await this.screenTransport(session.url, args[0], args[2])) };
  }
  override async connectTerminal(
    ...args: Parameters<SupervisorSandboxProvider["connectTerminal"]>
  ) {
    const session = await super.connectTerminal(...args);
    return { ...session, ...(await this.screenTransport(session.url, args[0], args[2])) };
  }
  override async stop(computer: ComputerRef, context: AdapterContext) {
    const server = await this.serverFor(computer, context);
    if (server.status === "off") return;
    await this.client.request("POST", `/servers/${server.id}/actions/shutdown`, context.signal);
    await pollUntil(async () => (await this.serverFor(computer, context)).status === "off", {
      intervalMs: 1_000,
      timeoutMs: 60_000,
      signal: context.signal,
      waitingFor: "cloud computer shutdown",
    });
  }
  override async destroy(computer: ComputerRef, context: AdapterContext) {
    const ref = this.reference(computer.providerRef);
    this.assertContext(ref, computer.botId, context.spaceId);
    await this.remove(ref, context.signal);
  }
  async deleteMachine(machine: UnreferencedMachine, signal: AbortSignal) {
    const ref = this.reference(machine.machineId);
    if (!machine.homeKey || digest(machine.homeKey) !== ref.home)
      throw new Error("Cloud computer ownership mismatch");
    await this.remove(ref, signal);
  }

  private async remove(ref: Reference, parent: AbortSignal) {
    const signal = deadlineSignal(60_000, parent);
    const server = await this.findGeneration(ref, signal);
    if (!server) return;
    this.assertOwner(server, ref);
    try {
      await this.client.request("DELETE", `/servers/${server.id}`, signal);
    } catch (error) {
      if (!(error instanceof HetznerApiError && error.status === 404)) throw error;
    }
    await pollUntil(
      // Check the immutable id: renames and name reuse cannot confirm or obstruct deletion.
      async () => (await this.client.server(server.id, signal)) === null,
      { intervalMs: 1_000, timeoutMs: 60_000, signal, waitingFor: "cloud computer deletion" },
    );
  }

  private machine(ref: Reference, homeKey: string): UnreferencedMachine {
    return {
      provider: KIND,
      machineId: encode(ref),
      homeKey,
      providerConnectionId: this.settings.connectionIdentity,
    };
  }
  private findGeneration(ref: Reference, signal: AbortSignal) {
    return this.client.findByLabels(
      {
        "rakazo-connection": ref.connection,
        "rakazo-home": ref.home,
        "rakazo-space": ref.space,
        "rakazo-cert": ref.pin,
      },
      signal,
    );
  }
  private validateSettings() {
    for (const key of ["apiToken", "runtimeSecret", "connectionIdentity", "location", "serverType"])
      if (!this.settings[key]?.trim()) throw new Error(`Computer connection requires ${key}`);
    for (const key of ["appImage", "computerImage"])
      if (
        !/^[a-z0-9][a-z0-9./_-]*(?::[0-9]+)?\/[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/.test(
          this.settings[key] ?? "",
        )
      )
        throw new Error("Computer images must use a registry and SHA-256 digest");
  }
  private reference(value: string): Reference {
    if (!value.startsWith("cloud.")) throw new Error("Invalid cloud computer reference");
    const ref = JSON.parse(Buffer.from(value.slice(6), "base64url").toString("utf8")) as Reference;
    if (
      ref.connection !== this.connection ||
      !/^rakazo-[a-f0-9]{32}$/.test(ref.name) ||
      !/^[a-f0-9]{32}$/.test(ref.home) ||
      !/^[a-f0-9]{32}$/.test(ref.space) ||
      !/^[A-Za-z0-9_-]{43}$/.test(ref.pin)
    )
      throw new Error("Cloud computer ownership mismatch");
    return ref;
  }
  private assertContext(ref: Reference, home: string, space: string) {
    if (ref.home !== digest(home) || ref.space !== digest(space))
      throw new Error("Cloud computer ownership mismatch");
  }
  private assertOwner(server: CloudServer, ref: Reference, previous?: Reference) {
    if (
      server.labels["rakazo-connection"] !== ref.connection ||
      server.labels["rakazo-home"] !== ref.home ||
      server.labels["rakazo-space"] !== ref.space ||
      server.labels["rakazo-cert"] !== ref.pin ||
      (previous && previous.pin !== ref.pin)
    )
      throw new Error("Cloud computer ownership mismatch");
  }
  private runtimeToken(home: string) {
    return createHmac("sha256", this.settings.runtimeSecret ?? "")
      .update(`${this.connection}:${home}`)
      .digest("base64url");
  }
  private address(server: CloudServer) {
    const ip = server.public_net.ipv4?.ip;
    if (!ip || ipVersion(ip) !== 4 || isNonPublicAddress(ip))
      throw new Error("Cloud computer has no public IPv4 address");
    return ip;
  }
  private async serverFor(computer: ComputerRef, context: AdapterContext) {
    const ref = this.reference(computer.providerRef);
    this.assertContext(ref, computer.botId, context.spaceId);
    const server = await this.findGeneration(ref, context.signal);
    if (!server) throw sandboxNotFoundError("Cloud computer no longer exists");
    this.assertOwner(server, ref);
    return server;
  }
  private pinnedFetch(pin: string): typeof fetch {
    let dispatcher = this.transports.get(pin);
    if (!dispatcher) {
      dispatcher = new Agent({
        connect: (options, callback) =>
          connectPinnedTls(
            { host: options.hostname, port: Number(options.port || 443), fingerprint: pin },
            (error, socket) => {
              if (error) callback(error, null);
              else callback(null, socket!);
            },
          ),
      });
      this.transports.set(pin, dispatcher);
    }
    return (input, init) => {
      const options: RequestInit & { dispatcher: Agent } = {
        ...init,
        dispatcher: dispatcher!,
        redirect: "error",
      };
      return fetch(input, options);
    };
  }
  private async runtimeRequest(input: Parameters<typeof fetch>[0], init?: RequestInit) {
    const url = new URL(String(input));
    const match = /^\/computers\/(cloud\.[A-Za-z0-9_-]+)(.*)$/.exec(url.pathname);
    if (!match) throw new Error("Invalid cloud runtime request");
    const ref = this.reference(match[1]!);
    const headers = new Headers(init?.headers);
    const home = headers.get("x-rakazo-bot-id") ?? "";
    const space = headers.get("x-rakazo-space-id") ?? "";
    const server = await this.serverFor(
      { id: match[1]!, providerRef: match[1]!, botId: home, kind: KIND },
      {
        operationId: "runtime",
        traceId: "runtime",
        spaceId: space,
        userId: "",
        signal: init?.signal ?? AbortSignal.timeout(30_000),
      },
    );
    headers.set("authorization", `Bearer ${this.runtimeToken(home)}`);
    return this.pinnedFetch(ref.pin)(
      `https://${this.address(server)}/computers/${encodeURIComponent(supervisorComputerName(home))}${match[2]}${url.search}`,
      { ...init, headers },
    );
  }
  private async screenTransport(
    value: string | null,
    computer: ComputerRef,
    context: AdapterContext,
  ) {
    if (!value) throw new Error("Cloud computer returned no screen");
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !/^\d+$/.test(url.port) ||
      Number(url.port) < 1024
    )
      throw new Error("Cloud computer returned an invalid screen endpoint");
    const server = await this.serverFor(computer, context);
    return {
      url: `https://${this.address(server)}/desktop/${url.port}${url.pathname}${url.search}`,
      headers: { authorization: `Bearer ${this.runtimeToken(computer.botId)}` },
      tlsCertificateSha256: this.reference(computer.providerRef).pin,
    };
  }
}
