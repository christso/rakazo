import { lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  dataDir: `/tmp/rakazo-remote-homes-${crypto.randomUUID()}`,
  createContainer: vi.fn(async () => ({ id: "synthetic-container", start: vi.fn() })),
}));
vi.mock("./context.js", () => ({
  dataDir: mock.dataDir,
  docker: { listContainers: async () => [], createContainer: mock.createContainer },
  ensureComputerImage: async () => undefined,
  inspectSupervisorContainer: async () => undefined,
  supervisorInfo: undefined,
  supervisorToken: "synthetic-runtime-token",
  computerEgressSetting: "restricted",
  screenNetworkMode: "published",
  computerMounts: [],
  computerDns: undefined,
  computerComputeGpus: undefined,
  computerBrowserProxyPacUrl: undefined,
  controlViaLoopback: true,
  maxUploadSizeBytes: 8 * 1024 * 1024,
}));
vi.mock("./egress.js", () => ({
  computerEgressMode: "restricted",
  ensureRestrictedEgressEnforced: async () => undefined,
}));
vi.mock("./networks.js", async (original) => ({
  ...(await original<typeof import("./networks.js")>()),
  ensureBotNetwork: async () => ({ remove: async () => undefined }),
}));

import { supervisorApp } from "./routes.js";

afterEach(() => vi.restoreAllMocks());
afterAll(() => rm(mock.dataDir, { recursive: true, force: true }));
function provision(botId: string) {
  return supervisorApp.request("/computers", {
    method: "POST",
    headers: {
      authorization: "Bearer synthetic-runtime-token",
      "content-type": "application/json",
      "x-rakazo-bot-id": botId,
      "x-rakazo-space-id": "space-a",
    },
    body: JSON.stringify({
      botId,
      spaceId: "space-a",
      homePath: path.join(mock.dataDir, "homes", botId),
    }),
  });
}

it.skipIf(process.getuid?.() === 0)(
  "a non-root prepared runtime creates new bot homes before starting their containers",
  async () => {
    await mkdir(path.join(mock.dataDir, "homes"), { recursive: true });
    for (const bot of ["bot-a", "bot-b"]) {
      const home = path.join(mock.dataDir, "homes", bot);
      await expect(lstat(home)).rejects.toMatchObject({ code: "ENOENT" });
      const response = await provision(bot);
      expect(await response.json()).toMatchObject({ id: "synthetic-container", resumed: false });
      expect(response.status).toBe(200);
      expect((await lstat(home)).uid).toBe(process.getuid?.());
    }
    expect(mock.createContainer).toHaveBeenCalledTimes(2);
  },
);

it("a root supervisor still refuses to create a missing user-controlled home", async () => {
  vi.spyOn(process, "getuid").mockReturnValue(0);
  const count = mock.createContainer.mock.calls.length;
  const response = await provision("missing-root-home");
  expect(response.status).toBe(500);
  expect(mock.createContainer).toHaveBeenCalledTimes(count);
  await expect(lstat(path.join(mock.dataDir, "homes", "missing-root-home"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
