// @vitest-environment jsdom
import { deferred, flush } from "@rakazo/core/test-async";
import type * as UiWeb from "@rakazo/ui-web";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSpaceQueries } from "../../lib/query/query";
import { ComputerProviderSettings } from "./ComputerProviderSettings";

vi.mock("@lingui/react/macro", () => {
  // Stable like Lingui's own, since the form reloads when it changes.
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", async (importOriginal) => ({
  Button: ({ size: _size, ...props }: ComponentProps<"button"> & { size?: string }) => (
    <button {...props} />
  ),
  Field: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children, htmlFor }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  OptionSelect: (await importOriginal<typeof UiWeb>()).OptionSelect,
  Checkbox: (await importOriginal<typeof UiWeb>()).Checkbox,
}));
vi.mock("../ai/primitives", () => ({ SuccessPop: () => null }));
const { deployment, account, space, me } = vi.hoisted(() => ({
  deployment: { get: vi.fn(), update: vi.fn() },
  account: { get: vi.fn(), update: vi.fn() },
  space: { get: vi.fn(), update: vi.fn() },
  me: vi.fn(),
}));
// Like the real client, every property read returns a new object.
vi.mock("../../lib/query/rpc", () => {
  const rpc = {
    me,
    get computerProvider() {
      return {
        ...deployment,
        get account() {
          return { ...account };
        },
        get space() {
          return { ...space };
        },
      };
    },
  };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});

const saved = {
  provider: "personal-desktop",
  defaultProvider: "docker",
  providers: [
    {
      id: "personal-desktop",
      displayName: "Personal desktop",
      capabilities: { perAccount: true },
      fields: [
        { key: "desktop", label: "Desktop", kind: "text", required: true },
        { key: "url", label: "Gateway", kind: "url", required: true },
        { key: "token", label: "Token", kind: "secret", required: true, destination: "url" },
      ],
    },
  ],
  values: { desktop: "example-desktop", url: "https://gateway.example.com/mcp" },
  savedSecrets: { token: true },
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let currentClient: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

function settings(props: ComponentProps<typeof ComputerProviderSettings>, extra?: ReactNode) {
  currentClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={currentClient}>
      {extra}
      <ComputerProviderSettings {...props} />
    </QueryClientProvider>
  );
}

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("saves a Space connection without changing the account or deployment", async () => {
  space.get.mockResolvedValue(saved);
  space.update.mockResolvedValue(saved);
  await act(async () => root.render(settings({ scope: "space" })));
  await act(flush);
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(space.update).toHaveBeenCalledWith({
    provider: saved.provider,
    values: saved.values,
    expectedConnectionId: null,
  });
  expect(account.get).not.toHaveBeenCalled();
  expect(account.update).not.toHaveBeenCalled();
  expect(deployment.get).not.toHaveBeenCalled();
  expect(deployment.update).not.toHaveBeenCalled();
});

