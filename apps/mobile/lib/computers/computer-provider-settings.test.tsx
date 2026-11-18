// @vitest-environment jsdom
import { flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SpaceComputerSettings from "../../app/(settings)/computer-provider";
import { queryClient } from "../query/query";

const mock = vi.hoisted(() => ({
  rpc: vi.fn(),
  header: vi.fn(),
  spaceId: "space-edited",
}));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ spaceId: mock.spaceId }),
  useFocusEffect: (effect: () => (() => void) | undefined) => useEffect(effect, [effect]),
}));
vi.mock("../api/api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-selected",
  captureApiRequestContext: async (spaceId?: string) => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": spaceId ?? "space-selected" },
  }),
  rpc: (...args: unknown[]) => mock.rpc(...args),
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../api/roster-signals", () => ({ useSpaceChanges: vi.fn() }));
vi.mock("../navigation/screen-header", () => ({ useScreenHeader: mock.header }));
vi.mock("../platform/app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../native/native", () => ({
  native: {},
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native", () => ({
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock("../../components/settings/settings-group", () => ({
  SettingsGroup: ({ children, footer }: { children?: ReactNode; footer?: string }) => (
    <div>
      {children}
      {footer ? <p>{footer}</p> : null}
    </div>
  ),
  SettingsInputRow: ({
    accessibilityLabel,
    value,
    onChangeText,
    editable,
    secureTextEntry,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (value: string) => void;
    editable: boolean;
    secureTextEntry: boolean;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      disabled={!editable}
      type={secureTextEntry ? "password" : "text"}
      onChange={(event) => onChangeText(event.target.value)}
    />
  ),
  SettingsRow: ({
    title,
    trailing,
    onPress,
  }: {
    title: string;
    trailing?: ReactNode;
    onPress?: () => void;
  }) => (
    <div>
      {onPress ? (
        <button type="button" onClick={onPress}>
          {title}
        </button>
      ) : (
        title
      )}
      {trailing}
    </div>
  ),
}));
vi.mock("../../components/native/native-switch", () => ({
  NativeSwitch: ({
    accessibilityLabel,
    value,
    onValueChange,
    disabled,
  }: {
    accessibilityLabel: string;
    value: boolean;
    onValueChange: (value: boolean) => void;
    disabled: boolean;
  }) => (
    <input
      type="checkbox"
      aria-label={accessibilityLabel}
      checked={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.checked)}
    />
  ),
}));
vi.mock("../../components/ui/menu-picker", () => ({
  MenuPicker: ({
    label,
    value,
    choices,
    onChange,
  }: {
    label: string;
    value: string;
    choices: { key: string; label: string }[];
    onChange: (value: string) => void;
  }) => (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      {choices.map((choice) => (
        <option key={choice.key} value={choice.key}>
          {choice.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("../../components/ui/load-failure", () => ({
  LoadFailure: ({ message }: { message: string }) => <p role="alert">{message}</p>,
}));

const settings = {
  connectionId: "connection-original",
  provider: "test-cloud",
  defaultProvider: "test-local",
  values: { region: "region-a" },
  savedSecrets: { apiKey: true },
  providers: [
    {
      id: "test-cloud",
      displayName: "Test cloud",
      capabilities: { perAccount: false, requiresSpendingApproval: true },
      fields: [
        { key: "region", label: "Region", kind: "text", required: true },
        { key: "apiKey", label: "API key", kind: "secret", required: true },
      ],
    },
  ],
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  queryClient.clear();
  mock.rpc.mockResolvedValue(settings);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  queryClient.clear();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(<SpaceComputerSettings />));
  await act(flush);
}
function action() {
  return mock.header.mock.calls.at(-1)?.[0].action;
}

it("pins reads and an explicitly approved save to the Space being edited", async () => {
  await render();
  expect(mock.rpc).toHaveBeenCalledWith(
    "computerProvider/space/get",
    undefined,
    expect.objectContaining({
      requestContext: expect.objectContaining({ headers: { "x-rakazo-space-id": "space-edited" } }),
    }),
  );
  expect(action().disabled).toBe(true);
  expect(mock.rpc.mock.calls.every(([method]) => method !== "computerProvider/space/update")).toBe(
    true,
  );
  const approve = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(approve?.checked).toBe(false);
  await act(async () => approve?.click());
  expect(action().disabled).toBe(false);
  await act(async () => action().onPress());
  await act(flush);
  expect(mock.rpc).toHaveBeenCalledWith(
    "computerProvider/space/update",
    {
      provider: "test-cloud",
      values: settings.values,
      expectedConnectionId: settings.connectionId,
      approveSpending: true,
    },
    expect.objectContaining({
      requestContext: expect.objectContaining({ headers: { "x-rakazo-space-id": "space-edited" } }),
    }),
  );
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
});

it("lets the Space return to its default without authorizing paid provisioning", async () => {
  await render();
  const provider = host.querySelector<HTMLSelectElement>(
    'select[aria-label="New computers run on"]',
  );
  await act(async () => {
    if (provider) provider.value = "default";
    provider?.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  expect(action().disabled).toBe(false);
  await act(async () => action().onPress());
  await act(flush);
  expect(mock.rpc).toHaveBeenCalledWith(
    "computerProvider/space/update",
    {
      provider: "default",
      values: {},
      expectedConnectionId: settings.connectionId,
    },
    expect.anything(),
  );
});

it("offers no editing action when the server grants no connection choices", async () => {
  mock.rpc.mockResolvedValue({ ...settings, providers: [], values: {}, savedSecrets: {} });
  await render();
  expect(action()).toBeNull();
  expect(host.querySelector("input")).toBeNull();
  expect(mock.rpc.mock.calls.every(([method]) => method !== "computerProvider/space/update")).toBe(
    true,
  );
});

it("keeps a dirty form across live refresh and requires a deliberate reload and approval", async () => {
  await render();
  const input = host.querySelector<HTMLInputElement>('input[aria-label="API key"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "unsaved-token",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
  const changed = {
    ...settings,
    connectionId: "connection-other",
    values: { region: "region-other" },
  };
  mock.rpc.mockResolvedValue(changed);
  await act(async () => {
    await queryClient.refetchQueries();
  });
  await act(flush);
  expect(input.value).toBe("unsaved-token");
  expect(host.textContent).toContain("Reload before saving");
  expect(action().disabled).toBe(true);
  await act(async () => action().onPress());
  expect(mock.rpc.mock.calls.some(([method]) => method === "computerProvider/space/update")).toBe(
    false,
  );
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Reload settings")
      ?.click(),
  );
  expect(input.value).toBe("");
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
  await act(async () => action().onPress());
  expect(mock.rpc).toHaveBeenCalledWith(
    "computerProvider/space/update",
    {
      provider: changed.provider,
      values: changed.values,
      expectedConnectionId: changed.connectionId,
      approveSpending: true,
    },
    expect.anything(),
  );
});

it("saves a prepared runtime in the selected Space without a paid provisioning switch", async () => {
  const prepared = {
    provider: "prepared-runtime",
    defaultProvider: "docker",
    connectionId: "runtime-connection",
    values: { url: "https://runtime.example.test:8443", fingerprint: "A".repeat(43) },
    savedSecrets: { token: true },
    providers: [
      {
        id: "prepared-runtime",
        displayName: "Prepared runtime",
        capabilities: { perAccount: false, spaceOnly: true },
        fields: [
          {
            key: "url",
            label: "Runtime URL",
            kind: "url",
            validation: "operator-https",
            required: true,
          },
          {
            key: "token",
            label: "Access token",
            kind: "secret",
            destination: "url",
            required: true,
          },
          { key: "fingerprint", label: "Certificate fingerprint", kind: "text", required: true },
        ],
      },
    ],
  };
  mock.rpc.mockResolvedValue(prepared);
  await render();
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("");
  expect(action().disabled).toBe(false);
  await act(async () => action().onPress());
  expect(mock.rpc).toHaveBeenCalledWith(
    "computerProvider/space/update",
    {
      provider: prepared.provider,
      values: prepared.values,
      expectedConnectionId: prepared.connectionId,
    },
    expect.objectContaining({
      requestContext: expect.objectContaining({ headers: { "x-rakazo-space-id": "space-edited" } }),
    }),
  );
});
