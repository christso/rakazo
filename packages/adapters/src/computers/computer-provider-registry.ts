import type { ComputerProviderDescriptor, ComputerProviderField } from "@rakazo/contracts";
import {
  ipVersion,
  isCloudMetadataHost,
  isInternalHostname,
  isNonPublicAddress,
} from "@rakazo/contracts";
import type {
  ComputerProviderDefinition,
  SandboxProviderOptions,
  SettingsComputerProvider,
} from "./computer-provider-descriptor.js";
import { optional } from "./computer-provider-descriptor.js";
import { computerProviders } from "./computer-providers.js";

export const computerProviderRegistry: readonly SettingsComputerProvider[] = Object.entries(
  computerProviders,
).flatMap(([id, definition]: [string, ComputerProviderDefinition]) =>
  definition.settings ? [settingsProvider(id, definition)] : [],
);

export function computerProviderDescriptor(id: string) {
  const descriptor = computerProviderRegistry.find((entry) => entry.id === id);
  if (!descriptor) throw new Error("Unknown computer provider");
  return descriptor;
}

export function computerProviderDescriptors(perAccount = false): ComputerProviderDescriptor[] {
  return computerProviderRegistry
    .filter((entry) => !perAccount || entry.capabilities.perAccount)
    .map(({ id, displayName, fields, capabilities, spendingApprovalMessage }) => ({
      id,
      displayName,
      ...(spendingApprovalMessage ? { spendingApprovalMessage } : {}),
      fields,
      capabilities,
    }));
}

/** Settings and the environment set a provider's options through the same bindings. */
function settingsProvider(
  id: string,
  { env = {}, settings }: ComputerProviderDefinition,
): SettingsComputerProvider {
  const {
    displayName,
    perAccount = false,
    requiresSpendingApproval,
    spaceOnly,
    spendingApprovalMessage,
    fields,
    validate,
    verifyConnection,
    verifyEndpoint,
  } = settings!;
  const options = new Map(fields.map((field) => [field.key, field.option]));
  const publicFields: ComputerProviderField[] = fields.map(({ option, ...field }) => ({
    ...field,
    required: field.required ?? (option ? env[option]?.required : false) ?? false,
    ...(field.kind === "url" ? { validation: field.validation ?? ("public-https" as const) } : {}),
  }));
  return {
    id,
    displayName,
    ...(spendingApprovalMessage ? { spendingApprovalMessage } : {}),
    capabilities: {
      perAccount,
      ...(requiresSpendingApproval ? { requiresSpendingApproval } : {}),
      ...(spaceOnly ? { spaceOnly } : {}),
    },
    fields: publicFields,
    verify(values) {
      validate?.(values);
      for (const key of Object.keys(values)) {
        if (!options.has(key)) throw new Error("Unknown computer setting");
      }
      // Only the options these fields set: a blank one falls back to the provider's default,
      // and options Settings has no field for keep their environment values.
      const verified: Record<string, unknown> = {};
      const providerSettings: Record<string, string> = {};
      for (const field of publicFields) {
        const value = values[field.key]?.trim() ?? "";
        if (field.required && !value) throw new Error(`${field.label} is required`);
        if (value.length > 4096) throw new Error(`${field.label} is too long`);
        if (value && field.kind === "url")
          assertPublicHttps(value, field.label, field.validation === "operator-https");
        if (
          field.kind === "select" &&
          value &&
          !field.options?.some((option) => option.value === value)
        )
          throw new Error(`Invalid ${field.label}`);
        const option = options.get(field.key)!;
        if (option) {
          const read = env[option]?.read ?? optional;
          verified[option] = value ? read(value, {}) : undefined;
        } else if (value) providerSettings[field.key] = value;
      }
      if (Object.keys(providerSettings).length) verified.providerSettings = providerSettings;
      return verified as SandboxProviderOptions;
    },
    ...(verifyConnection ? { verifyConnection } : {}),
    ...(verifyEndpoint ? { verifyEndpoint } : {}),
  };
}

function assertPublicHttps(value: string, label: string, operatorPolicy = false) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error(`${label} must be an HTTPS URL without credentials or fragment`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !operatorPolicy &&
    (isInternalHostname(host) ||
      isCloudMetadataHost(host) ||
      (ipVersion(host) && isNonPublicAddress(host)))
  )
    throw new Error(`${label} must use a public address`);
}
