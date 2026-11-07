import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("./live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => true),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./network-cache.js", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-constants", () => ({ default: { easConfig: { projectId: "fake-project" } } }));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: vi.fn(() => null) }));

// Expo runs every module's async functions on one serial native queue, so a call
// that waits there holds up SecureStore too.
const native = vi.hoisted(() => {
  let queue: Promise<unknown> = Promise.resolve();
  const run = <T>(work: () => T | Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  };
  const store = new Map<string, string>();
  return {
    run,
    store,
    reset() {
      queue = Promise.resolve();
      store.clear();
    },
  };
});

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn((key: string) => native.run(() => native.store.get(key) ?? null)),
  setItemAsync: vi.fn((key: string, value: string) =>
    native.run(() => void native.store.set(key, value)),
  ),
  deleteItemAsync: vi.fn((key: string) => native.run(() => void native.store.delete(key))),
}));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getExpoPushTokenAsync: vi.fn(async () => ({ data: "ExponentPushToken[fake]" })),
}));

import { requireOptionalNativeModule } from "expo-modules-core";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { currentApiBase, rpc } from "./api";
import { signOut } from "./api-auth";
import { selectInitialSpace } from "./api-server";
import { resumeLiveNotifications, stopLiveNotifications } from "./live-notifications.js";
import {
  pendingSessionTokens,
  queueSessionRevocation,
  retryPendingSessionRevocations,
} from "./pending-session-revocations";
import { registerPushToken } from "./push";
import { rememberSavedAccount } from "./saved-accounts";
import * as session from "./session";
import { restoreSessionToken } from "./session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const settled = <T>(promise: Promise<T>) =>
  Promise.race([promise, new Promise((done) => setTimeout(done, 100, "still waiting"))]);

const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
  const json = url.endsWith("/rpc/me")
    ? { userId: "user-1", spaceId: "space-1" }
    : url.endsWith("/rpc/spaces/list")
      ? { current: { id: "space-1", bots: [{ id: "bot-1" }] }, spaces: [] }
      : {};
  return new Response(JSON.stringify({ json }), { status: 200 });
});

let permission: ReturnType<typeof deferred<{ granted: boolean }>>;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  native.reset();
  vi.mocked(requireOptionalNativeModule).mockReturnValue(null);
  vi.stubGlobal("fetch", fetch);
  permission = deferred();
  // iOS answers both from the system's notification settings, which can take minutes
  // after a restart. Reading them waits on the native queue; the request does not.
  vi.mocked(Notifications.getPermissionsAsync).mockImplementation(() =>
    native.run(() => new Promise(() => {})),
  );
  vi.mocked(Notifications.requestPermissionsAsync).mockImplementation(
    () => native.run(() => undefined).then(() => permission.promise) as never,
  );
  await restoreSessionToken("fake-session");
});

afterEach(() => {
  Platform.OS = "ios";
  vi.unstubAllGlobals();
});

describe("push registration on iOS", () => {
  it("loads the inbox while notification settings have not answered", async () => {
    void registerPushToken();

    // The inbox's first load: the space list and account, then the default space.
    const loaded = Promise.all([rpc("spaces/list"), rpc("me")]).then(async ([, me]) =>
      selectInitialSpace(me.spaceId),
    );

    await expect(settled(loaded)).resolves.toBe(true);
  });

  it("registers the token once permission is granted", async () => {
    void registerPushToken();
    await settled(Promise.resolve());
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringMatching(/notifications\/registerPush$/),
      expect.anything(),
    );

    permission.resolve({ granted: true });

    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringMatching(/notifications\/registerPush$/),
        expect.objectContaining({
          body: JSON.stringify({ json: { token: "ExponentPushToken[fake]" } }),
        }),
      ),
    );
  });
});

describe("push registration on Android", () => {
  it("does not ask again once notifications are allowed", async () => {
    Platform.OS = "android";
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);

    await registerPushToken();

    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/notifications\/registerPush$/),
      expect.anything(),
    );
  });
});

