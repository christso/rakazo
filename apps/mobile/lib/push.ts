import { newClientId } from "@rakazo/core";
import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo-modules-core";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { currentApiBase, flushPendingSignOut, loadSessionToken, rpc, selectedSpaceId } from "./api";
import { resumeLiveNotifications } from "./live-notifications";
import { pendingSessionTokens } from "./pending-session-revocations";
import { loadSavedAccounts } from "./saved-accounts";
import { currentSessionGeneration } from "./session";

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
  const signingOut = await pendingSessionTokens(apiBase);
  // Revocation retries also run when permission is denied; they need no new push token.
  await flushPendingSignOut(true).catch(() => undefined);
  if (!(await notificationsAllowed())) return;
  try {
    const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    if (!token) return;
    const generation = currentSessionGeneration();
    const selectedToken = await loadSessionToken();
    if (generation !== currentSessionGeneration() || apiBase !== currentApiBase()) return;
    const accounts = await loadSavedAccounts(apiBase);
    const pending = await pendingSessionTokens(apiBase);
    const activeToken =
      pending.has(selectedToken) || signingOut.has(selectedToken) ? "" : selectedToken;
    // Only the selected login controls the Android poller; other saved accounts get
    // ordinary pushes so they can still alert while another account is selected.
    let nativeSession = false;
    if (activeToken) {
      try {
        nativeSession = await resumeLiveNotifications(
          apiBase,
          activeToken,
          selectedSpaceId() ?? "",
        );
      } catch {
        return;
      }
      if (generation !== currentSessionGeneration() || apiBase !== currentApiBase()) return;
    }
    const stillSignedIn = async (sessionToken: string) => {
      if (apiBase !== currentApiBase()) return false;
      const saved = await loadSavedAccounts(apiBase);
      const owned =
        saved.some((account) => account.token === sessionToken) ||
        (await loadSessionToken()) === sessionToken;
      return (
        owned &&
        !signingOut.has(sessionToken) &&
        !(await pendingSessionTokens(apiBase)).has(sessionToken)
      );
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
      try {
        await rpc(
          "notifications/registerPush",
          {
            token,
            ...(Platform.OS === "android" &&
            // A legacy primary needs a verified user id before native sender fencing can match it.
            accounts.some((account) => account.token === activeToken) &&
            nativeSession &&
            sessionToken === activeToken &&
            requireOptionalNativeModule<{ supportsSenderAvatars?: boolean }>("RakazoNotifications")
              ?.supportsSenderAvatars
              ? { presentation: "android_sender" as const }
              : {}),
          },
          { requestContext },
        );
      } finally {
        if (!(await stillSignedIn(sessionToken)))
          await rpc("notifications/unregisterPush", undefined, { requestContext }).catch(
            () => undefined,
          );
      }
    };
    const registering = accounts.map((account) =>
      register(account.token, account.userId).catch(() => undefined),
    );
    if (activeToken && !accounts.some((account) => account.token === activeToken))
      registering.push(register(activeToken).catch(() => undefined));
    await Promise.all(registering);
    if (activeToken && generation === currentSessionGeneration() && apiBase === currentApiBase())
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
