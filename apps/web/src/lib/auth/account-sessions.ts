import { t } from "@lingui/core/macro";
import type { AccountNotification, AccountSessions } from "@rakazo/contracts";
import { readBoundedJsonResponse } from "@rakazo/core";
import { useEffect, useSyncExternalStore } from "react";
import { endCallBeforeSignOut, sessionChangedUnderPage } from "../calls/call-session";
import { composerHoldsUnsavedWork } from "../composer/composer-draft";
import { clearSpaceSelection, selectSpace } from "../query/rpc";
import { useEventListener } from "../use-event-listener";
import { accountIdentity, accountRequestHeaders, pauseAccountRequests } from "./account-identity";
import { accountNotificationChanges, accountNotificationPath } from "./account-notifications";

const empty: AccountSessions = { activeUserId: null, accounts: [] };
let snapshot = empty;
let unsupported = false;
const listeners = new Set<() => void>();

function publish(value: AccountSessions): void {
  snapshot = value;
  for (const listener of listeners) listener();
}

export function useSavedAccounts(): AccountSessions {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => empty,
  );
}

export async function fetchSavedAccounts(signal?: AbortSignal): Promise<AccountSessions> {
  const timeout = AbortSignal.timeout(8_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch("/api/accounts", {
    credentials: "include",
    cache: "no-store",
    signal: requestSignal,
  });
  if (response.status === 404 || response.status === 401) {
    if (response.status === 404) unsupported = true;
    return empty;
  }
  if (!response.ok) throw new Error(t`Could not load`);
  const result = await readBoundedJsonResponse<AccountSessions>(
    response,
    512 * 1024,
    requestSignal,
  );
  unsupported = false;
  return result;
}

export function savedAccountsUnsupported(): boolean {
  return unsupported;
}

export async function changeSavedAccount(
  action: "select" | "remove",
  userId: string,
): Promise<void> {
  const headers = accountRequestHeaders({ "content-type": "application/json" });
  const response = await fetch(`/api/accounts/${action}`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ userId }),
    signal: AbortSignal.timeout(8_000),
  });
  await response.body?.cancel();
  if (response.status === 404) unsupported = true;
  if (!response.ok) throw new Error(t`Could not continue`);
}

let switching = false;

/** Cookie selection always ends in a fresh page, so old streams and caches cannot survive. */
export async function switchSavedAccount(
  userId: string,
  notification?: AccountNotification,
): Promise<void> {
  if (switching) return;
  if (
    composerHoldsUnsavedWork() &&
    !window.confirm(t`Discard unsaved attachments and pending messages?`)
  )
    return;
  switching = true;
  await endCallBeforeSignOut();
  if (sessionChangedUnderPage()) {
    window.location.reload();
    return;
  }
  // Capture headers while this page still owns the old identity, then stop ordinary requests.
  const changing = changeSavedAccount("select", userId);
  pauseAccountRequests();
  try {
    await changing;
    clearSpaceSelection();
    if (notification && !selectSpace(notification.spaceId))
      throw new Error("Space selection failed");
    window.location.assign(notification ? accountNotificationPath(notification) : "/app");
  } catch {
    // Never open a notification under whichever account remains active.
    window.location.assign("/sign-in?add=1");
  }
}

export async function addSavedAccount(): Promise<void> {
  if (switching) return;
  if (
    composerHoldsUnsavedWork() &&
    !window.confirm(t`Discard unsaved attachments and pending messages?`)
  )
    return;
  switching = true;
  await endCallBeforeSignOut();
  pauseAccountRequests();
  window.location.assign("/sign-in?add=1");
}

const feedRefreshListeners = new Set<() => void>();

/** Re-read on an existing live-stream signal or an explicit account-picker interaction. */
export function refreshAccountNotifications(): void {
  for (const refresh of feedRefreshListeners) refresh();
}

/** All cookie-proven accounts are read without changing the selected session. */
export function useAccountNotifications(userId: string | null): void {
  useEventListener(window, "focus", refreshAccountNotifications);
  useEventListener(document, "visibilitychange", () => {
    if (document.visibilityState === "visible") refreshAccountNotifications();
  });
  useEffect(() => {
    const controller = new AbortController();
    const seen = new Map<string, Set<string>>();
    const openNotifications = new Set<Notification>();
    let reading = false;
    let readAgain = false;
    const refresh = () => {
      if (controller.signal.aborted || switching) return;
      if (reading) {
        readAgain = true;
        return;
      }
      void read();
    };
    async function read() {
      reading = true;
      try {
        const next = await fetchSavedAccounts(controller.signal);
        if (controller.signal.aborted || switching) return;
        if (userId && next.activeUserId && next.activeUserId !== userId) {
          pauseAccountRequests();
          window.location.reload();
          return;
        }
        publish(next);
        for (const { account, notification } of accountNotificationChanges(next.accounts, seen)) {
          if (typeof Notification === "undefined" || Notification.permission !== "granted")
            continue;
          // The shell's live stream already notifies for the account on screen.
          if (account.userId === accountIdentity()) continue;
          const alert = new Notification(notification.title, {
            body: `${notification.body}\n${account.email}`,
            tag: `${account.userId}:${notification.threadId}`,
          });
          openNotifications.add(alert);
          alert.onclose = () => openNotifications.delete(alert);
          alert.onclick = () => {
            alert.close();
            window.focus();
            void switchSavedAccount(account.userId, notification);
          };
        }
      } catch {
        // A failed feed read is not a sign-out; the next signal or focus retries it.
      } finally {
        reading = false;
        if (readAgain) {
          readAgain = false;
          refresh();
        }
      }
    }
    feedRefreshListeners.add(refresh);
    refresh();
    return () => {
      feedRefreshListeners.delete(refresh);
      controller.abort();
      for (const alert of openNotifications) alert.close();
      publish(empty);
    };
  }, [userId]);
}
