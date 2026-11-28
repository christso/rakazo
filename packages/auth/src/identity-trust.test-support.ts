import { createHmac } from "node:crypto";
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { bootstrapUserSpace } from "@rakazo/db";
import { vi } from "vitest";
import type { AuthEnv } from "./index.js";
import { createAuth } from "./index.js";

export function fixture({
  allowlist = "",
  delivery = true,
  baseURL = "http://auth.example.test",
  webOrigin = "http://web.example.test",
  requestOrigin,
  stalledDelivery = false,
  ...hooks
}: {
  allowlist?: string;
  delivery?: boolean;
  baseURL?: string;
  webOrigin?: string;
  requestOrigin?: string;
  /** The provider accepts the message but never settles, like a hung SMTP connection. */
  stalledDelivery?: boolean;
} & Pick<
  AuthEnv,
  | "admitsSignup"
  | "afterDeleteSession"
  | "afterReplaceSession"
  | "beforeDeleteUser"
  | "afterDeleteUser"
  | "analytics"
  | "partnerProgram"
> = {}) {
  const data: Record<string, Record<string, unknown>[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
    passkey: [],
  };
  const policy: {
    signupsEnabled: boolean;
    signupAllowlist: string;
    signupPolicyInitialized: boolean;
    ownerUserId: string | null;
  } = {
    signupsEnabled: true,
    signupAllowlist: allowlist,
    signupPolicyInitialized: true,
    ownerUserId: null,
  };
  const messages: TransactionalEmail[] = [];
  const members = new Set<string>();
  const prisma = {
    authData: data,
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(
      async (run: ((tx: typeof prisma) => Promise<unknown>) | Promise<unknown>[]) =>
        Array.isArray(run) ? Promise.all(run) : run(prisma),
    ),
    deploymentSettings: {
      findUnique: vi.fn(async () => policy),
      updateMany: vi.fn(async ({ data: patch }: { data: { ownerUserId: string } }) => {
        if (policy.ownerUserId !== null) return { count: 0 };
        policy.ownerUserId = patch.ownerUserId;
        return { count: 1 };
      }),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; email?: string } }) => {
        const user = data.user!.find((row) => row.id === where.id || row.email === where.email);
        return user ? { locale: user.locale ?? null } : null;
      }),
      findMany: vi.fn(async ({ where }: { where?: { id?: { not?: string } } } = {}) =>
        data
          .user!.filter(
            (user) =>
              user.id !== where?.id?.not &&
              !String(user.email).toLowerCase().endsWith("@messaging.invalid"),
          )
          .slice(0, 2)
          .map((user) => ({ id: String(user.id) })),
      ),
      findFirst: vi.fn(async ({ where }: { where?: { id?: { not?: string } } }) => {
        const excluded = where?.id?.not;
        const other = data.user!.find(
          (user) =>
            (excluded === undefined || user.id !== excluded) &&
            !String(user.email).toLowerCase().endsWith("@messaging.invalid"),
        );
        return other ? { id: String(other.id) } : null;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data: patch,
        }: {
          where: { id: string };
          data: { emailVerified: boolean };
        }) => {
          const user = data.user!.find((item) => item.id === where.id);
          if (!user) return { count: 0 };
          Object.assign(user, patch);
          return { count: 1 };
        },
      ),
    },
    member: { findMany: vi.fn(async () => []) },
    messagingIdentity: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    pageApp: { deleteMany: vi.fn(async () => ({ count: 0 })), updateMany: vi.fn(async () => ({ count: 0 })) },
    messagingLinkCode: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    account: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    userDevice: { updateMany: vi.fn(async () => ({ count: 0 })) },
    passkey: {
      deleteMany: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const rows = data.passkey!;
        const kept = rows.filter((row) => row.userId !== where.userId);
        const count = rows.length - kept.length;
        rows.splice(0, rows.length, ...kept);
        return { count };
      }),
    },
    organization: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    spaceMember: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string | { in: string[] } } }) => {
        const ids = typeof where.userId === "string" ? [where.userId] : where.userId.in;
        const userId = ids.find((id) => members.has(id));
        return userId ? { spaceId: "space-1", userId } : null;
      }),
    },
  };
  vi.mocked(bootstrapUserSpace).mockImplementation(async (_prisma, user) => {
    members.add(user.id);
    return { spaceId: "space-1" };
  });
  const secret = "offline-auth-secret-at-least-32-characters";
  const auth = createAuth(prisma as never, {
    ...hooks,
    secret,
    baseURL,
    webOrigin,
    get signupsEnabled() {
      return String(policy.signupsEnabled);
    },
    get signupAllowlist() {
      return policy.signupAllowlist;
    },
    email: delivery
      ? {
          describe: () => ({
            id: "offline-email",
            contractVersion: "1",
            adapterVersion: "1",
            capabilities: { transactional: true },
          }),
          send: (message) => {
            messages.push(message);
            return stalledDelivery ? new Promise<void>(() => undefined) : Promise.resolve();
          },
        }
      : undefined,
  });
  const request = (path: string, body?: unknown, token?: string) =>
    auth.handler(
      new Request(`${baseURL}/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          origin: requestOrigin ?? webOrigin,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  const signup = (email = "approved@example.test") =>
    request("/sign-up/email", {
      email,
      password: "offline-password12",
      name: "Test User",
      emailVerified: true,
      id: "msg-attacker-chosen-id",
    });
  const signin = (email = "approved@example.test") =>
    request("/sign-in/email", {
      email,
      password: "offline-password12",
    });
  const verify = () => {
    const url = new URL(messages.at(-1)!.text.match(/http:\/\/\S+/)![0]);
    return request(`${url.pathname.replace("/api/auth", "")}${url.search}`);
  };
  const sendCode = (email = "approved@example.test", type = "sign-in") =>
    request("/email-otp/send-verification-otp", { email, type });
  const lastCode = () => messages.at(-1)!.text.match(/\b\d{6}\b/)![0];
  const codeSignIn = (otp: string, email = "approved@example.test") =>
    request("/sign-in/email-otp", { email, otp, name: "Code User" });
  /** An unverified account and session created before email delivery was configured. */
  const legacyAccount = async (email = "approved@example.test") => {
    const now = new Date();
    const id = `legacy-${data.user!.length}`;
    data.user!.push({
      id,
      name: "Legacy",
      email,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    data.account!.push({
      id: `account-${id}`,
      userId: id,
      providerId: "credential",
      accountId: id,
      password: await (await auth.$context).password.hash("offline-password12"),
      createdAt: now,
      updatedAt: now,
    });
    const token = `legacy-session-token-${id}`;
    data.session!.push({
      id: `session-${id}`,
      token,
      userId: id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      createdAt: now,
      updatedAt: now,
    });
    members.add(id);
    // Clients hold the signed form the session cookie and `set-auth-token` carry.
    const signature = createHmac("sha256", secret).update(token).digest("base64");
    return { id, token: `${token}.${signature}` };
  };
  const sessionFor = (token: string) =>
    auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
  return {
    auth,
    request,
    signup,
    signin,
    verify,
    sendCode,
    lastCode,
    codeSignIn,
    legacyAccount,
    sessionFor,
    prisma,
    data,
    policy,
    messages,
    members,
  };
}
