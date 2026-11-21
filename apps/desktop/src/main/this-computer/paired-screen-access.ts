import { rm } from "node:fs/promises";
import path from "node:path";
import type { UserDeviceClientOptions } from "@rakazo/adapters/user-device-client";
import type { readPrivateFile, writePrivateFile } from "../setup/setup-store.js";

type ScreenAccess = NonNullable<UserDeviceClientOptions["pairedScreen"]>;

export async function createWindowsScreenAccess(
  userDataDir: string,
  pairedDeviceId: (origin: string) => string | null,
  confirm: (signal: AbortSignal) => Promise<boolean>,
  storage: { read: typeof readPrivateFile; write: typeof writePrivateFile },
) {
  const file = path.join(userDataDir, "paired-screen-consent.json");
  let saved = await storage.read(file, 4096);
  let saving = false;
  let active: { origin: string } | undefined;
  let access: ScreenAccess | undefined;

  function deviceKey(origin: string) {
    const deviceId = pairedDeviceId(origin);
    return deviceId ? JSON.stringify([origin, deviceId]) : null;
  }

  function alwaysAllow(origin: string) {
    const key = deviceKey(origin);
    return !saving && key !== null && saved === key;
  }

  return {
    state(origin: string) {
      return { enabled: deviceKey(origin) !== null && !saving, checked: alwaysAllow(origin) };
    },
    async setAlwaysAllow(origin: string, enabled: boolean) {
      const key = deviceKey(origin);
      if (saving || !key) return;
      saving = true;
      try {
        if (enabled) {
          await storage.write(file, key);
          saved = key;
        } else {
          saved = null;
          access?.clear();
          await rm(file, { force: true });
        }
      } finally {
        saving = false;
      }
    },
    stop: () => access?.clear(),
    connect(origin: string): ScreenAccess {
      access?.clear();
      const connection = { origin };
      active = connection;
      return {
        controlling: () => active === connection && (access?.controlling() ?? false),
        clear: () => {
          if (active === connection) access?.clear();
        },
        async request(owner, request, signal, canTakeControl) {
          if (!access) {
            const { createWindowsPairedScreen } = await import("./paired-screen-windows.js");
            signal.throwIfAborted();
            if (active !== connection) throw new Error("Paired screen session ended");
            access ??= createWindowsPairedScreen((promptSignal) =>
              active && alwaysAllow(active.origin) ? Promise.resolve(true) : confirm(promptSignal),
            );
          }
          if (active !== connection) throw new Error("Paired screen session ended");
          return access.request(owner, request, signal, canTakeControl);
        },
      };
    },
  };
}
