import { parseServerHeaders } from "@rakazo/contracts";
import { withAbort } from "@rakazo/core";
import * as SecureStore from "expo-secure-store";
import { serverHeaders } from "./server-headers";

const PENDING_SIGN_OUT_KEY = "rakazo.pending_sign_out";
/**
 * Better-auth expires a session 7 days after its last use, and the signed-out session is not used
 * again; 30 days also covers longer server overrides.
 */
const PENDING_SIGN_OUT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Storage safety cap for the record list; with everything unexpired, the oldest go first. */
const PENDING_SIGN_OUT_LIMIT = 100;

/**
 * A sign-out or server switch whose revocation has not reached its server yet. Kept in the same
 * secure storage as the session, because the token is what the revocation must present.
 */
export type PendingSignOut = {
  apiBase: string;
  token: string;
  headers: Record<string, string>;
  /** When this record was written, so an age bound can retire undeliverable ones. */
  recordedAt: number;
  /** A server switch's record is deliverable only once the switch has committed. */
  provisional?: boolean;
};

/** Records are keyed by server and session, so each signed-out account keeps its own revocation. */
export function samePendingSignOut(left: PendingSignOut, right: PendingSignOut): boolean {
  return left.apiBase === right.apiBase && left.token === right.token;
}

export type PendingSignOutRead = { ok: true; records: PendingSignOut[] } | { ok: false };

/** Records whose session may still be alive on its server. */
export function livePendingSignOuts(records: PendingSignOut[]): PendingSignOut[] {
  const now = Date.now();
  return records.filter((record) => now - record.recordedAt < PENDING_SIGN_OUT_MAX_AGE_MS);
}

let revision = 0;
export const pendingSignOutRevision = () => revision;

let pendingSignOutWrites: Promise<unknown> = Promise.resolve();

export function queuePendingSignOutWrite<T>(step: () => Promise<T>): Promise<T> {
  const result = pendingSignOutWrites.then(step, step);
  pendingSignOutWrites = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function readPendingSignOuts(migrateLegacy = true): Promise<PendingSignOutRead> {
  let stored: string | null = null;
  try {
    stored = await SecureStore.getItemAsync(PENDING_SIGN_OUT_KEY);
  } catch {
    // The store could not be read; the retry stays for a later connectivity window.
    return { ok: false };
  }
  if (!stored) stored = "[]";
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) throw new SyntaxError("not a record list");
    const records: PendingSignOut[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as {
        apiBase?: unknown;
        token?: unknown;
        headers?: unknown;
        recordedAt?: unknown;
        provisional?: unknown;
      };
      if (typeof record.apiBase !== "string" || !record.apiBase) continue;
      if (typeof record.token !== "string" || !record.token) continue;
      if (typeof record.recordedAt !== "number" || !Number.isFinite(record.recordedAt)) continue;
      records.push({
        apiBase: record.apiBase,
        token: record.token,
        headers: parseServerHeaders(record.headers) ?? {},
        recordedAt: record.recordedAt,
        ...(record.provisional === true ? { provisional: true } : {}),
      });
    }
    if (!migrateLegacy) return { ok: true, records };
    const legacyRaw = await SecureStore.getItemAsync("rakazo.revocations");
    if (legacyRaw) {
      let legacy: unknown;
      try {
        legacy = JSON.parse(legacyRaw);
      } catch {
        legacy = [];
      }
      if (Array.isArray(legacy)) {
        for (const entry of legacy) {
          if (
            typeof entry?.id !== "string" ||
            !/^[a-z0-9-]+$/.test(entry.id) ||
            typeof entry.apiBase !== "string"
          )
            continue;
          const token = await SecureStore.getItemAsync(`rakazo.revocation.${entry.id}`);
          if (token && !records.some((row) => row.apiBase === entry.apiBase && row.token === token))
            records.push({
              apiBase: entry.apiBase,
              token,
              headers: serverHeaders(entry.apiBase),
              recordedAt: Date.now(),
            });
        }
        if (!(await writePendingSignOuts(records))) return { ok: false };
        await SecureStore.deleteItemAsync("rakazo.revocations");
        await Promise.all(
          legacy
            .filter((entry) => typeof entry?.id === "string" && /^[a-z0-9-]+$/.test(entry.id))
            .map((entry) => SecureStore.deleteItemAsync(`rakazo.revocation.${entry.id}`)),
        ).catch(() => undefined);
      }
    }
    return { ok: true, records };
  } catch (error) {
    return error instanceof SyntaxError ? { ok: true, records: [] } : { ok: false };
  }
}

