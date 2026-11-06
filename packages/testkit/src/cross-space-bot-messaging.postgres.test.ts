import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { createApp } from "@rakazo/api/app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

const available = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5180";
type Peer = { id: string; spaceId: string; name: string };
type Snapshot = {
  activeRuns: unknown[];
  messages: Array<{ blocks: Array<Record<string, unknown>> }>;
};

describe.skipIf(!available)("native bot messaging across private Spaces", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let folder: string;
  let cookie: string;
  let source: Peer;
  let local: Peer;
  let remote: Peer;

  async function rpc<T>(route: string, body: unknown, spaceId?: string): Promise<T> {
    const response = await handles.app.request(`/rpc/${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        cookie,
        ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      },
      body: JSON.stringify({ json: body }),
    });
    if (!response.ok) throw new Error(`${route} returned ${response.status}`);
    return ((await response.json()) as { json: T }).json;
  }

  const snapshot = (bot: Peer) => rpc<Snapshot>("threads/get", { botId: bot.id }, bot.spaceId);
  const blocks = (chat: Snapshot) => chat.messages.flatMap((message) => message.blocks);

  async function send(target: Peer, marker: string) {
    const { runId } = await rpc<{ runId: string }>(
      "threads/send",
      { botId: source.id, text: `message the bot named ${target.name} saying ${marker}` },
      source.spaceId,
    );
    const db = asSystem(handles.prisma);
    await expect
      .poll(async () => (await db.run.findUnique({ where: { id: runId } }))?.status)
      .toBe("completed");
  }

  beforeAll(async () => {
    folder = await mkdtemp(path.join(tmpdir(), "bot-messaging-spaces-"));
    const { createApp } = await import("@rakazo/api/app");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      authUrl: origin,
      webOrigin: origin,
      dataDir: folder,
      agentRuntime: "scripted",
      sandboxProvider: "fake",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      signupAllowlist: "",
      adminEmails: [],
      breachedPasswordCheck: false,
    });
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        name: "Test User",
        email: `testuser-${randomUUID()}@example.test`,
        password: "synthetic-test-password-12345",
      }),
    });
    expect(response.status).toBe(200);
    cookie = sessionCookieHeader(response);
    const me = await rpc<{ spaceId: string; isAdmin: boolean; isDeploymentOwner: boolean }>(
      "me",
      {},
    );
    expect(me.isAdmin).toBe(false);
    expect(me.isDeploymentOwner).toBe(false);
    const other = await rpc<{ id: string }>("spaces/create", { name: "Other test Space" });
    async function create(name: string, spaceId: string) {
      const peer = await rpc<Peer>(
        "bots/create",
        {
          name,
          title: "Synthetic fixture",
          description: "Messaging fixture",
          instructions: "Only handle the synthetic test task.",
        },
        spaceId,
      );
      await rpc("bots/update", { botId: peer.id, crossSpaceCommunication: true }, spaceId);
      return peer;
    }
    source = await create("Sender", me.spaceId);
    local = await create("LocalPeer", me.spaceId);
    remote = await create("RemotePeer", other.id);
    await rpc("autoReview/set", { mode: "never" }, source.spaceId);
  });

  afterAll(async () => {
    await handles?.stop();
    if (folder) await rm(folder, { recursive: true, force: true });
  });

  it("delivers a same-Space request and returns its result", async () => {
    const marker = "same-space-control";
    await send(local, marker);
    await expect
      .poll(async () =>
        blocks(await snapshot(local)).some(
          (block) => block.kind === "bot_message_received" && block.text === marker,
        ),
      )
      .toBe(true);
    await expect
      .poll(async () =>
        blocks(await snapshot(source)).some(
          (block) =>
            block.kind === "bot_message_received" &&
            block.fromBotId === local.id &&
            block.intent === "result",
        ),
      )
      .toBe(true);
    await expect.poll(async () => (await snapshot(source)).activeRuns.length).toBe(0);
  });

  // Known defect: the enabled setting promises this route, but message_bot only finds the current Space.
  // This expected failure becomes an unexpected pass when the product fixes the route.
  it.fails("delivers across Spaces when both bots explicitly allow cross-Space communication", async () => {
    const marker = "cross-space-enabled";
    await send(remote, marker);
    expect(
      blocks(await snapshot(remote)).some(
        (block) => block.kind === "bot_message_received" && block.text === marker,
      ),
    ).toBe(true);
  });

  it("does not deliver across Spaces when the recipient disables communication", async () => {
    const before = blocks(await snapshot(remote)).filter(
      (block) => block.kind === "bot_message_received",
    ).length;
    await rpc("bots/update", { botId: remote.id, crossSpaceCommunication: false }, remote.spaceId);
    await send(remote, "cross-space-disabled");
    expect(
      blocks(await snapshot(remote)).filter((block) => block.kind === "bot_message_received"),
    ).toHaveLength(before);
  });
});
