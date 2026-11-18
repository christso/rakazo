import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerProviderSettings as Settings } from "@rakazo/contracts";
import { Button, Checkbox, Field, FieldLabel, Input, OptionSelect } from "@rakazo/ui-web";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import type { SpaceQueries } from "../../lib/query/query";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import type { RpcClient } from "../../lib/query/rpc";
import { errorText } from "../../lib/query/user-error";
import { SuccessPop } from "../ai/primitives";

type Scope = "deployment" | "account" | "space";
type Draft = {
  provider: string;
  values: Record<string, string>;
  approveSpending?: boolean;
  expectedConnectionId?: string | null;
};
type Form = { key: string; settings: Settings; draft: Draft; dirty: boolean };

// The RPC client hands out a new object on every property read, so pick by scope, never hold it.
function settingsApi(client: RpcClient, scope: Scope) {
  if (scope === "space") return client.computerProvider.space;
  return scope === "account" ? client.computerProvider.account : client.computerProvider;
}

function settingsRead(queries: SpaceQueries, scope: Scope) {
  if (scope === "space") return queries.computerProvider.space.get.queryOptions();
  if (scope === "account") return queries.computerProvider.account.get.queryOptions();
  return queries.computerProvider.get.queryOptions();
}

// Field labels come from the server in English; translate the ones the registry uses.
function useFieldLabel() {
  const { t } = useLingui();
  const labels: Record<string, string> = {
    accessKeyId: t`Access key ID`,
    accessKeySecret: t`Access key secret`,
    apiKey: t`API key`,
    apiToken: t`API token`,
    apiUrl: t`API URL`,
    baseUrl: t`API URL`,
    desktopId: t`Desktop ID`,
    endUserId: t`End user ID`,
    environmentId: t`Environment ID`,
    mcpToken: t`Gateway token`,
    mcpUrl: t`Gateway URL`,
    org: t`Organization`,
    region: t`Region`,
    regionId: t`Region`,
    rootfs: t`Root filesystem`,
    shape: t`Shape`,
    target: t`Target`,
    template: t`Template`,
  };
  return (field: { key: string; label: string }) => labels[field.key] ?? field.label;
}

function draftFrom(settings: Settings, scope: Scope): Draft {
  return {
    provider: settings.provider,
    values: settings.values,
    ...(scope === "space" ? { expectedConnectionId: settings.connectionId ?? null } : {}),
  };
}