export async function writePendingSignOuts(records: PendingSignOut[]): Promise<boolean> {
  try {
    await SecureStore.setItemAsync(PENDING_SIGN_OUT_KEY, JSON.stringify(records));
    revision += 1;
    return true;
  } catch {
    return false;
  }
}

/** Records a revocation to deliver later. False when the store could not be read or written. */
export async function savePendingSignOut(record: PendingSignOut): Promise<boolean> {
  return queuePendingSignOutWrite(async () => {
    const read = await readPendingSignOuts();
    if (!read.ok) return false;
    const kept = livePendingSignOuts(read.records).filter(
      (existing) => !samePendingSignOut(existing, record),
    );
    kept.unshift(record);
    if (!(await writePendingSignOuts(kept.slice(0, PENDING_SIGN_OUT_LIMIT)))) return false;
    // A fresh record gets its first retry at once, whatever an older record last attempted.
    return true;
  });
}

export async function deliverPendingSignOut(
  record: PendingSignOut,
  clientHeaders: Record<string, string> = {},
): Promise<"delivered" | "retry"> {
  const url = `${record.apiBase}/api/auth/sign-out`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await withAbort(
      // Not fetchServer: it reads the headers configured for the current server, and after
      // a switch those belong to the new one — only the record still carries this server's.
      fetch(url, {
        method: "POST",
        // Reject redirects where supported; native fetch also needs response validation below.
        redirect: "error",
        // Bearer only: this server's cookie must not reach the jar other servers share.
        credentials: "omit",
        headers: {
          "content-type": "application/json",
          origin: "rakazo://",
          authorization: `Bearer ${record.token}`,
          ...clientHeaders,
          ...record.headers,
        },
        body: "{}",
        signal: controller.signal,
      }),
      controller.signal,
      "Request timed out",
    );
    // Native fetch can follow redirects; only the sign-out endpoint itself confirms delivery.
    if (response.url) {
      const requested = new URL(url);
      const answered = new URL(response.url);
      if (
        answered.origin !== requested.origin ||
        answered.pathname.replace(/\/$/, "") !== requested.pathname
      ) {
        return "retry";
      }
    } else if (response.redirected) {
      return "retry";
    }
    return response.ok || response.status === 401 ? "delivered" : "retry";
  } catch {
    return "retry";
  } finally {
    clearTimeout(timer);
  }
}

/** Revocation-only credentials never belong in account menus or content requests. */
export async function queueSessionRevocation(apiBase: string, token: string): Promise<void> {
  if (!token) return;
  if (
    !(await savePendingSignOut({
      apiBase,
      token,
      headers: serverHeaders(apiBase),
      recordedAt: Date.now(),
    }))
  )
    throw new Error("Could not save session revocation");
}

export async function completeSessionRevocation(apiBase: string, token: string): Promise<void> {
  await queuePendingSignOutWrite(async () => {
    const read = await readPendingSignOuts();
    if (!read.ok) return;
    if (
      !(await writePendingSignOuts(
        read.records.filter((row) => row.apiBase !== apiBase || row.token !== token),
      ))
    )
      throw new Error("Could not complete session revocation");
  });
}

export async function pendingSessionTokens(apiBase: string): Promise<Set<string>> {
  return queuePendingSignOutWrite(async () => {
    const read = await readPendingSignOuts();
    if (!read.ok) throw new Error("Could not read session revocations");
    return new Set(
      livePendingSignOuts(read.records)
        .filter((row) => row.apiBase === apiBase && !row.provisional)
        .map((row) => row.token),
    );
  });
}

/** Retry committed sign-outs only; a provisional server switch may still roll back. */
export async function retryPendingSessionRevocations(apiBase: string): Promise<void> {
  const read = await queuePendingSignOutWrite(readPendingSignOuts);
  if (!read.ok) return;
  await Promise.all(
    livePendingSignOuts(read.records)
      .filter((row) => row.apiBase === apiBase && !row.provisional)
      .map(async (row) => {
        if ((await deliverPendingSignOut(row)) === "delivered")
          await completeSessionRevocation(row.apiBase, row.token);
      }),
  );
}

/** Serializes record updates without putting network work behind storage operations. */
export async function updatePendingSignOuts(
  transform: (records: PendingSignOut[]) => PendingSignOut[] | undefined,
): Promise<void> {
  await queuePendingSignOutWrite(async () => {
    const read = await readPendingSignOuts();
    if (!read.ok) return;
    const updated = transform(read.records);
    if (updated) await writePendingSignOuts(updated);
  });
}
