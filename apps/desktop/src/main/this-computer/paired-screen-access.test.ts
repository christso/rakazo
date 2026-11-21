import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { readPrivateFile, writePrivateFile } from "../setup/setup-store.js";
import { createWindowsScreenAccess } from "./paired-screen-access.js";

vi.mock("./paired-screen-windows.js", () => ({
  createWindowsPairedScreen: (confirm: (signal: AbortSignal) => Promise<boolean>) => ({
    clear: vi.fn(),
    controlling: () => false,
    request: async (_owner: string, _request: unknown, signal: AbortSignal) => ({
      allowed: await confirm(signal),
    }),
  }),
}));

it("remembers prompt-free access only for the pairing that opted in", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "rakazo-screen-consent-"));
  const origin = "https://rakazo.example.test";
  const otherOrigin = "https://other.example.test";
  let deviceId = "original-pairing";
  const lookup = () => deviceId;
  const prompt = vi.fn(async () => false);
  const storage = { read: readPrivateFile, write: writePrivateFile };
  const open = { action: "open" } as const;
  const signal = new AbortController().signal;
  try {
    const fresh = await createWindowsScreenAccess(directory, lookup, prompt, storage);
    expect(fresh.state(origin)).toEqual({ checked: false, enabled: true });
    const first = fresh.connect(origin);
    await expect(first.request("viewer", open, signal, () => true)).resolves.toEqual({
      allowed: false,
    });
    expect(prompt).toHaveBeenCalledOnce();
    await fresh.setAlwaysAllow(origin, true);

    const restored = await createWindowsScreenAccess(directory, lookup, prompt, storage);
    expect(restored.state(origin).checked).toBe(true);
    expect(restored.state(otherOrigin).checked).toBe(false);
    const connection = restored.connect(origin);
    await expect(connection.request("viewer", open, signal, () => true)).resolves.toEqual({
      allowed: true,
    });
    expect(prompt).toHaveBeenCalledOnce();

    deviceId = "replacement-pairing";
    const replacement = restored.connect(origin);
    await expect(connection.request("viewer", open, signal, () => true)).rejects.toThrow(
      "session ended",
    );
    await expect(replacement.request("viewer", open, signal, () => true)).resolves.toEqual({
      allowed: false,
    });
    expect(prompt).toHaveBeenCalledTimes(2);

    deviceId = "original-pairing";
    await restored.setAlwaysAllow(origin, false);
    const afterRevoking = await createWindowsScreenAccess(directory, lookup, prompt, storage);
    expect(afterRevoking.state(origin).checked).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
