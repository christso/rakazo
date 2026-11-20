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
import { supervisorComputerName } from "@rakazo/core/node/supervisor-identity";
import type { PrismaClient } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { requireUnreferencedMachineRecord } from "../sandbox-cleanup.js";
import { sandboxNotFoundError } from "../sandbox-errors.js";
import { gatewayScreenTransport, pinnedGatewayFetch } from "../supervisor/gateway-transport.js";
import { SupervisorSandboxProvider } from "../supervisor/supervisor-sandbox.js";
import { computerCloudInit, runtimeCertificate, validateCloudImages } from "./cloud-bootstrap.js";
import { CloudDiskHibernation } from "./cloud-disk-hibernation.js";

const READY_MS = 15 * 60_000;
const CREATE_UNCONFIRMED = "The submitted computer creation is not yet confirmed.";
export interface CloudMachine {
  id: string | number;
  status: string;
  labels: Record<string, string>;
  ipv4?: string | null;
}

export interface CloudDiskSnapshot {
  id: string;
  marker: string;
  status: "pending" | "ready" | "failed";
}

export interface CloudDiskSnapshots {
  create(machineId: CloudMachine["id"], marker: string, signal: AbortSignal): Promise<string>;
  find(marker: string, signal: AbortSignal): Promise<CloudDiskSnapshot | null>;
  get(id: string, signal: AbortSignal): Promise<CloudDiskSnapshot | null>;
  delete(id: string, signal: AbortSignal): Promise<void>;
  createWasRejected(error: unknown): boolean;
}

export interface CloudMachineClient {
  snapshots?: CloudDiskSnapshots;
  find(name: string, signal: AbortSignal): Promise<CloudMachine | null>;
  findByLabels(labels: Record<string, string>, signal: AbortSignal): Promise<CloudMachine | null>;
  get(id: CloudMachine["id"], signal: AbortSignal): Promise<CloudMachine | null>;
  create(
    input: { name: string; labels: Record<string, string> } & (
      | { userData: string; snapshotId?: never }
      | { snapshotId: string; userData?: never }
    ),
    signal: AbortSignal,
  ): Promise<CloudMachine>;
  start(id: CloudMachine["id"], signal: AbortSignal): Promise<void>;
  stop(id: CloudMachine["id"], signal: AbortSignal): Promise<void>;
  delete(id: CloudMachine["id"], signal: AbortSignal): Promise<void>;
  /** Present if the provider can accept a second create with the same name. */
  createWasRejected?(error: unknown): boolean;
}

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

export class CloudRuntimeSandbox extends SupervisorSandboxProvider {
  private readonly connection: string;
  private readonly hibernation?: CloudDiskHibernation;
  private readonly transports = new Map<string, typeof fetch>();

