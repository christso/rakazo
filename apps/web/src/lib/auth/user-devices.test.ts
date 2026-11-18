import { USER_DEVICE_PATH } from "@rakazo/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { setAccountIdentity } from "./account-identity";
import { listUserDevices, removeUserDevice } from "./user-devices";

afterEach(() => {
  setAccountIdentity(null);
  vi.unstubAllGlobals();
});

it("reads and validates computers through the browser transport", async () => {
  setAccountIdentity("displayed-user");
  const devices = [{ deviceId: "fixture-device", name: "Laptop", connected: true }];
  const fetchMock = vi.fn(async () => Response.json({ devices }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(listUserDevices()).resolves.toEqual(devices);
  expect(fetchMock).toHaveBeenCalledWith(USER_DEVICE_PATH, {
    headers: new Headers({ "x-rakazo-user-id": "displayed-user" }),
    signal: expect.any(AbortSignal),
  });
});

it("bounds browser list responses", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(" ".repeat(64 * 1024 + 1))),
  );
  await expect(listUserDevices()).rejects.toThrow("Could not load");
});

it("cancels the delete response and treats an absent computer as removed", async () => {
  const cancel = vi.fn();
  const fetchMock = vi.fn(
    async () => new Response(new ReadableStream({ cancel }), { status: 404 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  await expect(removeUserDevice("desk/pc")).resolves.toBeUndefined();
  expect(cancel).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledWith(`${USER_DEVICE_PATH}/desk%2Fpc`, {
    method: "DELETE",
    headers: new Headers(),
    signal: expect.any(AbortSignal),
  });
});