it("registers one device token independently for every saved signed-in account", async () => {
  for (const userId of ["family", "work"])
    await rememberSavedAccount(currentApiBase(), {
      userId,
      token: `${userId}-token`,
      email: `${userId}@example.test`,
    });
  await restoreSessionToken("family-token");
  permission.resolve({ granted: true });
  await registerPushToken();
  const registrations = fetch.mock.calls.filter(([url]) =>
    url.endsWith("/rpc/notifications/registerPush"),
  );
  expect(registrations).toHaveLength(2);
  expect(
    registrations
      .map(([, init]) => (init as RequestInit).headers)
      .map((headers) => (headers as Record<string, string>).authorization)
      .sort(),
  ).toEqual(["Bearer family-token", "Bearer work-token"]);
});

it("does not register a locally signed-out credential while its revocation retry is failing", async () => {
  await queueSessionRevocation(currentApiBase(), "fake-session");
  // The fixture's generic successful HTTP reply is not an acknowledged auth sign-out.
  permission.resolve({ granted: true });
  await registerPushToken();
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/api/auth/sign-out"))).toBe(true);
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/notifications/registerPush"))).toBe(false);
});

it.each([false, true])(
  "cleans up a registration after local sign-out, retaining retries when cleanup is offline (%s)",
  async (cleanupOffline) => {
    const apiBase = currentApiBase();
    for (const userId of ["family", "work"]) {
      await rememberSavedAccount(apiBase, {
        userId,
        token: `${userId}-token`,
        email: `${userId}@example.test`,
      });
    }
    await restoreSessionToken("family-token");
    const started = deferred<void>();
    const late = deferred<void>();
    const bindings = new Set(["family-token", "work-token"]);
    const unregisters: string[] = [];
    let offline = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const credential = (new Headers(init?.headers).get("authorization") ?? "").replace(
          /^Bearer /,
          "",
        );
        if (url.endsWith("/notifications/registerPush")) {
          if (credential === "family-token") {
            started.resolve();
            await late.promise;
          }
          bindings.add(credential);
        }
        if (url.endsWith("/notifications/unregisterPush")) {
          unregisters.push(credential);
          if (cleanupOffline) throw new Error("offline cleanup");
          bindings.delete(credential);
        }
        if (url.endsWith("/api/auth/sign-out")) {
          if (offline) throw new Error("offline revocation");
          bindings.delete(credential);
          return Response.json({ success: true });
        }
        return Response.json({ json: {} });
      }),
    );
    permission.resolve({ granted: true });
    const registering = registerPushToken();
    await started.promise;
    await signOut();
    expect(native.store.has("rakazo.session_token")).toBe(false);
    await restoreSessionToken("work-token");
    late.resolve();
    await registering;
    expect(bindings).toEqual(
      new Set(cleanupOffline ? ["family-token", "work-token"] : ["work-token"]),
    );
    expect(unregisters).toEqual(["family-token"]);
    expect(await pendingSessionTokens(apiBase)).toEqual(new Set(["family-token"]));
    offline = false;
    await retryPendingSessionRevocations(apiBase);
    expect(bindings).toEqual(new Set(["work-token"]));
    expect(await pendingSessionTokens(apiBase)).toEqual(new Set());
  },
);
it("syncs the native session before the server can push", async () => {
  Platform.OS = "android";
  vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);
  const resumed = deferred<boolean>();
  vi.mocked(resumeLiveNotifications).mockReturnValueOnce(resumed.promise);

  const registration = registerPushToken();
  try {
    await vi.waitFor(() =>
      expect(resumeLiveNotifications).toHaveBeenCalledExactlyOnceWith(
        "http://127.0.0.1:3100",
        "fake-session",
        expect.any(String),
      ),
    );
    await expect(settled(registration)).resolves.toBe("still waiting");
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    resumed.resolve(true);
    await registration;
  }
  expect(fetch).toHaveBeenCalledWith(
    expect.stringMatching(/notifications\/registerPush$/),
    expect.anything(),
  );
});

it("does not restore a signed-out session while push registration loads its token", async () => {
  Platform.OS = "android";
  vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);
  const loaded = deferred<void>();
  const release = deferred<void>();
  const loadToken = session.loadSessionToken;
  vi.spyOn(session, "loadSessionToken").mockImplementationOnce(async () => {
    const token = await loadToken();
    loaded.resolve();
    await release.promise;
    return token;
  });

  const registration = registerPushToken();
  try {
    await loaded.promise;
    await signOut();
    expect(stopLiveNotifications).toHaveBeenCalledWith(true);
    expect(native.store.has("rakazo.session_token")).toBe(false);
  } finally {
    release.resolve();
    await registration;
  }

  expect(resumeLiveNotifications).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalledWith(
    expect.stringMatching(/notifications\/registerPush$/),
    expect.anything(),
  );
});

