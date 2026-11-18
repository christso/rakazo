import { randomUUID } from "node:crypto";
import { machineCleanupJob, machineCleanupJobKey } from "@rakazo/adapter-kit";
import {
  bindSpaceComputerConnection,
  computerProviderDescriptor,
  createDeadJobPruner,
  EncryptedSecretStore,
  finishSpaceComputerConnectionCleanup,
  GraphileJobPublisher,
  loadComputerConnection,
  prepareSpaceComputerConnectionCleanup,
  provisionSpaceComputer,
} from "@rakazo/adapters";
import type { Actor, ComputerProviderUpdate } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ComputerProviderConfigDeps } from "./computer-provider-config.js";
import {
  getSpaceComputerSettings,
  updateSpaceComputerSettings,
} from "./space-computer-provider-config.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL && process.env.DATABASE_MIGRATION_URL
    ? describe
    : describe.skip;
const values = {
  desktopId: "ecd-test",
  endUserId: "test-user",
  mcpUrl: "https://gateway.example.test/mcp",
  accessKeyId: "test-id",
  accessKeySecret: "test-secret",
  mcpToken: "test-token",
};

describePostgres("Space computer connections (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let deps: ComputerProviderConfigDeps;
  let system: ReturnType<typeof asSystem<ReturnType<typeof createDb>["prisma"]>>;
  const suffix = randomUUID();
  const org = `org-${suffix}`;
  const otherOrg = `other-${suffix}`;
  const space = `space-${suffix}`;
  const sibling = `sibling-${suffix}`;
  const outside = `outside-${suffix}`;
  const userIds = ["owner", "member", "admin", "outsider"].map((role) => `${role}-${suffix}`);
  const actor = (role: number, spaceId = space): Actor => ({
    userId: userIds[role]!,
    spaceId,
    email: `${role}@example.test`,
    isDeploymentOwner: false,
  });
  const asActor = <T>(who: Actor, work: () => Promise<T>) => runAsTenant(who, work);
  const save = async (
    who = actor(0),
    input: ComputerProviderUpdate = { provider: "desktop", values },
  ) => {
    const shown = await load(who);
    return asActor(who, () =>
      updateSpaceComputerSettings(deps, who, {
        ...input,
        expectedConnectionId:
          input.expectedConnectionId === undefined
            ? (shown.connectionId ?? null)
            : input.expectedConnectionId,
      }),
    );
  };
  const load = (who: Actor) => asActor(who, () => getSpaceComputerSettings(deps, who));

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    system = asSystem(db.prisma);
    for (const id of userIds)
      await system.user.create({
        data: { id, name: "Test", email: `${id}@example.test`, emailVerified: true },
      });
    for (const id of [org, otherOrg])
      await system.organization.create({
        data: { id, name: "Test", slug: id, createdAt: new Date() },
      });
    for (const [i, userId] of userIds.entries())
      await system.member.create({
        data: {
          id: `${userId}-member`,
          userId,
          organizationId: i === 3 ? otherOrg : org,
          role: ["owner", "member", "admin", "owner"][i]!,
          createdAt: new Date(),
        },
      });
    for (const id of [space, sibling, outside])
      await system.space.create({
        data: { id, name: "Test", organizationId: id === outside ? otherOrg : org },
      });
    for (const [i, userId] of userIds.entries())
      await system.spaceMember.create({
        data: {
          id: `${userId}-sm`,
          userId,
          organizationId: i === 3 ? otherOrg : org,
          spaceId: i === 3 ? outside : space,
          role: i === 0 || i === 3 ? "owner" : "member",
          createdAt: new Date(),
        },
      });
    await system.spaceMember.create({
      data: {
        id: `sibling-${suffix}-sm`,
        userId: userIds[0]!,
        organizationId: org,
        spaceId: sibling,
        role: "owner",
        createdAt: new Date(),
      },
    });
    deps = {
      prisma: db.prisma,
      secrets: new EncryptedSecretStore("test-only-encryption-key"),
      jobs: { enqueue: vi.fn(), enqueueIn: vi.fn(), cancel: vi.fn(), cancelIn: vi.fn() },
      sandbox: { describe: () => ({ id: "test" }) } as ComputerProviderConfigDeps["sandbox"],
      env: { sandboxProvider: "test", adminEmails: [], computerSettingsEnabled: true },
      resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
      verifyConnection: vi.fn(async () => undefined),
    };
  });

  afterAll(async () => {
    if (!db) return;
    await system.computer.deleteMany({ where: { spaceId: { in: [space, sibling, outside] } } });
    await system.organization.deleteMany({ where: { id: { in: [org, otherOrg] } } });
    await system.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("allows owners and organization admins, hides controls from members and rejects other organizations", async () => {
    await save();
    expect((await load(actor(1))).providers).toEqual([]);
    await expect(save(actor(1))).rejects.toThrow("Only the Space owner");
    await expect(save(actor(3))).rejects.toThrow("Space unavailable");
    expect((await save(actor(2))).connectionId).toBeTruthy();
    expect(await system.computerConnection.count({ where: { spaceId: outside } })).toBe(0);
  });

  it("seals secrets against the connection id, redacts them and ignores undeclared routing identity", async () => {
    const result = await save(actor(0), {
      provider: "desktop",
      values: { ...values, connectionIdentity: "forged" },
    });
    const row = await system.computerConnection.findUniqueOrThrow({
      where: { id: result.connectionId },
    });
    expect(row.ciphertext).not.toContain(values.accessKeySecret);
    expect(JSON.stringify(result)).not.toContain(values.accessKeySecret);
    expect(result.savedSecrets.accessKeySecret).toBe(true);
    const plaintext = await deps.secrets.load(row.ciphertext, row.id);
    expect(JSON.parse(plaintext).values).not.toHaveProperty("connectionIdentity");
    await expect(deps.secrets.load(row.ciphertext, "another-id")).rejects.toThrow();
  });

  it("requires explicit spending approval before verification and records who approved", async () => {
    const descriptor = computerProviderDescriptor("desktop");
    descriptor.capabilities.requiresSpendingApproval = true;
    try {
      const before = await system.computerConnection.count({ where: { spaceId: space } });
      await expect(save()).rejects.toThrow("Approve resource costs");
      expect(await system.computerConnection.count({ where: { spaceId: space } })).toBe(before);
      const who = actor(2);
      const expectedConnectionId = (await load(who)).connectionId ?? null;
      const result = await asActor(who, () =>
        updateSpaceComputerSettings(deps, who, {
          provider: "desktop",
          values,
          approveSpending: true,
          expectedConnectionId,
        }),
      );
      const row = await system.computerConnection.findUniqueOrThrow({
        where: { id: result.connectionId },
      });
      expect(row.spendingApprovedBy).toBe(who.userId);
      expect(row.spendingApprovedAt).toBeInstanceOf(Date);
    } finally {
      delete descriptor.capabilities.requiresSpendingApproval;
    }
  });

  it("rejects a stale approval before loading or merging another account's saved secrets", async () => {
    const descriptor = computerProviderDescriptor("desktop");
    descriptor.capabilities.requiresSpendingApproval = true;
    try {
      const first = await save(actor(0), {
        provider: "desktop",
        values: { ...values, accessKeySecret: "first-account-key" },
        approveSpending: true,
      });
      const changed = await save(actor(2), {
        provider: "desktop",
        values: { ...values, accessKeySecret: "second-account-key" },
        approveSpending: true,
      });
      const loads = vi.spyOn(deps.secrets, "load");
      const puts = vi.spyOn(deps.secrets, "put");
      loads.mockClear();
      puts.mockClear();
      vi.mocked(deps.verifyConnection!).mockClear();
      const stale = {
        provider: "desktop",
        values: { desktopId: "owner-edit", endUserId: values.endUserId, mcpUrl: values.mcpUrl },
        approveSpending: true,
        expectedConnectionId: first.connectionId!,
      };
      await expect(
        asActor(actor(0), () => updateSpaceComputerSettings(deps, actor(0), stale)),
      ).rejects.toMatchObject({ kind: "CONFLICT" });
      expect(loads).not.toHaveBeenCalled();
      expect(puts).not.toHaveBeenCalled();
      expect(deps.verifyConnection).not.toHaveBeenCalled();
      expect((await load(actor(0))).connectionId).toBe(changed.connectionId);
      expect(
        await system.computerConnection.findUnique({ where: { id: first.connectionId } }),
      ).not.toBeNull();
    } finally {
      delete descriptor.capabilities.requiresSpendingApproval;
      vi.restoreAllMocks();
    }
  });

  it("rejects a connection changed while verification is in flight without recording stale approval", async () => {
    const descriptor = computerProviderDescriptor("desktop");
    descriptor.capabilities.requiresSpendingApproval = true;
    const entered = deferred();
    const held = deferred();
    const previousVerifier = deps.verifyConnection;
    try {
      const first = await save(actor(0), { provider: "desktop", values, approveSpending: true });
      const before = await system.computerConnection.count({ where: { spaceId: space } });
      deps.verifyConnection = vi.fn(async (settings) => {
        if (settings.values.desktopId === "waiting-owner") {
          entered.resolve();
          await held.promise;
        }
      });
      const pending = asActor(actor(0), () =>
        updateSpaceComputerSettings(deps, actor(0), {
          provider: "desktop",
          values: {
            desktopId: "waiting-owner",
            endUserId: values.endUserId,
            mcpUrl: values.mcpUrl,
          },
          approveSpending: true,
          expectedConnectionId: first.connectionId!,
        }),
      );
      const outcome = pending.then(
        () => null,
        (error) => error,
      );
      await Promise.race([entered.promise, pending]);
      const winner = await save(actor(2), {
        provider: "desktop",
        values: { ...values, accessKeySecret: "admin-account-key" },
        approveSpending: true,
      });
      held.resolve();
      expect(await outcome).toMatchObject({ kind: "CONFLICT" });
      expect((await load(actor(0))).connectionId).toBe(winner.connectionId);
      expect(await system.computerConnection.count({ where: { spaceId: space } })).toBe(before + 1);
      expect(
        (await system.computerConnection.findUniqueOrThrow({ where: { id: winner.connectionId } }))
          .spendingApprovedBy,
      ).toBe(actor(2).userId);
    } finally {
      held.resolve();
      deps.verifyConnection = previousVerifier;
      delete descriptor.capabilities.requiresSpendingApproval;
    }
  });

  it("compares default and explicit connection versions, treating an omitted expectation as default", async () => {
    const active = await save();
    for (const expectedConnectionId of [null, undefined, "old-connection"]) {
      await expect(
        asActor(actor(0), () =>
          updateSpaceComputerSettings(deps, actor(0), {
            provider: "default",
            values: {},
            expectedConnectionId,
          }),
        ),
      ).rejects.toMatchObject({ kind: "CONFLICT" });
    }
    await save(actor(2), {
      provider: "default",
      values: {},
      expectedConnectionId: active.connectionId,
    });
    await expect(
      asActor(actor(0), () =>
        updateSpaceComputerSettings(deps, actor(0), {
          provider: "desktop",
          values,
          expectedConnectionId: active.connectionId,
        }),
      ),
    ).rejects.toMatchObject({ kind: "CONFLICT" });
    const configured = await asActor(actor(0), () =>
      updateSpaceComputerSettings(deps, actor(0), { provider: "desktop", values }),
    );
    expect(configured.connectionId).toBeTruthy();
  });

  it("retains the original binding through selection changes and fallback, including a crashed start", async () => {
    const first = await save();
    const homeKey = `home-${suffix}`;
    const computer = await system.computer.create({
      data: {
        spaceId: space,
        userId: userIds[0]!,
        scopeKey: homeKey,
        homeKey,
        kind: "desktop",
        providerConnectionPinned: false,
      },
    });
    expect(await bindSpaceComputerConnection(db.prisma, homeKey)).toBe(first.connectionId);
    const second = await save(actor(0), {
      provider: "desktop",
      values: { ...values, desktopId: "ecd-second" },
    });
    expect(second.connectionId).not.toBe(first.connectionId);
    await save(actor(0), { provider: "default", values: {} });
    expect(await bindSpaceComputerConnection(db.prisma, homeKey)).toBe(first.connectionId);
    const original = await loadComputerConnection(
      db.prisma,
      deps.secrets,
      first.connectionId!,
      homeKey,
    );
    expect(original.values.desktopId).toBe("ecd-test");
    await system.computer.delete({ where: { id: computer.id } });
  });

  it.each([false, true])(
    "binding preserves an active lifecycle fence (existing reference=%s)",
    async (existingReference) => {
      const selected = await save();
      const homeKey = `fenced-${existingReference}-${suffix}`;
      const claimStamp = new Date("2024-01-01T00:00:00.000Z");
      const computer = await system.computer.create({
        data: {
          spaceId: space,
          userId: userIds[0]!,
          scopeKey: homeKey,
          homeKey,
          kind: "desktop",
          providerConnectionPinned: false,
          state: "booting",
          updatedAt: claimStamp,
          providerRef: existingReference ? "existing-machine" : null,
        },
      });
      try {
        expect(await bindSpaceComputerConnection(db.prisma, homeKey)).toBe(
          existingReference ? null : selected.connectionId,
        );
        const activated = await system.computer.updateMany({
          where: { id: computer.id, state: "booting", updatedAt: claimStamp },
          data: { state: "running" },
        });
        expect(activated.count).toBe(1);
      } finally {
        await system.computer.delete({ where: { id: computer.id } });
      }
    },
  );

  it("enforces Space RLS and foreign keys even for same-organization connections", async () => {
    const first = await save();
    const other = await save(actor(0, sibling));
    expect(
      await asActor(actor(0), () =>
        db.prisma.computerConnection.findUnique({ where: { id: other.connectionId } }),
      ),
    ).toBeNull();
    await expect(
      system.space.update({
        where: { id: space },
        data: { computerConnectionId: other.connectionId },
      }),
    ).rejects.toThrow();
    const key = `cross-${suffix}`;
    await system.computer.create({
      data: {
        spaceId: space,
        userId: userIds[0]!,
        scopeKey: key,
        homeKey: key,
        kind: "desktop",
        providerConnectionId: first.connectionId,
      },
    });
    await expect(
      loadComputerConnection(db.prisma, deps.secrets, other.connectionId!, key),
    ).rejects.toThrow("Computer connection unavailable");
    await expect(
      system.computer.update({
        where: { homeKey: key },
        data: { providerConnectionId: other.connectionId },
      }),
    ).rejects.toThrow();
    await system.computer.delete({ where: { homeKey: key } });
  });

  it("does not bind an existing machine to a newly selected connection", async () => {
    await save();
    const homeKey = `legacy-${suffix}`;
    await system.computer.create({
      data: {
        spaceId: space,
        userId: userIds[0]!,
        scopeKey: homeKey,
        homeKey,
        kind: "test",
        providerRef: "existing-machine",
      },
    });
    expect(await bindSpaceComputerConnection(db.prisma, homeKey)).toBeNull();
    await system.computer.delete({ where: { homeKey } });
  });

  it("preserves a stopped legacy computer whose ephemeral provider cleared its reference", async () => {
    await save();
    const homeKey = `legacy-stopped-${suffix}`;
    await system.computer.create({
      data: {
        spaceId: space,
        userId: userIds[0]!,
        scopeKey: homeKey,
        homeKey,
        kind: "test",
        providerRef: null,
        providerConnectionPinned: true,
        homeRevision: "saved-home",
      },
    });
    expect(await bindSpaceComputerConnection(db.prisma, homeKey)).toBeNull();
    const row = await system.computer.findUniqueOrThrow({ where: { homeKey } });
    expect(row.providerConnectionId).toBeNull();
    await system.computer.delete({ where: { homeKey } });
  });

  it("keeps credentials through an in-flight provision and refuses a new start after deletion is claimed", async () => {
    const selected = await save();
    const homeKey = `inflight-${suffix}`;
    const computer = await system.computer.create({
      data: {
        spaceId: space,
        userId: userIds[0]!,
        scopeKey: homeKey,
        homeKey,
        kind: "desktop",
        providerConnectionId: selected.connectionId!,
        state: "booting",
      },
    });
    const entered = deferred();
    const held = deferred();
    const context = {
      operationId: "start",
      traceId: "start",
      spaceId: space,
      userId: userIds[0]!,
      signal: new AbortController().signal,
    };
    const provider = vi.fn(async () => {
      entered.resolve();
      await held.promise;
      return { id: "machine", providerRef: "machine", kind: "desktop", botId: homeKey };
    });
    const starting = provisionSpaceComputer(
      db.prisma,
      selected.connectionId!,
      homeKey,
      context,
      provider,
    );
    try {
      await Promise.race([entered.promise, starting]);
      await expect(
        asActor(actor(0), () => prepareSpaceComputerConnectionCleanup(deps, space)),
      ).rejects.toThrow("Computer cleanup");
      expect(
        await system.computerConnection.findUnique({ where: { id: selected.connectionId } }),
      ).not.toBeNull();
      await system.space.update({ where: { id: space }, data: { deletingAt: new Date() } });
      held.resolve();
      await starting;
      await expect(
        provisionSpaceComputer(db.prisma, selected.connectionId!, homeKey, context, provider),
      ).rejects.toThrow("Space is being deleted");
      expect(provider).toHaveBeenCalledOnce();
    } finally {
      held.resolve();
      await starting;
      await system.space.update({ where: { id: space }, data: { deletingAt: null } });
      await system.computer.delete({ where: { id: computer.id } });
    }
  });

  it("retains exhausted connection cleanup beyond ordinary queue pruning", async () => {
    const selected = await save();
    const jobs = new GraphileJobPublisher(db.pool, db.prisma);
    const machine = {
      provider: "desktop",
      providerConnectionId: selected.connectionId!,
      machineId: `exhausted-${suffix}`,
    };
    const key = machineCleanupJobKey(
      machine.provider,
      machine.machineId,
      machine.providerConnectionId,
    );
    const legacyKey = `${key}:legacy`;
    try {
      await jobs.enqueue(machineCleanupJob(machine, new Date()));
      await jobs.enqueue({
        ...machineCleanupJob({ provider: "desktop", machineId: "legacy" }, new Date()),
        replaceKey: legacyKey,
      });
      await db.pool.query(
        `UPDATE graphile_worker._private_jobs SET attempts=max_attempts, run_at=now()-interval '30 days', updated_at=now()-interval '30 days' WHERE key=ANY($1::text[])`,
        [[key, legacyKey]],
      );
      await createDeadJobPruner(db.pool)();
      expect(
        (
          await db.pool.query(
            "SELECT key FROM graphile_worker._private_jobs WHERE key=ANY($1::text[])",
            [[key, legacyKey]],
          )
        ).rows,
      ).toEqual([{ key }]);
      await expect(
        asActor(actor(0), () => prepareSpaceComputerConnectionCleanup(deps, space)),
      ).rejects.toThrow("Computer cleanup");
    } finally {
      await jobs.cancel(key);
      await jobs.cancel(legacyKey);
      await jobs.close();
    }
  });

  it("writes cleanup before Space teardown and preserves credentials while the Space survives", async () => {
    const deleted = vi.fn(async () => undefined);
    const cleanupDeps = { ...deps, secrets: { delete: deleted, isRemote: () => true } };
    const cleanups = await asActor(actor(0), () =>
      prepareSpaceComputerConnectionCleanup(cleanupDeps, space),
    );
    expect(cleanups.length).toBeGreaterThan(0);
    await finishSpaceComputerConnectionCleanup(cleanupDeps, cleanups);
    expect(deleted).not.toHaveBeenCalled();
    await system.space.delete({ where: { id: space } });
    await finishSpaceComputerConnectionCleanup(cleanupDeps, cleanups);
    expect(deleted).toHaveBeenCalledTimes(cleanups.length);
  });
});

vi.mock(
  "../../../../packages/adapters/src/computers/computer-provider-registry.js",
  () => import("@rakazo/adapters/test-computer-settings"),
);
