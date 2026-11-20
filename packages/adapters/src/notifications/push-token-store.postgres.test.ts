import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { deferred } from "@rakazo/core/test-async";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { credentialDigest } from "../secrets/credential-digest.js";
import { PrismaPushTokenStore, PushSessionEndedError } from "./push-token-store.js";

const suite = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;
suite("database push registrations", () => {
  let a: ReturnType<typeof createDb>;
  let b: ReturnType<typeof createDb>;
  let api: PrismaPushTokenStore;
  let worker: PrismaPushTokenStore;
  let legacyAvailable = false;
  const prefix = `push-fixture-${randomUUID()}`;
  const user = (id: string) => `${prefix}-${id}`;
  const session = (id: string) => `${prefix}-session-${id}`;
  const token = (id: string) => `ExponentPushToken[${prefix}-${id}]`;
  beforeAll(async () => {
    a = createDb(process.env.DATABASE_URL!);
    b = createDb(process.env.DATABASE_URL!);
    api = new PrismaPushTokenStore(a.prisma, "offline-push-encryption-key");
    worker = new PrismaPushTokenStore(b.prisma, "offline-push-encryption-key");
    const [legacy] = await runAsSystem(
      "inspect previous-release table availability",
      () =>
        a.prisma.$queryRaw<Array<{ present: boolean }>>`
        SELECT to_regclass('push_tokens') IS NOT NULL AS present`,
    );
    legacyAvailable = legacy?.present ?? false;
    await runAsSystem("seed push registration fixtures", async () => {
      for (const id of ["a", "b", "c"]) {
        await a.prisma.user.create({
          data: { id: user(id), name: "Fixture", email: `${user(id)}@example.invalid` },
        });
        await a.prisma.session.create({
          data: {
            id: session(id),
            token: session(id),
            userId: user(id),
            expiresAt: new Date(Date.now() + 3600_000),
          },
        });
      }
      await a.prisma.session.create({
        data: {
          id: session("a2"),
          token: session("a2"),
          userId: user("a"),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
    });
  });
  beforeEach(async () => {
    await runAsSystem("clear fixture push registrations", async () => {
      if (legacyAvailable)
        await a.prisma.$executeRaw`DELETE FROM "push_tokens" WHERE "userId" LIKE ${`${prefix}%`}`;
      await a.prisma.pushRegistration.deleteMany({ where: { userId: { startsWith: prefix } } });
    });
  });
  afterAll(async () => {
    if (!a) return;
    await runAsSystem("remove push registration fixtures", () =>
      a.prisma.user.deleteMany({ where: { id: { startsWith: prefix } } }),
    );
    await Promise.all([a.pool.end(), b.pool.end()]);
  });

  it("shares encrypted registrations across independent connections and restricts row access", async () => {
    await api.save(user("a"), token("a"), session("a"));
    expect(await worker.list(user("a"))).toEqual([{ token: token("a"), sessionId: session("a") }]);
    const row = await runAsSystem("inspect fixture ciphertext", () =>
      a.prisma.pushRegistration.findFirstOrThrow({ where: { userId: user("a") } }),
    );
    expect(row.ciphertext).not.toContain(token("a"));
    expect(row.tokenDigest).toBe(credentialDigest(token("a")));
    await runAsTenant({ userId: user("b"), spaceId: "unused" }, async () => {
      expect(await a.prisma.pushRegistration.findMany()).toEqual([]);
    });
  });

  it("keeps the native presentation capability across replicas and clears it on legacy registration", async () => {
    await api.save(user("a"), token("a"), session("a"), "android_sender");
    expect((await worker.list(user("a")))[0]?.presentation).toBe("android_sender");
    await api.save(user("a"), token("a"), session("a"));
    expect((await worker.list(user("a")))[0]?.presentation).toBeUndefined();
  });

  it("retains every account when the same device registers concurrently", async () => {
    await Promise.all([
      api.save(user("a"), token("shared"), session("a")),
      worker.save(user("b"), token("shared"), session("b")),
      api.save(user("c"), token("shared"), session("c")),
    ]);
    const registrations = await Promise.all([
      api.list(user("a")),
      worker.list(user("b")),
      api.list(user("c")),
    ]);
    expect(registrations.flat()).toHaveLength(3);
  });

  it("keeps newer registrations when an old receipt or logout arrives", async () => {
    await api.save(user("a"), token("a"), session("a"));
    await worker.save(user("a"), token("new"), session("a2"));
    await api.remove(user("a"), credentialDigest(token("a")));
    await api.endSession(user("a"), session("a"));
    expect((await worker.list(user("a")))[0]?.token).toBe(token("new"));
    await api.remove(user("a"), credentialDigest(token("new")));
    expect(await worker.list(user("a"))).toEqual([]);
  });

  it("keeps every device an account signs in on and signs each out on its own", async () => {
    await api.save(user("a"), token("phone"), session("a"));
    await worker.save(user("a"), token("tablet"), session("a2"));
    const tokens = async () => (await api.list(user("a"))).map((row) => row.token).sort();
    expect(await tokens()).toEqual([token("phone"), token("tablet")].sort());
    await worker.endSession(user("a"), session("a"));
    expect(await api.list(user("a"))).toEqual([
      { token: token("tablet"), sessionId: session("a2") },
    ]);
  });

  it("replaces a device's rotated token instead of pushing to both", async () => {
    await api.save(user("a"), token("phone"), session("a"));
    await worker.save(user("a"), token("tablet"), session("a2"));
    await api.save(user("a"), token("phone-rotated"), session("a"));
    expect((await api.list(user("a"))).map((row) => row.token).sort()).toEqual(
      [token("phone-rotated"), token("tablet")].sort(),
    );
  });

  it("retargets only the replaced session while another account keeps the shared device", async () => {
    await api.save(user("a"), token("shared"), session("a"));
    await worker.endSession(user("a"), session("a"), session("a2"));
    await api.endSession(user("a"), session("a"));
    expect((await worker.list(user("a")))[0]?.sessionId).toBe(session("a2"));
    await worker.save(user("b"), token("shared"), session("b"));
    await api.endSession(user("a"), session("a2"), session("a"));
    expect((await api.list(user("a")))[0]?.sessionId).toBe(session("a"));
    expect((await worker.list(user("b")))[0]?.token).toBe(token("shared"));
  });

  it("imports only unclaimed devices and accounts, including concurrent imports", async () => {
    await api.save(user("b"), token("owned"), session("b"));
    expect(await worker.importLegacy(user("a"), token("owned"), session("a"))).toBe(false);
    expect(await worker.list(user("a"))).toEqual([]);
    expect((await api.list(user("b")))[0]?.token).toBe(token("owned"));
    expect(await worker.importLegacy(user("b"), token("stale"), session("b"))).toBe(false);
    expect((await api.list(user("b")))[0]?.token).toBe(token("owned"));
    const imported = await Promise.all([
      api.importLegacy(user("a"), token("unclaimed"), session("a")),
      worker.importLegacy(user("c"), token("unclaimed"), session("c")),
    ]);
    expect(imported.filter(Boolean)).toHaveLength(1);
  });

  it("retains authenticated registration in a race with legacy import", async () => {
    await Promise.all([
      api.importLegacy(user("a"), token("racing"), session("a")),
      worker.save(user("b"), token("racing"), session("b")),
    ]);
    expect((await worker.list(user("b")))[0]?.token).toBe(token("racing"));
  });

  it("aggregates the device badge across live accounts and ignores other devices", async () => {
    const organizations: string[] = [];
    try {
      await runAsSystem("seed unread device badge fixtures", async () => {
        for (const id of ["a", "b", "c"]) {
          const organizationId = `${prefix}-badge-${id}`;
          organizations.push(organizationId);
          await a.prisma.organization.create({
            data: {
              id: organizationId,
              name: "Fixture",
              slug: organizationId,
              createdAt: new Date(),
            },
          });
          await a.prisma.member.create({
            data: {
              id: randomUUID(),
              organizationId,
              userId: user(id),
              role: "member",
              createdAt: new Date(),
            },
          });
          const space = await a.prisma.space.create({
            data: { id: randomUUID(), organizationId, name: "Fixture" },
          });
          await a.prisma.spaceMember.create({
            data: {
              id: randomUUID(),
              organizationId,
              spaceId: space.id,
              userId: user(id),
              createdAt: new Date(),
            },
          });
          const bot = await a.prisma.bot.create({
            data: {
              spaceId: space.id,
              userId: user(id),
              name: "Fixture",
              color: "blue",
              thread: { create: { spaceId: space.id, userId: user(id) } },
            },
            include: { thread: true },
          });
          await a.prisma.threadRead.create({
            data: { threadId: bot.thread!.id, spaceId: space.id, userId: user(id), unread: true },
          });
        }
      });
      await api.save(user("a"), token("shared"), session("a"));
      await api.save(user("b"), token("shared"), session("b"));
      await api.save(user("c"), token("other-device"), session("c"));
      expect(await worker.deviceForToken(token("shared"))).toEqual({ badge: 2, accounts: 2 });
      await api.endSession(user("b"), session("b"));
      expect(await worker.deviceForToken(token("shared"))).toEqual({ badge: 1, accounts: 1 });
    } finally {
      await runAsSystem("remove unread device badge fixtures", () =>
        a.prisma.organization.deleteMany({ where: { id: { in: organizations } } }),
      );
    }
  });

  it("keeps a replacement login's newer registration on session retarget", async () => {
    await api.save(user("a"), token("old"), session("a"));
    await api.save(user("a"), token("new"), session("a2"));
    await worker.endSession(user("a"), session("a"), session("a2"));
    expect(await api.list(user("a"))).toEqual([{ token: token("new"), sessionId: session("a2") }]);
  });

  async function projectLegacy(account: string, login: string, removeRegistration = false) {
    const row = await a.prisma.pushRegistration.findUniqueOrThrow({
      where: { userId_sessionId: { userId: user(account), sessionId: session(login) } },
    });
    if (removeRegistration)
      await a.prisma.pushRegistration.deleteMany({
        where: { userId: row.userId, sessionId: row.sessionId },
      });
    await a.prisma.$executeRaw`
      INSERT INTO "push_tokens" ("userId", "sessionId", "ciphertext", "tokenDigest", "presentation", "updatedAt")
        VALUES (${row.userId}, ${row.sessionId}, ${row.ciphertext}, ${row.tokenDigest}, ${row.presentation}, ${row.updatedAt})
        ON CONFLICT ("userId") DO UPDATE SET "sessionId" = EXCLUDED."sessionId",
          "ciphertext" = EXCLUDED."ciphertext", "tokenDigest" = EXCLUDED."tokenDigest",
          "presentation" = EXCLUDED."presentation", "updatedAt" = EXCLUDED."updatedAt"`;
  }

  it("mirrors old API inserts and rotations without replacing another login", async ({ skip }) => {
    if (!legacyAvailable) skip();
    await api.save(user("a"), token("phone"), session("a"));
    await api.save(user("a"), token("tablet"), session("a2"), "android_sender");
    await runAsSystem("write through only the previous API", () => projectLegacy("a", "a", true));
    expect((await worker.list(user("a"))).map((row) => row.token).sort()).toEqual(
      [token("phone"), token("tablet")].sort(),
    );
    await api.save(user("a"), token("rotated"), session("a"), "android_sender");
    const rotated = await runAsSystem("capture a fixture's sealed replacement token", () =>
      a.prisma.pushRegistration.findUniqueOrThrow({
        where: { userId_sessionId: { userId: user("a"), sessionId: session("a") } },
      }),
    );
    await api.save(user("a"), token("phone"), session("a"));
    await runAsSystem(
      "rotate through only the previous API",
      () =>
        a.prisma.$executeRaw`UPDATE "push_tokens" SET "ciphertext" = ${rotated.ciphertext},
        "tokenDigest" = ${rotated.tokenDigest}, "presentation" = ${rotated.presentation},
        "updatedAt" = ${rotated.updatedAt} WHERE "userId" = ${user("a")}`,
    );
    expect((await worker.list(user("a"))).map((row) => row.token).sort()).toEqual(
      [token("rotated"), token("tablet")].sort(),
    );
    await runAsSystem(
      "unregister through the previous API",
      () => a.prisma.$executeRaw`DELETE FROM "push_tokens" WHERE "userId" = ${user("a")}`,
    );
    expect(await worker.list(user("a"))).toEqual([
      { token: token("tablet"), sessionId: session("a2"), presentation: "android_sender" },
    ]);
  });

  it("keeps both saved accounts when an old API transfers a legacy token", async ({ skip }) => {
    if (!legacyAvailable) skip();
    await api.save(user("a"), token("shared"), session("a"));
    await api.save(user("b"), token("shared"), session("b"));
    await runAsSystem("seed legacy shared token", () => projectLegacy("a", "a"));
    await runAsSystem("transfer the legacy token", () =>
      a.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`DELETE FROM "push_tokens" WHERE "userId" = ${user("a")}`;
        const row = await tx.pushRegistration.findUniqueOrThrow({
          where: { userId_sessionId: { userId: user("b"), sessionId: session("b") } },
        });
        await tx.$executeRaw`
        INSERT INTO "push_tokens" ("userId", "sessionId", "ciphertext", "tokenDigest", "presentation", "updatedAt")
          VALUES (${row.userId}, ${row.sessionId}, ${row.ciphertext}, ${row.tokenDigest}, ${row.presentation}, ${row.updatedAt})`;
      }),
    );
    expect((await worker.list(user("a")))[0]?.token).toBe(token("shared"));
    expect((await worker.list(user("b")))[0]?.token).toBe(token("shared"));
  });

  it("does not overwrite an existing replacement login through old session retargeting", async ({
    skip,
  }) => {
    if (!legacyAvailable) skip();
    await api.save(user("a"), token("old"), session("a"));
    await api.save(user("a"), token("new"), session("a2"));
    await runAsSystem("seed legacy login", () => projectLegacy("a", "a"));
    await runAsSystem(
      "retarget the old login",
      () =>
        a.prisma.$executeRaw`UPDATE "push_tokens" SET "sessionId" = ${session("a2")}
        WHERE "userId" = ${user("a")}`,
    );
    expect(await worker.list(user("a"))).toEqual([
      { token: token("new"), sessionId: session("a2") },
    ]);
  });

  it("rejects expired, missing and another account's sessions without stealing tokens", async () => {
    await api.save(user("a"), token("shared"), session("a"));
    for (const invalid of [session("missing"), session("a")])
      await expect(worker.save(user("b"), token("shared"), invalid)).rejects.toBeInstanceOf(
        PushSessionEndedError,
      );
    await runAsSystem("expire fixture session", () =>
      a.prisma.session.update({ where: { id: session("c") }, data: { expiresAt: new Date(0) } }),
    );
    await expect(worker.save(user("c"), token("shared"), session("c"))).rejects.toBeInstanceOf(
      PushSessionEndedError,
    );
    expect((await api.list(user("a")))[0]?.token).toBe(token("shared"));
  });

  it("does not publish a registration after a concurrent session deletion commits", async () => {
    const ready = deferred();
    const hold = deferred();
    const deletion = runAsSystem("delete fixture session concurrently", () =>
      a.prisma.$transaction(async (tx) => {
        await tx.session.delete({ where: { id: session("a2") } });
        ready.resolve();
        await hold.promise;
      }),
    );
    await ready.promise;
    const registering = worker.save(user("a"), token("late"), session("a2"));
    // Attach rejection handling before releasing the blocked registration.
    const rejected = expect(registering).rejects.toBeInstanceOf(PushSessionEndedError);
    hold.resolve();
    await deletion;
    await rejected;
    expect(await api.list(user("a"))).toEqual([]);
  });

  it("removes a handed-over or unregistered device from the table the previous release sends from", async () => {
    const migration = (name: string) =>
      readFileSync(
        new URL(`../../../db/prisma/migrations/${name}/migration.sql`, import.meta.url),
        "utf8",
      );
    const previous = migration("20261226120000_push_registrations");
    const owner = createDb(process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL!);
    const legacy = async () =>
      (
        await owner.pool.query<{ userId: string }>(
          'SELECT "userId" FROM "push_tokens" WHERE "userId" LIKE $1 ORDER BY "userId"',
          [`${prefix}%`],
        )
      ).rows.map((row) => row.userId);
    const sendFromPreviousRelease = async (id: string, device: string) => {
      const row = await runAsSystem("read fixture registration", () =>
        a.prisma.pushRegistration.findFirstOrThrow({
          where: { userId: user(id), tokenDigest: credentialDigest(token(device)) },
        }),
      );
      await owner.pool.query(
        'INSERT INTO "push_tokens" ("userId", "ciphertext", "tokenDigest", "sessionId", "updatedAt") VALUES ($1, $2, $3, $4, now())',
        [row.userId, row.ciphertext, row.tokenDigest, row.sessionId],
      );
    };
    try {
      // The database as the previous release left it, partway through the deploy.
      await owner.pool.query(`
        CREATE TABLE "push_tokens" (
          "userId" TEXT NOT NULL PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
          "ciphertext" TEXT NOT NULL,
          "tokenDigest" TEXT NOT NULL UNIQUE,
          "sessionId" TEXT NOT NULL,
          "updatedAt" TIMESTAMP(3) NOT NULL,
          "presentation" TEXT
        );
        GRANT SELECT, INSERT, UPDATE, DELETE ON "push_tokens" TO PUBLIC;
        ${previous.slice(previous.indexOf("CREATE FUNCTION push_tokens_mirror"))}
        ${migration("20261231130000_push_registrations_unmirror")}`);

      await api.save(user("a"), token("shared"), session("a"));
      await sendFromPreviousRelease("a", "shared");
      expect(await legacy()).toEqual([user("a")]);
      expect(await api.list(user("a"))).toHaveLength(1);

      await worker.save(user("b"), token("shared"), session("b"));
      expect(await legacy()).toEqual([]);
      await sendFromPreviousRelease("b", "shared");
      expect(await legacy()).toEqual([user("b")]);
      await api.remove(user("b"), credentialDigest(token("shared")));
      expect(await legacy()).toEqual([]);
    } finally {
      await owner.pool.query(`
        DROP TRIGGER IF EXISTS push_registrations_unmirror ON "push_registrations";
        DROP FUNCTION IF EXISTS push_registrations_unmirror();
        DROP TABLE IF EXISTS "push_tokens";
        DROP FUNCTION IF EXISTS push_tokens_mirror();`);
      await owner.pool.end();
    }
  });
});