export function ComputerProviderSettings({
  scope,
  onProviderChange,
  onBusyChange,
  collapsible = false,
}: {
  scope: Scope;
  onProviderChange?: (sandboxProvider: string) => void;
  onBusyChange?: (busy: boolean) => void;
  collapsible?: boolean;
}) {
  const { t } = useLingui();
  const fieldLabel = useFieldLabel();
  const selectId = useId();
  const approvalId = useId();
  const [formState, setFormState] = useState<Form | null>(null);
  const [saved, setSaved] = useState(false);
  const [approveSpending, setApproveSpending] = useState(false);
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const read = settingsRead(queries, scope);
  const query = useQuery(read);
  const key = hashKey(read.queryKey);
  const formStateForScope = formState?.key === key ? formState : null;
  const settings = formStateForScope?.settings;
  const draft = formStateForScope?.draft;
  const dirty = formStateForScope?.dirty ?? false;
  const remoteChanged =
    scope === "space" &&
    query.data &&
    draft &&
    draft.expectedConnectionId !== (query.data.connectionId ?? null);
  const loadError = query.error
    ? errorText(query.error, t`Could not load computer settings`)
    : null;
  const save = useSave({
    save: async (next: Draft, client) => {
      await queryClient.cancelQueries({ queryKey: read.queryKey });
      return settingsApi(client, scope).update(next);
    },
    // The deployment's provider is part of the account read.
    stale: scope === "deployment" ? [queries.me.key()] : [],
    onSaved: (next) => {
      queryClient.setQueryData(read.queryKey, next);
      setFormState({ key, settings: next, draft: draftFrom(next, scope), dirty: false });
      setSaved(true);
      setApproveSpending(false);
      // An account's choice covers only its Team Computers, never what the deployment runs.
      if (scope === "deployment")
        onProviderChange?.(next.provider === "default" ? next.defaultProvider : next.provider);
    },
  });
  const pending = save.pending;
  useEffect(() => onBusyChange?.(pending), [onBusyChange, pending]);

  useEffect(() => {
    if (dirty) return;
    setFormState(
      query.data
        ? { key, settings: query.data, draft: draftFrom(query.data, scope), dirty: false }
        : null,
    );
    setApproveSpending(false);
  }, [query.data, key, dirty, scope]);

  if (!draft || !settings) {
    return loadError ? (
      <p role="alert" className="mt-3 text-body-sm text-destructive">
        {loadError}
      </p>
    ) : null;
  }

  const set = (patch: Partial<Draft>) => {
    setSaved(false);
    setApproveSpending(false);
    setFormState({ key, settings, draft: { ...draft, ...patch }, dirty: true });
  };
  const descriptor = settings.providers.find((provider) => provider.id === draft.provider);
  const requiresApproval =
    scope === "space" && descriptor?.capabilities.requiresSpendingApproval === true;
  if (settings.providers.length === 0) return null;
  const destinationChanged = descriptor?.fields.some(
    (field) => field.kind === "url" && draft.values[field.key] !== settings.values[field.key],
  );
  const form = (
    <>
      <form
        className="mt-4 grid gap-3"
        data-testid="computer-provider-settings"
        onSubmit={(event) => {
          event.preventDefault();
          if (remoteChanged || (requiresApproval && !approveSpending)) return;
          save.run(requiresApproval ? { ...draft, approveSpending: true } : draft);
        }}
      >
        {/* Edits made while a save is in flight would be replaced by what it saved. */}
        <fieldset className="contents" disabled={pending}>
          <Field>
            <FieldLabel htmlFor={selectId}>
              <Trans>New computers run on</Trans>
            </FieldLabel>
            <OptionSelect
              id={selectId}
              value={draft.provider}
              onValueChange={(provider) =>
                set({
                  provider,
                  values: provider === settings.provider ? settings.values : {},
                })
              }
              options={[
                { value: "default", label: t`Default` },
                ...settings.providers.map((provider) => ({
                  value: provider.id,
                  label: provider.displayName,
                })),
              ]}
            />
          </Field>
          {descriptor?.fields.map((field) => {
            const saved =
              draft.provider === settings.provider &&
              settings.savedSecrets[field.key] &&
              !destinationChanged;
            const change = (value: string) =>
              set({ values: { ...draft.values, [field.key]: value } });
            return field.kind === "select" ? (
              <Field key={field.key}>
                <FieldLabel htmlFor={`${selectId}-${field.key}`}>{fieldLabel(field)}</FieldLabel>
                <OptionSelect
                  id={`${selectId}-${field.key}`}
                  value={draft.values[field.key] || (field.required ? null : "")}
                  onValueChange={change}
                  required={field.required}
                  className="w-fit"
                  options={[
                    ...(field.required ? [] : [{ value: "", label: t`Default` }]),
                    ...(field.options ?? []),
                  ]}
                />
              </Field>
            ) : (
              <TextField
                key={field.key}
                label={fieldLabel(field)}
                value={draft.values[field.key] ?? ""}
                onChange={change}
                required={field.required && !saved}
                secret={field.kind === "secret"}
                type={field.kind === "url" ? "url" : "text"}
                placeholder={saved ? t`Saved` : undefined}
              />
            );
          })}
          {requiresApproval ? (
            <div className="grid gap-1">
              <Field orientation="horizontal">
                <Checkbox
                  id={approvalId}
                  checked={approveSpending}
                  onCheckedChange={(checked) => {
                    setApproveSpending(checked === true);
                    setFormState({ key, settings, draft, dirty: true });
                  }}
                  aria-describedby={
                    descriptor?.spendingApprovalMessage ? `${approvalId}-message` : undefined
                  }
                />
                <FieldLabel htmlFor={approvalId}>
                  <Trans>Allow paid computers</Trans>
                </FieldLabel>
              </Field>
              {descriptor?.spendingApprovalMessage ? (
                <p id={`${approvalId}-message`} className="text-body-sm text-muted-foreground">
                  {descriptor.spendingApprovalMessage}
                </p>
              ) : null}
            </div>
          ) : null}
        </fieldset>
        {remoteChanged ? (
          <div className="grid gap-2 text-body-sm">
            <p role="status">
              <Trans>Computer settings changed. Reload before saving.</Trans>
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-fit"
              onClick={() => {
                if (!query.data) return;
                setFormState({
                  key,
                  settings: query.data,
                  draft: draftFrom(query.data, scope),
                  dirty: false,
                });
                setApproveSpending(false);
                setSaved(false);
                save.reset();
              }}
            >
              <Trans>Reload settings</Trans>
            </Button>
          </div>
        ) : null}
        {save.error ? (
          <p role="alert" className="text-body-sm text-destructive">
            {errorText(save.error, t`Could not save computer settings`)}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <Button
            type="submit"
            size="sm"
            disabled={pending || remoteChanged || (requiresApproval && !approveSpending)}
          >
            <Trans>Save</Trans>
          </Button>
          {saved ? <SuccessPop label={t`Saved`} /> : null}
        </div>
      </form>
      {scope === "deployment" &&
      settings.providers.some((provider) => provider.capabilities.perAccount) ? (
        <Collapsible className="mt-4">
          <CollapsibleTrigger className="text-body-sm text-muted-foreground">
            <Trans>My computers</Trans>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ComputerProviderSettings scope="account" />
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </>
  );
  return collapsible ? (
    <Collapsible>
      <CollapsibleTrigger className="text-body-sm font-medium">
        <Trans>Computers</Trans>
      </CollapsibleTrigger>
      <CollapsibleContent>{form}</CollapsibleContent>
    </Collapsible>
  ) : (
    form
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  required,
  secret,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  secret?: boolean;
  type?: "text" | "url";
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type={secret ? "password" : type}
        autoComplete={secret ? "off" : undefined}
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        required={required}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
