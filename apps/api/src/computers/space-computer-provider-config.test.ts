import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ComputerProviderConfigDeps } from "./computer-provider-config.js";
import { updateSpaceComputerSettings } from "./space-computer-provider-config.js";

const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: false,
};

describe("Space connection version checks", () => {
  it.each([null, undefined, "previous-connection"])(
    "refuses stale credentials and approval before reading any saved secret (expected=%s)",
    async (expectedConnectionId) => {
      const deps = {
        prisma: {
          spaceMember: {
            findUnique: vi.fn(async () => ({
              role: "owner",
              member: { role: "owner" },
              space: { deletingAt: null },
            })),
          },
          space: {
            findUniqueOrThrow: vi.fn(async () => ({
              computerConnectionId: "current-connection",
              computerConnection: { id: "current-connection", ciphertext: "sealed-current" },
            })),
          },
        },
        env: { computerSettingsEnabled: true },
        secrets: { load: vi.fn(), put: vi.fn() },
        verifyConnection: vi.fn(),
      } as unknown as ComputerProviderConfigDeps;
      for (const provider of ["cloud-test", "default"]) {
        await expect(
          updateSpaceComputerSettings(deps, actor, {
            provider,
            values: {},
            approveSpending: true,
            expectedConnectionId,
          }),
        ).rejects.toMatchObject({ kind: "CONFLICT" });
      }
      expect(deps.secrets.load).not.toHaveBeenCalled();
      expect(deps.secrets.put).not.toHaveBeenCalled();
      expect(deps.verifyConnection).not.toHaveBeenCalled();
    },
  );
});
