import type { PrismaClient } from "@rakazo/db";
import { countUnreadInboxChats, runAsSystem, withTransactionRetry } from "@rakazo/db";
import { credentialDigest } from "./credential-digest.js";
import { EncryptedSecretStore } from "./secrets.js";

export interface PushRecord {
  token: string;
  sessionId?: string;
  presentation?: "android_sender";
}

export type CallPushRegistration = {
  deviceId: string;
  platform: "ios" | "android";
  expoToken?: string;
  voipToken?: string;
};
export type CallPushDevice = CallPushRegistration & {
  userId: string;
  sessionId: string;
  revision: string;
};

/** A login registers its device independently of other accounts and devices. */
export interface PushTokenStore {
  saveDevice?(userId: string, registration: CallPushRegistration, sessionId: string): Promise<void>;
  devices?(userId: string): Promise<CallPushDevice[]>;
  removeDevice?(
    userId: string,
    deviceId: string,
    revision: string,
    transport?: "voip" | "expo",
  ): Promise<void>;
  load(userId: string): Promise<PushRecord | undefined>;
  list(userId: string): Promise<PushRecord[]>;
  save(
    userId: string,
    token: string,
    sessionId: string,
    presentation?: "android_sender",
  ): Promise<void>;
  /** Import only when neither the account nor the device is registered already. */
  importLegacy(userId: string, token: string, sessionId: string): Promise<boolean>;
  remove(userId: string, tokenDigest?: string): Promise<void>;
  endSession(userId: string, sessionId: string, nextSessionId?: string): Promise<void>;
}

export class PushSessionEndedError extends Error {
  constructor() {
    super("Push session ended");
  }
}

export class PrismaPushTokenStore implements PushTokenStore {
  private readonly encryption: EncryptedSecretStore;

  constructor(
    private readonly prisma: PrismaClient,
    encryptionKey: string,
  ) {
    this.encryption = new EncryptedSecretStore(encryptionKey);
  }

