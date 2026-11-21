import { rm } from "node:fs/promises";
import path from "node:path";
import type { UserDeviceClientOptions } from "@rakazo/adapters/user-device-client";
import { dialog } from "electron";
import { t } from "../i18n.js";
import { readPrivateFile, writePrivateFile } from "../setup/setup-store.js";

type ScreenAccess = NonNullable<UserDeviceClientOptions["pairedScreen"]>;

export async function createWindowsScreenAccess(
  userDataDir: string,
  pairedDeviceId: (origin: string) => string | null,
) {
  const file = path.join(userDataDir, "paired-screen-consent.json");
  let saved = await readPrivateFile(file, 4096);
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
          await writePrivateFile(file, key);
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
            access ??= createWindowsPairedScreen(async (promptSignal) => {
              if (active && alwaysAllow(active.origin)) return true;
              const { response } = await dialog.showMessageBox({
                type: "question",
                message: t("Share this screen with your Rakazo account?"),
                detail: t(
                  "Your primary display will be visible to the person who requested it. They can take control of your mouse and keyboard until the session ends.",
                ),
                buttons: [t("Cancel"), t("Share screen")],
                defaultId: 0,
                cancelId: 0,
                signal: promptSignal,
              });
              return response === 1;
            });
          }
          if (active !== connection) throw new Error("Paired screen session ended");
          return access.request(owner, request, signal, canTakeControl);
        },
      };
    },
  };
}
