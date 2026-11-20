import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import type { ComputerProviderDefinition } from "../../../computers/computer-provider-descriptor.js";

export const hetznerComputer: ComputerProviderDefinition = {
  capabilities: {
    terminal: true,
    inPlaceUpdate: false,
    nativeShell: false,
    runsOnUserMachine: false,
    screen: DEFAULT_COMPUTER_SCREEN,
    serverHomeMount: "never",
    serverOwnsStoredTeamHome: true,
    storedHomeIsBackup: true,
  },
  // This provider is configured through an authorized connection, never process environment.
  unavailable: () => true,
  settings: {
    displayName: "Hetzner Cloud",
    requiresSpendingApproval: true,
    hibernate: true,
    spendingApprovalMessage:
      "Servers remain billable when stopped; delete them to stop server charges.",
    fields: [
      { key: "apiToken", label: "API token", kind: "secret", required: true },
      { key: "runtimeSecret", label: "Computer secret", kind: "secret", required: true },
      { key: "location", label: "Region", kind: "text", required: true, placeholder: "fsn1" },
      {
        key: "serverType",
        label: "Machine type",
        kind: "text",
        required: true,
        placeholder: "cx23",
      },
      {
        key: "appImage",
        label: "Runtime image",
        kind: "text",
        required: true,
        placeholder: "registry.example.com/app@sha256:…",
        advanced: true,
      },
      {
        key: "computerImage",
        label: "Desktop image",
        kind: "text",
        required: true,
        placeholder: "registry.example.com/computer@sha256:…",
        advanced: true,
      },
    ],
  },
  async create(options) {
    const { HetznerSandboxProvider } = await import("./hetzner-sandbox.js");
    return new HetznerSandboxProvider(
      options.providerSettings ?? {},
      options.unreferencedMachines,
      options.hibernationDb,
    );
  },
};