  async saveDevice(
    userId: string,
    registration: CallPushRegistration,
    sessionId: string,
  ): Promise<void> {
    const id = credentialDigest(registration.deviceId);
    await runAsSystem("register a call notification device", () =>
      withTransactionRetry(() =>
        this.prisma.$transaction(async (tx) => {
          const locks = [`push-user:${userId}`, `push-device:${id}`];
          if (registration.expoToken)
            locks.push(`push-expo:${credentialDigest(registration.expoToken)}`);
          if (registration.voipToken)
            locks.push(`push-voip:${credentialDigest(registration.voipToken)}`);
          for (const lock of locks.sort())
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))::text`;
          const sessions = await tx.$queryRaw<
            Array<{ id: string }>
          >`SELECT id FROM "session" WHERE id = ${sessionId} AND "userId" = ${userId} AND "expiresAt" > CURRENT_TIMESTAMP FOR UPDATE`;
          if (!sessions.length) throw new PushSessionEndedError();
          const existing = await tx.callPushDevice.findUnique({ where: { id } });
          const previous =
            existing?.userId === userId
              ? (JSON.parse(
                  await this.encryption.load(existing.ciphertext, `call-push:${id}`),
                ) as CallPushRegistration)
              : undefined;
          const merged = { ...previous, ...registration };
          const sealed = await this.encryption.put(
            JSON.stringify(merged),
            {
              operationId: "push.register",
              traceId: "push.register",
              spaceId: "",
              userId,
              signal: new AbortController().signal,
            },
            { recordId: `call-push:${id}` },
          );
          const expoTokenDigest = merged.expoToken ? credentialDigest(merged.expoToken) : null;
          const voipTokenDigest = merged.voipToken ? credentialDigest(merged.voipToken) : null;
          // One physical push token has one owner, even after reinstall or account handover.
          const duplicates = [
            ...(expoTokenDigest ? [{ expoTokenDigest }] : []),
            ...(voipTokenDigest ? [{ voipTokenDigest }] : []),
          ];
          if (duplicates.length)
            await tx.callPushDevice.deleteMany({ where: { id: { not: id }, OR: duplicates } });
          const data = {
            userId,
            sessionId,
            ciphertext: sealed.ciphertext,
            expoTokenDigest,
            voipTokenDigest,
          };
          await tx.callPushDevice.upsert({ where: { id }, create: { id, ...data }, update: data });
        }),
      ),
    );
  }

  async devices(userId: string): Promise<CallPushDevice[]> {
    return runAsSystem("load the call owner's devices", async () => {
      const rows = await this.prisma.callPushDevice.findMany({ where: { userId } });
      return Promise.all(
        rows.map(async (row) => ({
          ...(JSON.parse(
            await this.encryption.load(row.ciphertext, `call-push:${row.id}`),
          ) as CallPushRegistration),
          userId,
          sessionId: row.sessionId,
          revision: row.ciphertext,
        })),
      );
    });
  }

  async removeDevice(
    userId: string,
    deviceId: string,
    revision: string,
    transport?: "voip" | "expo",
  ): Promise<void> {
    const id = credentialDigest(deviceId);
    const failed = JSON.parse(
      await this.encryption.load(revision, `call-push:${id}`),
    ) as CallPushRegistration;
    await runAsSystem("remove an invalid call notification token", () =>
      withTransactionRetry(() =>
        this.prisma.$transaction(async (tx) => {
          // Serialized with registration: concurrent invalidations each apply to the latest row.
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`push-device:${id}`}, 0))::text`;
          const row = await tx.callPushDevice.findUnique({ where: { id } });
          if (row?.userId !== userId) return;
          const registration =
            row.ciphertext === revision
              ? { ...failed }
              : (JSON.parse(
                  await this.encryption.load(row.ciphertext, `call-push:${id}`),
                ) as CallPushRegistration);
          // Only the token that actually failed goes; a newer one registered meanwhile stays.
          if (transport !== "expo" && registration.voipToken === failed.voipToken)
            delete registration.voipToken;
          if (transport !== "voip" && registration.expoToken === failed.expoToken)
            delete registration.expoToken;
          if (!registration.voipToken && !registration.expoToken) {
            await tx.callPushDevice.deleteMany({ where: { id, userId } });
            return;
          }
          const sealed = await this.encryption.put(
            JSON.stringify(registration),
            {
              operationId: "push.invalidate",
              traceId: "push.invalidate",
              spaceId: "",
              userId,
              signal: new AbortController().signal,
            },
            { recordId: `call-push:${id}` },
          );
          await tx.callPushDevice.updateMany({
            where: { id, userId },
            data: {
              ciphertext: sealed.ciphertext,
              voipTokenDigest: registration.voipToken
                ? credentialDigest(registration.voipToken)
                : null,
              expoTokenDigest: registration.expoToken
                ? credentialDigest(registration.expoToken)
                : null,
            },
          });
        }),
      ),
    );
  }

  async load(userId: string): Promise<PushRecord | undefined> {
    return (await this.list(userId))[0];
  }

  async list(userId: string): Promise<PushRecord[]> {
    return runAsSystem("load an account's notification devices", async () => {
      const [rows, legacy] = await Promise.all([
        this.prisma.pushRegistration.findMany({ where: { userId } }),
        this.prisma.pushToken.findUnique({ where: { userId } }),
      ]);
      // Older instances may rotate a legacy registration during the deployment overlap.
      // Prefer the most recent registration for that login, never a different account.
      if (legacy) {
        const index = rows.findIndex((row) => row.sessionId === legacy.sessionId);
        if (index < 0) rows.push(legacy);
        else if (rows[index]!.updatedAt < legacy.updatedAt) rows[index] = legacy;
      }
      return Promise.all(
        rows.map(async (row) => ({
          token: await this.encryption.load(row.ciphertext, `push-token:${userId}`),
          sessionId: row.sessionId,
          ...(row.presentation === "android_sender"
            ? { presentation: "android_sender" as const }
            : {}),
        })),
      );
    });
  }

  async save(
    userId: string,
    token: string,
    sessionId: string,
    presentation?: "android_sender",
  ): Promise<void> {
    await this.register(userId, token, sessionId, "register", presentation);
  }

  /** The icon counts all valid accounts on this device, rather than the last sender. */
  async deviceForToken(token: string): Promise<{ badge: number; accounts: number }> {
    return runAsSystem("count unread chats for a notification device", async () => {
      const tokenDigest = credentialDigest(token);
      const rows = [
        ...(await this.prisma.pushRegistration.findMany({
          where: { tokenDigest },
          select: { userId: true, sessionId: true },
        })),
        ...(await this.prisma.pushToken.findMany({
          where: { tokenDigest },
          select: { userId: true, sessionId: true },
        })),
      ];
      if (!rows.length) return { badge: 0, accounts: 0 };
      const sessions = await this.prisma.session.findMany({
        where: {
          expiresAt: { gt: new Date() },
          OR: rows.map((row) => ({ id: row.sessionId, userId: row.userId })),
        },
        select: { userId: true },
      });
      const users = [...new Set(sessions.map((session) => session.userId))];
      const counts = await Promise.all(
        users.map((userId) => countUnreadInboxChats(this.prisma, { userId })),
      );
      return { badge: counts.reduce((sum, count) => sum + count, 0), accounts: users.length };
    });
  }

  importLegacy(userId: string, token: string, sessionId: string): Promise<boolean> {
    return this.register(userId, token, sessionId, "import");
  }

  private async register(
    userId: string,
    token: string,
    sessionId: string,
    mode: "register" | "import",
    presentation?: "android_sender",
  ): Promise<boolean> {
    const value = token.trim();
    if (!value) throw new Error("Push token is empty");
    const tokenDigest = credentialDigest(value);
    const sealed = await this.encryption.put(
      value,
      {
        operationId: "push.register",
        traceId: "push.register",
        spaceId: "",
        userId,
        signal: new AbortController().signal,
      },
      { recordId: `push-token:${userId}` },
    );
    return runAsSystem("register or import a notification device", () =>
      withTransactionRetry(() =>
        this.prisma.$transaction(async (tx) => {
          // Both account removal and registration acquire the same account lock.
          // Device locking is needed only to keep weaker legacy imports from claiming it.
          for (const key of [`push-user:${userId}`, `push-token:${tokenDigest}`].sort())
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
          if (mode === "import") {
            const where = { OR: [{ userId }, { tokenDigest }] };
            if (
              (await tx.pushRegistration.findFirst({ where })) ||
              (await tx.pushToken.findFirst({ where }))
            )
              return false;
          }
          // A late request authenticated before logout cannot recreate a registration.
          const sessions = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "session" WHERE id = ${sessionId} AND "userId" = ${userId}
          AND "expiresAt" > CURRENT_TIMESTAMP FOR UPDATE`;
          if (!sessions.length) throw new PushSessionEndedError();
          const data = {
            ciphertext: sealed.ciphertext,
            tokenDigest,
            presentation: presentation ?? null,
          };
          await tx.pushRegistration.upsert({
            where: { userId_sessionId: { userId, sessionId } },
            create: { userId, sessionId, ...data },
            update: data,
          });
          // Keep single-account delivery working in old workers during the rolling upgrade.
          // The old schema can project only one owner for a shared token; never evict it.
          const legacyOwner = await tx.pushToken.findUnique({
            where: { tokenDigest },
            select: { userId: true },
          });
          if (!legacyOwner || legacyOwner.userId === userId) {
            await tx.pushToken.upsert({
              where: { userId },
              create: { userId, sessionId, ...data },
              update: { sessionId, ...data },
            });
          } else {
            // A rotated login must not fall back to a token it no longer registered.
            await tx.pushToken.deleteMany({ where: { userId, sessionId } });
          }
          return true;
        }),
      ),
    );
  }

  async remove(userId: string, tokenDigest?: string): Promise<void> {
    await runAsSystem("remove an account's notification registration", () =>
      withTransactionRetry(() =>
        this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`push-user:${userId}`}, 0))::text`;
          const where = { userId, ...(tokenDigest ? { tokenDigest } : {}) };
          await tx.pushRegistration.deleteMany({ where });
          await tx.pushToken.deleteMany({ where });
        }),
      ),
    );
  }

  async endSession(userId: string, sessionId: string, nextSessionId?: string): Promise<void> {
    await runAsSystem("revoke or retarget a login's notification devices", () =>
      withTransactionRetry(() =>
        this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`push-user:${userId}`}, 0))::text`;
          const where = { userId, sessionId };
          const next =
            nextSessionId &&
            (await tx.session.findFirst({
              where: { id: nextSessionId, userId, expiresAt: { gt: new Date() } },
              select: { id: true },
            }));
          if (next) {
            const old = await tx.pushRegistration.findUnique({
              where: { userId_sessionId: where },
            });
            if (old) {
              await tx.pushRegistration.upsert({
                where: { userId_sessionId: { userId, sessionId: next.id } },
                create: { ...old, sessionId: next.id },
                update: {},
              });
            }
            await tx.callPushDevice.updateMany({ where, data: { sessionId: next.id } });
            await tx.pushToken.updateMany({ where, data: { sessionId: next.id } });
          } else {
            await tx.callPushDevice.deleteMany({ where });
            await tx.pushToken.deleteMany({ where });
          }
          await tx.pushRegistration.deleteMany({ where });
        }),
      ),
    );
  }
}
