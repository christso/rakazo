import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import type { ComputerProviderDefinition } from "../../../computers/computer-provider-descriptor.js";
import { pinRuntimeEndpoint } from "../../../computers/sandbox/supervisor/gateway-endpoint.js";
import { validateRemoteRuntimeSettings } from "./remote-settings.js";

export const remoteComputer: ComputerProviderDefinition = {
  capabilities: {
    terminal: true,
    inPlaceUpdate: true,
    nativeShell: false,
    runsOnUserMachine: false,
    screen: DEFAULT_COMPUTER_SCREEN,
    serverHomeMount: "never",
    serverOwnsStoredTeamHome: true,
    storedHomeIsBackup: true,
  },
  unavailable: () => true,
  settings: {
    displayName: "Remote computer",
    spaceOnly: true,
    fields: [
      {
        key: "apiUrl",
        label: "Runtime URL",
        kind: "url",
        validation: "operator-https",
        required: true,
        placeholder: "https://runtime.example.com",
      },
      {
        key: "apiToken",
        label: "Access token",
        kind: "secret",
        destination: "apiUrl",
        required: true,
      },
      {
        key: "certificateSha256",
        label: "Certificate fingerprint",
        kind: "text",
        required: true,
        placeholder: "A".repeat(43),
      },
    ],
    validate: validateRemoteRuntimeSettings,
    async verifyEndpoint(value, signal, resolveHostname) {
      await pinRuntimeEndpoint(value, { signal, resolveHostname });
    },
    async verifyConnection(values, signal) {
      const { RemoteSupervisorSandboxProvider } = await import("./remote-supervisor.js");
      await new RemoteSupervisorSandboxProvider(values).verifyConnection(signal);
    },
  },
  async create(options) {
    const { RemoteSupervisorSandboxProvider } = await import("./remote-supervisor.js");
    return new RemoteSupervisorSandboxProvider(options.providerSettings ?? {}, {
      unreferencedMachines: options.unreferencedMachines,
    });
  },
};
