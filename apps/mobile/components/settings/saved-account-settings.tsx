import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Alert } from "react-native";
import { errorText } from "../../lib/api/user-error";
import type { AccountSummary } from "../../lib/auth/account-sessions";
import {
  refreshAccountSummaries,
  rememberCurrentAccount,
  selectSavedAccount,
  signOutAllAccounts,
} from "../../lib/auth/account-sessions";
import { replaceWithSignIn } from "../../lib/auth/auth-routing";
import { endCallBeforeSessionEnd } from "../../lib/calls/call-session";
import { useResolvedAppearance } from "../../lib/native/native";
import { closeSettingsSheet } from "../../lib/settings/settings-sheet";
import { confirmUnsentSendLoss } from "../../lib/thread/send/unsent-send-warning";
import { SettingsGroup, SettingsRow } from "./settings-group";

export function SavedAccountSettings({
  userId,
  pending,
  onPendingChange,
  onError,
}: {
  userId?: string;
  pending: boolean;
  onPendingChange: (pending: boolean) => void;
  onError: (message: string | null) => void;
}) {
  const { t } = useLingui();
  const router = useRouter();
  const colorScheme = useResolvedAppearance();
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void refreshAccountSummaries()
        .then((rows) => {
          if (active) setAccounts(rows);
        })
        .catch(() => undefined);
      return () => {
        active = false;
      };
    }, []),
  );

  async function switchAccount(nextUserId: string) {
    onPendingChange(true);
    onError(null);
    try {
      const selected = await selectSavedAccount(nextUserId);
      if (selected === null) {
        onPendingChange(false);
        return;
      }
      if (!selected) throw new Error(t`Sign in to open this account`);
      closeSettingsSheet();
      router.dismissTo("/");
    } catch (error) {
      onError(errorText(error));
      onPendingChange(false);
    }
  }

  async function addAccount() {
    try {
      await rememberCurrentAccount();
      closeSettingsSheet();
      router.push({ pathname: "/sign-in", params: { mode: "in", addAccount: "1" } });
    } catch (error) {
      onError(errorText(error));
    }
  }

  function confirmSignOutAll() {
    Alert.alert(t`Sign out all accounts?`, undefined, [
      { text: t`Cancel`, style: "cancel" },
      {
        text: t`Sign out all`,
        style: "destructive",
        onPress: async () => {
          if (!(await confirmUnsentSendLoss("sign-out"))) return;
          onPendingChange(true);
          try {
            await endCallBeforeSessionEnd();
          } catch (error) {
            onError(errorText(error, t`Could not sign out`));
            onPendingChange(false);
            return;
          }
          try {
            await signOutAllAccounts();
          } catch (error) {
            Alert.alert(errorText(error, t`Could not sign out`));
          } finally {
            replaceWithSignIn();
          }
        },
      },
    ]);
  }

  return (
    <SettingsGroup>
      <MenuView
        title={t`Switch accounts`}
        colorScheme={colorScheme}
        actions={[
          ...accounts.map((saved) => ({
            id: `account:${saved.userId}`,
            title: saved.unread ? t`${saved.email} (${saved.unread} unread)` : saved.email,
            state: saved.userId === userId ? ("on" as const) : ("off" as const),
            attributes: { disabled: pending || saved.userId === userId },
          })),
          { id: "add", title: t`Add account`, attributes: { disabled: pending } },
        ]}
        onPressAction={(event) => {
          if (pending) return;
          const id = event.nativeEvent.event;
          if (id === "add") void addAccount();
          else if (id.startsWith("account:")) {
            const nextUserId = id.slice("account:".length);
            if (nextUserId !== userId) void switchAccount(nextUserId);
          }
        }}
      >
        <SettingsRow
          title={t`Switch accounts`}
          accessibilityRole="button"
          accessibilityState={{ disabled: pending }}
          chevron="right"
          disabled={pending}
          dimmed={pending}
        />
      </MenuView>
      {accounts.length > 1 ? (
        <SettingsRow
          title={t`Sign out all`}
          accessibilityRole="button"
          destructive
          disabled={pending}
          dimmed={pending}
          onPress={confirmSignOutAll}
        />
      ) : null}
    </SettingsGroup>
  );
}
