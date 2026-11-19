import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import type { ComputerProviderDefinition } from "../../../computers/computer-provider-descriptor.js";
import { validateCloudImages } from "../../../computers/sandbox/cloud-runtime/cloud-bootstrap.js";

function validateLocation(values: Record<string, string>) {
  if (
    !/^[a-z0-9-]{1,32}$/.test(values.region ?? "") ||
    !/^[a-z0-9-]{1,64}$/.test(values.plan ?? "")
  )
    throw new Error("Enter a cloud region code and machine plan ID");
  validateCloudImages(values);
}

export const vultrComputer: ComputerProviderDefinition = {
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
  unavailable: () => true,
  settings: {
    displayName: "Vultr Cloud",
    spaceOnly: true,
    requiresSpendingApproval: true,
    spendingApprovalMessage:
      "Servers remain billable when stopped. Delete them to stop server charges.",
    fields: [
      { key: "apiToken", label: "API token", kind: "secret", required: true },
      { key: "runtimeSecret", label: "Computer secret", kind: "secret", required: true },
      { key: "region", label: "Region", kind: "text", required: true, placeholder: "ewr" },
      {
        key: "plan",
        label: "Machine plan",
        kind: "text",
        required: true,
        placeholder: "vc2-2c-4gb",
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
    validate: validateLocation,
    async verifyConnection(values, signal) {
      const { VultrClient } = await import("./vultr-client.js");
      await new VultrClient(values.apiToken!, values.region!, values.plan!).verify(signal);
    },
  },
  async create(options) {
    const { CloudRuntimeSandbox } = await import(
      "../../../computers/sandbox/cloud-runtime/cloud-runtime-sandbox.js"
    );
    const { VultrClient } = await import("./vultr-client.js");
    const settings = options.providerSettings ?? {};
    return new CloudRuntimeSandbox(
      "vultr",
      new VultrClient(settings.apiToken!, settings.region!, settings.plan!),
      settings,
      options.unreferencedMachines,
    );
  },
};