it("requires explicit spending approval before saving a paid Space connection", async () => {
  const paid = {
    ...saved,
    providers: [
      {
        ...saved.providers[0]!,
        capabilities: { perAccount: false, requiresSpendingApproval: true },
      },
    ],
  };
  space.get.mockResolvedValue(paid);
  space.update.mockResolvedValue(paid);
  await act(async () => root.render(settings({ scope: "space" })));
  await act(flush);
  const approve = host.querySelector<HTMLElement>('[role="checkbox"]');
  expect(approve).not.toBeNull();
  expect(approve?.getAttribute("aria-checked")).toBe("false");
  expect(space.update).not.toHaveBeenCalled();
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  expect(submit?.disabled).toBe(true);
  await act(async () => approve?.click());
  expect(submit?.disabled).toBe(false);
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(space.update).toHaveBeenCalledWith({
    provider: saved.provider,
    values: saved.values,
    expectedConnectionId: null,
    approveSpending: true,
  });
  expect(host.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("false");
});

it("keeps unsaved credentials and requires reload and new approval after another manager saves", async () => {
  const original = {
    ...saved,
    connectionId: "connection-original",
    providers: [
      {
        ...saved.providers[0]!,
        capabilities: { perAccount: false, requiresSpendingApproval: true },
      },
    ],
  };
  space.get.mockResolvedValue(original);
  await act(async () => root.render(settings({ scope: "space" })));
  await act(flush);
  await act(async () => paste("Token", "unsaved-token"));
  await act(async () => host.querySelector<HTMLElement>('[role="checkbox"]')?.click());
  const changed = {
    ...original,
    connectionId: "connection-other",
    values: { ...saved.values, desktop: "other-account" },
  };
  space.get.mockResolvedValue(changed);
  space.update.mockResolvedValue(changed);
  await act(async () => {
    await currentClient.refetchQueries();
  });
  await act(flush);
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe(
    "unsaved-token",
  );
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Reload before saving");
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(space.update).not.toHaveBeenCalled();
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Reload settings")
      ?.click(),
  );
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("");
  expect(host.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("false");
  await act(async () => host.querySelector<HTMLElement>('[role="checkbox"]')?.click());
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(space.update).toHaveBeenCalledWith({
    provider: changed.provider,
    values: changed.values,
    expectedConnectionId: changed.connectionId,
    approveSpending: true,
  });
});

it("saves an account's own desktop to the account, never the deployment", async () => {
  account.get.mockResolvedValue(saved);
  account.update.mockResolvedValue(saved);
  const onProviderChange = vi.fn();
  await act(async () => root.render(settings({ scope: "account", onProviderChange })));
  await act(flush);
  expect(host.querySelector<HTMLInputElement>("input:not([aria-hidden])")?.value).toBe(
    "example-desktop",
  );
  // Loaded once, not again on every render.
  expect(account.get).toHaveBeenCalledOnce();

  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(account.update).toHaveBeenCalledWith({
    provider: saved.provider,
    values: saved.values,
  });
  expect(deployment.get).not.toHaveBeenCalled();
  expect(deployment.update).not.toHaveBeenCalled();
  // An account's choice covers its Team Computers, not what the deployment reports.
  expect(onProviderChange).not.toHaveBeenCalled();
});

it("sends an account back to the deployment default", async () => {
  account.get.mockResolvedValue({ ...saved, provider: "default", values: {}, savedSecrets: {} });
  account.update.mockResolvedValue({
    ...saved,
    provider: "default",
    values: {},
    savedSecrets: {},
  });
  const onProviderChange = vi.fn();
  await act(async () => root.render(settings({ scope: "account", onProviderChange })));
  await act(flush);
  expect(host.querySelector("input:not([aria-hidden])")).toBeNull();
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(account.update).toHaveBeenCalledWith({ provider: "default", values: {} });
  expect(onProviderChange).not.toHaveBeenCalled();
});

/** Types into the field labelled `label` the way a person pasting would. */
function paste(label: string, text: string) {
  const id = [...host.querySelectorAll("label")].find(
    (node) => node.textContent === label,
  )?.htmlFor;
  const input = host.querySelector<HTMLInputElement>(`[id="${id}"]`);
  if (!input) throw new Error(`no ${label} field`);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("requires credentials again after changing the destination", async () => {
  account.get.mockResolvedValue(saved);
  await act(async () => root.render(settings({ scope: "account" })));
  await act(flush);
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')?.required).toBe(false);
  await act(async () => paste("Gateway", "https://other.example.com/mcp"));
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')?.required).toBe(true);
});

it("hides the account form when no provider supports accounts", async () => {
  account.get.mockResolvedValue({ ...saved, providers: [] });
  await act(async () => root.render(settings({ scope: "account" })));
  await act(flush);
  expect(host.querySelector("form")).toBeNull();
});

it("blocks the fields while a save is in flight", async () => {
  account.get.mockResolvedValue(saved);
  let finishSave!: () => void;
  account.update.mockReturnValue(
    new Promise((resolve) => {
      finishSave = () => resolve(saved);
    }),
  );
  await act(async () => root.render(settings({ scope: "account" })));
  await act(flush);

  await act(async () => host.querySelector("form")?.requestSubmit());
  // The response replaces the draft, so an edit accepted meanwhile would be
  // silently lost while the form still claims "Saved".
  expect(host.querySelector("fieldset")?.disabled).toBe(true);
  expect(host.querySelector('[role="combobox"]')?.matches(":disabled")).toBe(true);

  finishSave();
  await act(async () => {});
  expect(host.querySelector("fieldset")?.disabled).toBe(false);
});

it("saves once when submitted twice in a row", async () => {
  account.get.mockResolvedValue(saved);
  const saving = deferred<typeof saved>();
  account.update.mockReturnValue(saving.promise);
  await act(async () => root.render(settings({ scope: "account" })));
  await act(flush);
  await act(async () => {
    host.querySelector("form")?.requestSubmit();
    host.querySelector("form")?.requestSubmit();
  });
  expect(account.update).toHaveBeenCalledOnce();
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  await act(async () => saving.resolve(saved));
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
});

it("says why the settings were not saved and offers the form again", async () => {
  account.get.mockResolvedValue(saved);
  account.update.mockRejectedValue({ code: "INTERNAL_SERVER_ERROR" });
  await act(async () => root.render(settings({ scope: "account" })));
  await act(flush);
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not save computer settings",
  );
  expect(host.querySelector("fieldset")?.disabled).toBe(false);
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
});

/** Another screen showing the account, which carries what the deployment runs. */
function Account() {
  useQuery(useSpaceQueries().me.queryOptions());
  return null;
}

it("reports the deployment's provider and reads the account again", async () => {
  deployment.get.mockResolvedValue(saved);
  deployment.update.mockResolvedValue(saved);
  me.mockResolvedValue({ sandboxProvider: "docker" });
  const onProviderChange = vi.fn();
  await act(async () =>
    root.render(settings({ scope: "deployment", onProviderChange }, <Account />)),
  );
  await act(flush);
  expect(me).toHaveBeenCalledOnce();
  await act(async () => host.querySelector("form")?.requestSubmit());
  await vi.waitFor(() => expect(onProviderChange).toHaveBeenCalledWith("personal-desktop"));
  expect(deployment.update).toHaveBeenCalledWith({
    provider: saved.provider,
    values: saved.values,
  });
  expect(me).toHaveBeenCalledTimes(2);
});

it("lets an optional choice go back to the provider's default", async () => {
  const withRegion = {
    ...saved,
    providers: [
      {
        ...saved.providers[0]!,
        fields: [
          ...saved.providers[0]!.fields,
          {
            key: "region",
            label: "Region",
            kind: "select",
            required: false,
            options: [{ value: "eu", label: "Europe" }],
          },
        ],
      },
    ],
    values: { ...saved.values, region: "eu" },
  };
  account.get.mockResolvedValue(withRegion);
  account.update.mockResolvedValue(withRegion);
  await act(async () => root.render(settings({ scope: "account" })));
  await act(flush);
  const id = [...host.querySelectorAll("label")].find(
    (node) => node.textContent === "Region",
  )?.htmlFor;
  const trigger = document.getElementById(id ?? "");
  expect(trigger?.textContent).toContain("Europe");
  await act(async () => trigger?.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (node) => node.textContent === "Default",
  );
  await act(async () => option?.click());
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(account.update).toHaveBeenCalledWith({
    provider: saved.provider,
    values: { ...saved.values, region: "" },
  });
});

it("saves a prepared runtime's origin, secret and TLS fingerprint in the Space without paid provisioning", async () => {
  const runtime = {
    provider: "prepared-runtime",
    defaultProvider: "docker",
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
            required: true,
            validation: "operator-https",
          },
          {
            key: "token",
            label: "Access token",
            kind: "secret",
            required: true,
            destination: "url",
          },
          { key: "fingerprint", label: "Certificate fingerprint", kind: "text", required: true },
        ],
      },
    ],
    values: { url: "https://runtime.example.test:8443", fingerprint: "A".repeat(43) },
    savedSecrets: { token: true },
    connectionId: "runtime-connection",
  };
  space.get.mockResolvedValue(runtime);
  space.update.mockResolvedValue(runtime);
  await act(async () => root.render(settings({ scope: "space" })));
  await act(flush);
  expect(host.querySelector('[role="checkbox"]')).toBeNull();
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("");
  await act(async () => paste("Access token", "replacement-runtime-token"));
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(space.update).toHaveBeenCalledWith({
    provider: runtime.provider,
    values: { ...runtime.values, token: "replacement-runtime-token" },
    expectedConnectionId: runtime.connectionId,
  });
  expect(deployment.update).not.toHaveBeenCalled();
  expect(account.update).not.toHaveBeenCalled();
});