it("does not register the push token when the native session sync fails", async () => {
  Platform.OS = "android";
  vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);
  vi.mocked(resumeLiveNotifications).mockRejectedValueOnce(new Error("native sync failed"));

  await registerPushToken();

  // Registering now would have Android drop every push as signed-out; the next
  // registration attempt retries the session sync first.
  expect(fetch).not.toHaveBeenCalledWith(
    expect.stringMatching(/notifications\/registerPush$/),
    expect.anything(),
  );
});

it("does not register push while a sign-in has not saved its token yet", async () => {
  Platform.OS = "android";
  vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);
  vi.spyOn(session, "loadSessionToken").mockResolvedValueOnce("");

  await registerPushToken();

  expect(resumeLiveNotifications).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalledWith(
    expect.stringMatching(/notifications\/registerPush$/),
    expect.anything(),
  );
});

it("registers native sender delivery only when the installed Android module supports it", async () => {
  Platform.OS = "android";
  vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);
  vi.mocked(requireOptionalNativeModule).mockReturnValue({ supportsSenderAvatars: true });
  await registerPushToken();
  const call = fetch.mock.calls.find(([url]) => url.endsWith("/rpc/notifications/registerPush"));
  const options = (call as unknown as [string, RequestInit])[1];
  expect(JSON.parse(String(options.body)).json).toMatchObject({ presentation: "android_sender" });
});

it.each([
  { accountScoped: false, signedOutSecond: false, sender: false },
  { accountScoped: true, signedOutSecond: false, sender: true },
  { accountScoped: false, signedOutSecond: true, sender: true },
])(
  "keeps multi-account sender delivery compatible with installed Android builds ($accountScoped, $signedOutSecond)",
  async ({ accountScoped, signedOutSecond, sender }) => {
    Platform.OS = "android";
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);
    // Older released binaries already advertise avatars, but cannot route or clear
    // sender notifications by owner. Only the new capability makes that safe.
    vi.mocked(requireOptionalNativeModule).mockReturnValue({
      supportsSenderAvatars: true,
      ...(accountScoped ? { supportsAccountScopedSenderNotifications: true } : {}),
    });
    for (const userId of ["family", "work"])
      await rememberSavedAccount(currentApiBase(), {
        userId,
        token: `${userId}-token`,
        email: `${userId}@example.test`,
      });
    await restoreSessionToken("family-token");
    if (signedOutSecond) await queueSessionRevocation(currentApiBase(), "work-token");

    await registerPushToken();

    const registrations = fetch.mock.calls
      .filter(([url]) => url.endsWith("/rpc/notifications/registerPush"))
      .map(([, init]) => ({
        credential: new Headers(init?.headers).get("authorization"),
        payload: JSON.parse(String(init?.body)).json,
      }));
    const active = registrations.find(({ credential }) => credential === "Bearer family-token");
    expect(active).toBeDefined();
    if (sender) expect(active?.payload).toHaveProperty("presentation", "android_sender");
    else expect(active?.payload).not.toHaveProperty("presentation");
    const other = registrations.find(({ credential }) => credential === "Bearer work-token");
    if (signedOutSecond) expect(other).toBeUndefined();
    else {
      expect(other).toBeDefined();
      expect(other?.payload).not.toHaveProperty("presentation");
    }
  },
);

it("registers plain delivery when the native module does not keep the session", async () => {
  Platform.OS = "android";
  vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);
  vi.mocked(requireOptionalNativeModule).mockReturnValue({ supportsSenderAvatars: true });
  // A public http server: native notifications skip it and store no session.
  vi.mocked(resumeLiveNotifications).mockResolvedValueOnce(false);
  await registerPushToken();
  const call = fetch.mock.calls.find(([url]) => url.endsWith("/rpc/notifications/registerPush"));
  const options = (call as unknown as [string, RequestInit])[1];
  // Sender delivery would drop every push as signed out; plain pushes are still shown.
  expect(JSON.parse(String(options.body)).json).not.toHaveProperty("presentation");
});
