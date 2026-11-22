import { z } from "zod";

/** Owner-session revoke: DELETE `${USER_DEVICE_PATH}/:deviceId`. Device-token self revoke: DELETE `${USER_DEVICE_PATH}/self`. */
export const USER_DEVICE_PATH = "/api/devices";
export const USER_DEVICE_PAIR_PATH = `${USER_DEVICE_PATH}/pair`;
export const USER_DEVICE_CONNECT_PATH = `${USER_DEVICE_PATH}/connect`;
/** POST with the device token and the sign-in cookie: ties a pairing that predates session tracking to that sign-in. */
export const USER_DEVICE_SESSION_PATH = `${USER_DEVICE_PATH}/self/session`;

export const userDevicePairRequest = z.object({
  name: z.string().min(1).max(128),
  platform: z.enum(["darwin", "win32", "linux"]),
});
export type UserDevicePairRequest = z.infer<typeof userDevicePairRequest>;

export interface UserDevicePairResponse {
  deviceId: string;
  /** The account it was paired for. This computer's consent belongs to that account. */
  userId: string;
  /** Shown once. The server keeps only its hash. */
  token: string;
}

export const userDeviceListSchema = z.object({
  devices: z.array(
    z.object({
      deviceId: z.string(),
      name: z.string(),
      platform: z.string().optional(),
      connected: z.boolean(),
      bound: z.boolean().optional(),
    }),
  ),
});
export type UserDeviceList = z.infer<typeof userDeviceListSchema>;
export type UserDeviceSummary = UserDeviceList["devices"][number];

const screenCoordinate = z.number().min(0).max(1);
export const pairedScreenInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pointer"),
    phase: z.enum(["down", "move", "up"]),
    x: screenCoordinate,
    y: screenCoordinate,
    button: z.enum(["left", "right", "middle"]),
  }),
  z.object({
    kind: z.literal("wheel"),
    x: screenCoordinate,
    y: screenCoordinate,
    delta: z.number().int().min(-1200).max(1200),
  }),
  z.object({
    kind: z.literal("key"),
    key: z.string().min(1).max(32),
    code: z.string().max(32),
    ctrl: z.boolean(),
    alt: z.boolean(),
    shift: z.boolean(),
  }),
]);
export type PairedScreenInput = z.infer<typeof pairedScreenInput>;

const screenId = z.uuid();
export const pairedScreenRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open") }),
  z.object({ action: z.literal("frame"), id: screenId }),
  z.object({ action: z.literal("takeControl"), id: screenId }),
  z.object({ action: z.literal("releaseControl"), id: screenId, controlId: screenId }),
  z.object({
    action: z.literal("input"),
    id: screenId,
    controlId: screenId,
    input: pairedScreenInput,
  }),
  z.object({ action: z.literal("close"), id: screenId }),
]);
export type PairedScreenRequest = z.infer<typeof pairedScreenRequest>;

export const pairedScreenFrame = z.object({
  jpeg: z
    .string()
    .regex(/^[a-z0-9+/]+={0,2}$/i)
    .max(1024 * 1024),
});
