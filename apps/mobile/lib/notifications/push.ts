import { newClientId } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging/best-effort";
import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo-modules-core";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { currentApiBase, rpc, selectedSpaceId } from "../api/api";
import { currentSessionGeneration, loadSessionToken } from "../api/session";
import {
  pendingSessionTokens,
  retryPendingSessionRevocations,
} from "../auth/pending-session-revocations";
import { loadSavedAccounts } from "../auth/saved-accounts";
import { resumeLiveNotifications } from "./live-notifications";

async function notificationsAllowed() {
  // On iOS getPermissionsAsync holds Expo's shared native queue until the system answers,
  // which can take minutes after a restart, and SecureStore waits behind it. The request
  // does not hold the queue and only prompts while the user hasn't chosen yet.
  if (Platform.OS === "ios") return (await Notifications.requestPermissionsAsync()).granted;
  const existing = await Notifications.getPermissionsAsync();
  return existing.granted || (await Notifications.requestPermissionsAsync()).granted;
}

export async function registerPushToken() {
  const apiBase = currentApiBase();
  // Revocation retries also run when permission is denied; they need no new push token.
  await bestEffort("retry pending sign-outs", retryPendingSessionRevocations(apiBase));
  if (!(await notificationsAllowed())) return;
  try {
    const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    if (!token) return;
    const accounts = await loadSavedAccounts(apiBase);
    const pending = await pendingSessionTokens(apiBase);
    const generation = currentSessionGeneration();
    const selectedToken = apiBase === currentApiBase() ? await loadSessionToken() : "";
    if (generation !== currentSessionGeneration() || apiBase !== currentApiBase()) return;
    const activeToken = pending.has(selectedToken) ? "" : selectedToken;
    const liveTokens = new Set(accounts.map((account) => account.token));
    if (activeToken) liveTokens.add(activeToken);
    const senderModule =
      Platform.OS === "android"
        ? requireOptionalNativeModule<{
            supportsSenderAvatars?: boolean;
            supportsAccountScopedSenderNotifications?: boolean;
          }>("RakazoNotifications")
        : null;
    const supportsSender =
      senderModule?.supportsSenderAvatars &&
      (liveTokens.size <= 1 || senderModule.supportsAccountScopedSenderNotifications);
    const stillSignedIn = async (sessionToken: string) => {
      const saved = await loadSavedAccounts(apiBase);
      const owned =
        saved.some((account) => account.token === sessionToken) ||
        (apiBase === currentApiBase() && (await loadSessionToken()) === sessionToken);
      return owned && !(await pendingSessionTokens(apiBase)).has(sessionToken);
    };
    const register = async (sessionToken: string, userId?: string) => {
      const requestContext = {
        apiBase,
        headers: {
          authorization: `Bearer ${sessionToken}`,
          ...(userId ? { "x-rakazo-user-id": userId } : {}),
        },
      };
      if (!(await stillSignedIn(sessionToken))) return;
      let nativeSession = false;
      if (sessionToken === activeToken) {
        nativeSession = await resumeLiveNotifications(
          apiBase,
          sessionToken,
          selectedSpaceId() ?? "",
        );
        if (!(await stillSignedIn(sessionToken))) return;
      }
      try {
        await rpc(
          "notifications/registerPush",
          {
            token,
            ...(Platform.OS === "android" && nativeSession && supportsSender
              ? { presentation: "android_sender" as const }
              : {}),
          },
          { requestContext },
        );
      } finally {
        // A register response can arrive after sign-out's unregister. Remove only
        // this login's late association, retaining its queued session revocation.
        if (!(await stillSignedIn(sessionToken)))
          await bestEffort(
            "unregister late push association",
            rpc("notifications/unregisterPush", undefined, { requestContext }),
          );
      }
    };
    const registering = accounts.map((account) =>
      bestEffort("register saved account for push", register(account.token, account.userId)),
    );
    if (activeToken && !accounts.some((account) => account.token === activeToken)) {
      registering.push(bestEffort("register active account for push", register(activeToken)));
    }
    await Promise.all(registering);
    if (generation === currentSessionGeneration() && apiBase === currentApiBase())
      await registerCallPushToken({ expoToken: token });
  } catch {
    // Expo Go without an EAS project id and Android builds without a Firebase config
    // cannot mint an Expo push token.
  }
}

export async function unregisterPushToken() {
  await rpc("notifications/unregisterPush").catch(() => undefined);
}

let callTokens: { expoToken?: string; voipToken?: string } = {};
let tokenGeneration = -1;
let registeredKey: string | undefined;
let deviceIdPromise: Promise<string> | undefined;
async function installationId() {
  deviceIdPromise ??= (async () => {
    const stored = await SecureStore.getItemAsync("rakazo.call-device");
    if (stored) return stored;
    const id = newClientId();
    await SecureStore.setItemAsync("rakazo.call-device", id);
    return id;
  })();
  const pending = deviceIdPromise;
  try {
    return await pending;
  } catch (error) {
    if (deviceIdPromise === pending) deviceIdPromise = undefined;
    throw error;
  }
}
/** Builds without native call handling keep the account's ordinary push for incoming calls. */
const nativeCalls = Boolean(
  requireOptionalNativeModule<{ incomingState?: unknown }>("RakazoNotifications")?.incomingState,
);

export async function registerCallPushToken(tokens: { expoToken?: string; voipToken?: string }) {
  if (!nativeCalls) return;
  const generation = currentSessionGeneration();
  if (generation !== tokenGeneration) {
    callTokens = {};
    registeredKey = undefined;
    tokenGeneration = generation;
  }
  const registration = { ...callTokens, ...tokens };
  const key = JSON.stringify(registration);
  if (key === registeredKey) return;
  callTokens = registration;
  const deviceId = await installationId();
  if (generation !== currentSessionGeneration()) return;
  if (Platform.OS !== "ios" && Platform.OS !== "android") return;
  await rpc("notifications/registerCallPush", { deviceId, platform: Platform.OS, ...registration });
  if (generation === currentSessionGeneration()) registeredKey = key;
}