  constructor(
    private readonly providerKind: string,
    private readonly client: CloudMachineClient,
    private readonly settings: Record<string, string>,
    private readonly machines?: UnreferencedMachineRecords,
    hibernationDb?: PrismaClient,
  ) {
    super("https://runtime.invalid", "runtime-placeholder", providerKind, (input, init) =>
      this.runtimeRequest(input, init),
    );
    this.connection = digest(settings.connectionIdentity ?? "");
    if (hibernationDb && client.snapshots)
      this.hibernation = new CloudDiskHibernation(hibernationDb, client, client.snapshots);
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
      request.providerKind === this.providerKind && request.providerRef
        ? this.reference(request.providerRef)
        : undefined;
    if (
      previous &&
      (previous.name !== name || previous.home !== owner.home || previous.space !== owner.space)
    )
      throw new Error("Cloud computer ownership mismatch");
    const pending = previous ? undefined : await this.pendingCreate(request.botId);
    const pendingRef = pending && this.reference(pending.machineId);
    if (pendingRef) this.assertContext(pendingRef, request.botId, context.spaceId);
    const target = previous && this.hibernateTarget(previous, request.botId, context.spaceId);
    const restored = target && (await this.hibernation?.wake(target, signal));
    let server = previous
      ? (restored ?? (await this.findGeneration(previous, signal)))
      : pendingRef
        ? pending.providerResourceId
          ? await this.client.get(pending.providerResourceId, signal)
          : await this.findGeneration(pendingRef, signal)
        : await this.findOwner(owner, name, signal);
    if (pendingRef && !server) {
      throw new Error(CREATE_UNCONFIRMED);
    }
    if (!previous && !pendingRef && server && this.client.createWasRejected) {
      throw new Error("An instance already matches this computer without a recorded creation.");
    }
    if (!server && previous) throw sandboxNotFoundError("Cloud computer no longer exists");
    const fresh = !server;
    if (!server) server = await this.create(owner, name, request.botId, signal);

    const ref = { ...owner, name, pin: server.labels["rakazo-cert"]! };
    this.reference(encode(ref));
    this.assertOwner(server, ref, previous ?? pendingRef);
    const initial = this.machine(ref, request.botId);
    // A stored computer already keeps this disk. A restart failure must never schedule its deletion.
    if (!previous)
      await requireUnreferencedMachineRecord(
        this.machines,
        this.client.createWasRejected ? this.observedMachine(initial, server) : initial,
      );
    const started = server.status === "off";
    if (started) await this.client.start(server.id, signal);
    const instanceId = server.id;
    server = await pollUntil(
      async () => {
        const found =
          restored || this.client.createWasRejected
            ? await this.client.get(instanceId, signal)
            : await this.findGeneration(ref, signal);
        if (!found) {
          // A new instance can have an acknowledged ID before the provider starts serving reads.
          if (restored || (!previous && this.client.createWasRejected)) return false;
          throw sandboxNotFoundError("Cloud computer no longer exists");
        }
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
      this.providerKind,
      runtimeFetch,
    );
    await runtime.provision(
      { ...request, homePath: `/var/lib/rakazo/homes/${request.botId}` },
      { ...context, signal },
    );
    if (restored && target) await this.hibernation?.confirmWake(target, server, signal);
    const providerRef = encode(ref);
    return {
      id: providerRef,
      providerRef,
      botId: request.botId,
      kind: this.providerKind,
      fresh,
      started: started || Boolean(restored),
      ...(server.labels["rakazo-resume"] && { diskRestored: true }),
    };
  }

  override async isRunning(computer: ComputerRef, context: AdapterContext) {
    const server = await this.serverFor(computer, context);
    return server.status === "running" && super.isRunning(computer, context);
  }
  async isStopped(computer: ComputerRef, context: AdapterContext) {
    const ref = this.reference(computer.providerRef);
    const target = this.hibernateTarget(ref, computer.botId, context.spaceId);
    const server = await this.findGeneration(ref, context.signal);
    if (server) {
      this.assertOwner(server, ref);
      return server.status === "off";
    }
    return (await this.hibernation?.isReleased(target)) ?? false;
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
  override async stop(
    computer: ComputerRef,
    context: AdapterContext,
    options?: Parameters<SandboxProvider["stop"]>[2],
  ): Promise<void> {
    if (options?.hibernate && this.hibernation) {
      const ref = this.reference(computer.providerRef);
      const target = this.hibernateTarget(ref, computer.botId, context.spaceId);
      return this.hibernation.hibernate(
        target,
        context.signal,
        async (signal) => {
          const server = await this.findGeneration(ref, signal);
          if (server) this.assertOwner(server, ref);
          return server;
        },
        async (signal) => {
          const ctx = { ...context, signal };
          let exitCode: number | undefined;
          for await (const event of this.execute(
            computer,
            { argv: ["sync"], timeoutMs: 15_000 },
            ctx,
          ))
            if (event.type === "exit") exitCode = event.code;
          if (exitCode !== 0) throw new Error("The cloud computer could not flush its disk");
          await this.stop(computer, ctx);
        },
      );
    }
    const server = await this.serverFor(computer, context);
    if (server.status === "off") return;
    await this.client.stop(server.id, context.signal);
    await pollUntil(async () => (await this.serverFor(computer, context)).status === "off", {
      intervalMs: 1_000,
      timeoutMs: 60_000,
      signal: context.signal,
      waitingFor: "cloud computer shutdown",
    });
  }
  override async destroy(computer: ComputerRef, context: AdapterContext) {
    const ref = this.reference(computer.providerRef);
    const target = this.hibernateTarget(ref, computer.botId, context.spaceId);
    await this.hibernation?.destroy(target, context.signal);
    await this.remove(ref, context.signal);
  }
  async deleteMachine(machine: UnreferencedMachine, signal: AbortSignal) {
    const ref = this.reference(machine.machineId);
    if (!machine.homeKey || digest(machine.homeKey) !== ref.home)
      throw new Error("Cloud computer ownership mismatch");
    await this.remove(ref, signal, machine);
  }

  private hibernateTarget(ref: Reference, home: string, spaceId: string) {
    this.assertContext(ref, home, spaceId);
    return {
      labels: this.labels(ref),
      home,
      spaceId,
      connectionId: this.settings.connectionIdentity!,
    };
  }

  private async remove(ref: Reference, parent: AbortSignal, pending?: UnreferencedMachine) {
    const signal = deadlineSignal(60_000, parent);
    const server = pending?.providerResourceId
      ? await this.client.get(pending.providerResourceId, signal)
      : await this.findGeneration(ref, signal);
    if (!server) {
      if (pending && this.client.createWasRejected && !pending.providerResourceId)
        throw new Error(CREATE_UNCONFIRMED);
      return;
    }
    this.assertOwner(server, ref);
    if (pending && this.client.createWasRejected && !pending.providerResourceId)
      await requireUnreferencedMachineRecord(this.machines, this.observedMachine(pending, server));
    await this.client.delete(server.id, signal);
    await pollUntil(
      // Check the immutable id: renames and name reuse cannot confirm or obstruct deletion.
      async () => (await this.client.get(server.id, signal)) === null,
      { intervalMs: 1_000, timeoutMs: 60_000, signal, waitingFor: "cloud computer deletion" },
    );
  }

  private async pendingCreate(homeKey: string) {
    if (!this.client.createWasRejected) return undefined;
    const identity = this.settings.connectionIdentity;
    if (!identity || !this.machines?.pendingCreate)
      throw new Error("Computer provisioning requires durable create tracking");
    return this.machines.pendingCreate(this.providerKind, identity, homeKey);
  }

  private async findOwner(
    owner: Omit<Reference, "name" | "pin">,
    name: string,
    signal: AbortSignal,
  ) {
    return (
      (await this.client.find(name, signal)) ??
      this.client.findByLabels(
        {
          "rakazo-connection": owner.connection,
          "rakazo-home": owner.home,
          "rakazo-space": owner.space,
        },
        signal,
      )
    );
  }

  private async create(
    owner: Omit<Reference, "name" | "pin">,
    name: string,
    home: string,
    signal: AbortSignal,
  ) {
    const certificate = await runtimeCertificate();
    const ref = { ...owner, name, pin: certificate.fingerprint };
    const machine = this.machine(ref, home);
    const userData = computerCloudInit({
      appImage: this.settings.appImage!,
      computerImage: this.settings.computerImage!,
      homeKey: home,
      token: this.runtimeToken(home),
      ...certificate,
    });
    // A crash or timeout after submission leaves a certificate-bound receipt to reconcile.
    signal.throwIfAborted();
    await requireUnreferencedMachineRecord(this.machines, machine);
    if (signal.aborted && this.client.createWasRejected) {
      // This process is still here and knows that it has not submitted a request.
      await this.machines?.clear(machine);
      signal.throwIfAborted();
    }
    try {
      const server = await this.client.create({ name, labels: this.labels(ref), userData }, signal);
      this.assertOwner(server, ref);
      return server;
    } catch (error) {
      if (this.client.createWasRejected?.(error)) {
        await this.machines?.clear(machine);
        throw error;
      }
      const server = this.client.createWasRejected
        ? await this.findGeneration(ref, signal)
        : await this.client.find(name, signal);
      if (!server) {
        if (this.client.createWasRejected) throw new Error(CREATE_UNCONFIRMED);
        throw error;
      }
      if (server.labels["rakazo-cert"] !== ref.pin) {
        this.assertOwner(server, { ...ref, pin: server.labels["rakazo-cert"]! });
        await bestEffort(
          "clear a reconciled cloud create's cleanup",
          this.machines?.clear(machine),
        );
      }
      return server;
    }
  }

  private observedMachine(machine: UnreferencedMachine, server: CloudMachine): UnreferencedMachine {
    return { ...machine, providerResourceId: String(server.id) };
  }

  private machine(ref: Reference, homeKey: string): UnreferencedMachine {
    return {
      provider: this.providerKind,
      machineId: encode(ref),
      homeKey,
      providerConnectionId: this.settings.connectionIdentity,
      ...(this.client.createWasRejected && { requiresCreateReconciliation: true }),
    };
  }
  private labels(ref: Reference) {
    return {
      "rakazo-connection": ref.connection,
      "rakazo-home": ref.home,
      "rakazo-space": ref.space,
      "rakazo-cert": ref.pin,
    };
  }
  private findGeneration(ref: Reference, signal: AbortSignal) {
    return this.client.findByLabels(this.labels(ref), signal);
  }
  protected validateSettings() {
    for (const key of ["apiToken", "runtimeSecret", "connectionIdentity"])
      if (!this.settings[key]?.trim()) throw new Error(`Computer connection requires ${key}`);
    validateCloudImages(this.settings);
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
  private assertOwner(server: CloudMachine, ref: Reference, previous?: Reference) {
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
  private address(server: CloudMachine) {
    const ip = server.ipv4;
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
    let send = this.transports.get(pin);
    if (!send) {
      send = pinnedGatewayFetch(pin);
      this.transports.set(pin, send);
    }
    return send;
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
      { id: match[1]!, providerRef: match[1]!, botId: home, kind: this.providerKind },
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
    const server = await this.serverFor(computer, context);
    return gatewayScreenTransport(
      value,
      { origin: `https://${this.address(server)}` },
      this.runtimeToken(computer.botId),
      this.reference(computer.providerRef).pin,
    );
  }
}
