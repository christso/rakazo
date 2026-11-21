import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  signup,
} from "../helpers/helpers";

test("watch a paired Windows device before taking control", async ({ page }, testInfo) => {
  await signup(page, `paired-screen-${randomUUID()}@rakazo.test`, "password12", "Screen Owner");
  await completeOnboarding(page);
  const deviceId = randomUUID();
  const id = randomUUID();
  const controlId = randomUUID();
  const actions: string[] = [];
  const jpeg = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#223151";
    ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = "#fff";
    ctx.fillRect(100, 50, 440, 260);
    ctx.fillStyle = "#747f92";
    ctx.fillRect(100, 50, 440, 28);
    ctx.fillStyle = "#172334";
    ctx.font = "20px sans-serif";
    ctx.fillText("Example desktop", 126, 121);
    return canvas.toDataURL("image/jpeg").split(",")[1]!;
  });
  await page.route("**/api/devices", (route) =>
    route.fulfill({
      json: {
        devices: [
          { deviceId, name: "Windows PC", platform: "win32", connected: true, bound: true },
        ],
      },
    }),
  );
  await page.route(`**/api/devices/${deviceId}/screen`, async (route) => {
    const body = route.request().postDataJSON();
    actions.push(body.action);
    const result =
      body.action === "open"
        ? { id }
        : body.action === "frame"
          ? { jpeg }
          : body.action === "takeControl"
            ? { controlId }
            : null;
    if (body.action === "input" || body.action === "releaseControl")
      expect(body.controlId).toBe(controlId);
    await route.fulfill({ json: { result } });
  });

  const settings = await openUserSettings(page, "general");
  await settings.getByRole("button", { name: "Watch screen" }).click();
  const viewer = page.getByRole("dialog", { name: "Windows PC" });
  await viewer.getByRole("button", { name: "Request screen access" }).click();
  const screen = viewer.getByRole("application", { name: "Remote Windows screen" });
  await expect(screen).toBeVisible();
  await screen.click();
  expect(actions).not.toContain("input");
  await captureScreenshot(page, testInfo, "paired-windows-screen");

  await viewer.getByRole("button", { name: "Take control" }).click();
  await expect(viewer.getByRole("button", { name: "Release control" })).toBeEnabled();
  await screen.click();
  await expect.poll(() => actions.includes("input")).toBe(true);
  await screen.press("Shift+Escape");
  await expect(viewer.getByRole("button", { name: "Take control" })).toBeFocused();
  await expect.poll(() => actions.includes("releaseControl")).toBe(true);
  await viewer.getByRole("button", { name: "Close" }).click();
  await expect.poll(() => actions.includes("close")).toBe(true);
});
