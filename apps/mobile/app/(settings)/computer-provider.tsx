import { useLingui } from "@lingui/react/macro";
import type { ComputerProviderSettings, ComputerProviderUpdate } from "@rakazo/contracts";
import { hashKey } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeSwitch } from "../../components/native/native-switch";
import {
  SettingsGroup,
  SettingsInputRow,
  SettingsRow,
} from "../../components/settings/settings-group";
import { LoadFailure } from "../../components/ui/load-failure";
import { MenuPicker } from "../../components/ui/menu-picker";
import { useSpaceChanges } from "../../lib/api/roster-signals";
import { errorText } from "../../lib/api/user-error";
import { useSideInsets } from "../../lib/layout/side-insets";
import { native, useThemedStyles } from "../../lib/native/native";
import { useScreenHeader } from "../../lib/navigation/screen-header";
import { queryClient, targetRpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { settingsTarget } from "../../lib/query/settings-target";

type Form = {
  key: string;
  settings: ComputerProviderSettings;
  draft: ComputerProviderUpdate;
  dirty: boolean;
};
function formFrom(key: string, settings: ComputerProviderSettings): Form {
  return {
    key,
    settings,
    dirty: false,
    draft: {
      provider: settings.provider,
      values: settings.values,
      expectedConnectionId: settings.connectionId ?? null,
      idlePolicy: settings.idlePolicy,
    },
  };
}

export default function SpaceComputerSettings() {
  const { spaceId } = useLocalSearchParams<{ spaceId?: string }>();
  const target = useMemo(() => settingsTarget(spaceId), [spaceId]);
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const sideInsets = useSideInsets();
  const read = targetRpcQuery(target, "computerProvider/space/get");
  const query = useScreenQuery(read, {
    enabled: target.scope === "space",
    onForeground: false,
  });
  const [formState, setFormState] = useState<Form | null>(null);
  const [approveSpending, setApproveSpending] = useState(false);
  const key = hashKey(read.queryKey);
  const form = formState?.key === key ? formState : null;
  const settings = form?.settings;
  const draft = form?.draft;
  const dirty = form?.dirty ?? false;
  const remoteChanged = Boolean(
    query.data && draft && draft.expectedConnectionId !== (query.data.connectionId ?? null),
  );
  useSpaceChanges("computerProvider", () => query.refetch(), target.scope === "space");
  useEffect(() => {
    if (dirty) return;
    setFormState(query.data ? formFrom(key, query.data) : null);
    setApproveSpending(false);
  }, [query.data, key, dirty]);
  const save = useSave({
    target,
    save: async (next: ComputerProviderUpdate, send) => {
      await queryClient.cancelQueries({ queryKey: read.queryKey });
      const saved = await send("computerProvider/space/update", next);
      queryClient.setQueryData(read.queryKey, saved);
      return saved;
    },
    onSaved: (saved) => {
      setFormState(formFrom(key, saved));
      setApproveSpending(false);
    },
  });
  const descriptor = settings?.providers.find((provider) => provider.id === draft?.provider);
  const requiresApproval = descriptor?.capabilities.requiresSpendingApproval === true;
  const destinationChanged = descriptor?.fields.some(
    (field) => field.kind === "url" && draft?.values[field.key] !== settings?.values[field.key],
  );
  const hasSecret = (key: string) =>
    settings?.provider === draft?.provider && !destinationChanged && settings?.savedSecrets[key];
  const missing = descriptor?.fields.some(
    (field) => field.required && !draft?.values[field.key]?.trim() && !hasSecret(field.key),
  );
  const canSave = Boolean(
    draft &&
      settings?.providers.length &&
      !remoteChanged &&
      !missing &&
      (!requiresApproval || approveSpending),
  );
  useScreenHeader({
    title: t`Computers`,
    action: settings?.providers.length
      ? {
          label: t`Save`,
          busy: save.pending,
          disabled: !canSave,
          onPress: () => {
            if (draft && canSave)
              save.run(requiresApproval ? { ...draft, approveSpending: true } : draft);
          },
        }
      : null,
  });
  if (target.scope !== "space") return null;

  const set = (next: ComputerProviderUpdate) => {
    if (!settings) return;
    setFormState({
      key,
      settings,
      draft: { ...next, expectedConnectionId: draft?.expectedConnectionId ?? null },
      dirty: true,
    });
    setApproveSpending(false);
    save.reset();
  };
  const error = save.error ?? query.error;
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        {error ? (
          <LoadFailure message={errorText(error)} onRetry={() => void query.refetch()} />
        ) : null}
        {draft && settings?.providers.length ? (
          <>
            {remoteChanged ? (
              <SettingsGroup footer={t`Computer settings changed. Reload before saving.`}>
                <SettingsRow
                  title={t`Reload settings`}
                  onPress={() => {
                    if (!query.data) return;
                    setFormState(formFrom(key, query.data));
                    setApproveSpending(false);
                    save.reset();
                  }}
                />
              </SettingsGroup>
            ) : null}
            <SettingsGroup>
              <MenuPicker
                label={t`New computers run on`}
                value={draft.provider}
                disabled={save.pending}
                choices={[
                  { key: "default", label: t`Default` },
                  ...settings.providers.map((provider) => ({
                    key: provider.id,
                    label: provider.displayName,
                  })),
                ]}
                onChange={(provider) =>
                  set({
                    provider,
                    values: provider === settings.provider ? settings.values : {},
                    idlePolicy:
                      provider === "default"
                        ? undefined
                        : provider === settings.provider
                          ? settings.idlePolicy
                          : "keep-vm",
                  })
                }
              />
            </SettingsGroup>
            {descriptor?.fields.length ? (
              <SettingsGroup>
                {descriptor.fields.map((field) => {
                  const label = field.label;
                  const change = (value: string) =>
                    set({ ...draft, values: { ...draft.values, [field.key]: value } });
                  return field.kind === "select" ? (
                    <MenuPicker
                      key={field.key}
                      label={label}
                      value={draft.values[field.key] ?? ""}
                      disabled={save.pending}
                      choices={[
                        ...(field.required ? [] : [{ key: "", label: t`Default` }]),
                        ...(field.options ?? []).map((option) => ({
                          key: option.value,
                          label: option.label,
                        })),
                      ]}
                      onChange={change}
                    />
                  ) : (
                    <SettingsInputRow
                      key={field.key}
                      accessibilityLabel={label}
                      placeholder={hasSecret(field.key) ? `${label} (${t`Saved`})` : label}
                      value={draft.values[field.key] ?? ""}
                      editable={!save.pending}
                      secureTextEntry={field.kind === "secret"}
                      autoCapitalize="none"
                      autoCorrect={false}
                      onChangeText={change}
                    />
                  );
                })}
              </SettingsGroup>
            ) : null}
            {descriptor?.capabilities.hibernate ? (
              <SettingsGroup
                footer={
                  draft.idlePolicy === "hibernate"
                    ? t`Snapshot storage can incur charges. Waking takes longer.`
                    : undefined
                }
              >
                <MenuPicker
                  label={t`When computers are idle`}
                  value={draft.idlePolicy ?? "keep-vm"}
                  disabled={save.pending}
                  choices={[
                    { key: "keep-vm", label: t`Keep VM` },
                    { key: "hibernate", label: t`Hibernate and release` },
                  ]}
                  onChange={(idlePolicy) =>
                    set({
                      ...draft,
                      idlePolicy: idlePolicy === "hibernate" ? "hibernate" : "keep-vm",
                    })
                  }
                />
              </SettingsGroup>
            ) : null}
            {requiresApproval ? (
              <SettingsGroup footer={descriptor?.spendingApprovalMessage}>
                <SettingsRow
                  title={t`Allow paid computers`}
                  trailing={
                    <NativeSwitch
                      accessibilityLabel={t`Allow paid computers`}
                      value={approveSpending}
                      disabled={save.pending}
                      onValueChange={(approved) => {
                        setApproveSpending(approved);
                        setFormState({ key, settings, draft, dirty: true });
                      }}
                    />
                  }
                />
              </SettingsGroup>
            ) : null}
          </>
        ) : settings ? (
          <Text style={styles.secondary}>{t`Computer settings unavailable`}</Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, gap: 24, paddingBottom: 40 },
    secondary: { color: native.secondaryLabel, fontSize: 15 },
  });
}
