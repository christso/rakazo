import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentDesktopRun } from "@rakazo/adapters/agent-desktop-host-screen";

type Workbench = {
  run: AgentDesktopRun;
  recordToolCall(): void;
  outcome(): {
    saved: { summary: string; assignee: string; inspectionCode?: string } | null;
    toolCalls: number;
    screenshots: number;
  };
};

const models = {
  "openai/gpt-6.2-sol": "openai",
  "deepseek/deepseek-v4.1-flash": "deepinfra/fp8",
} as const;

type TrialInput = {
  prompt: string;
  summary: string;
  assignee: string;
  badge?: string;
  model: keyof typeof models;
};

const root = process.argv[2]!;
const resultFile = process.argv[3]!;
const input = JSON.parse(process.argv[4]!) as TrialInput;
const fixture = pathToFileURL(process.argv[5]!).href;
if (!Object.hasOwn(models, input.model)) throw new Error("Unknown eval model");
const apiKey = process.env.RAKAZO_EVAL_OPENROUTER_KEY?.trim();
if (!apiKey) throw new Error("Set RAKAZO_EVAL_OPENROUTER_KEY");
const route = models[input.model];
const from = (file: string) => pathToFileURL(join(root, file)).href;

const { disposableDatabaseEnv, startPostgres } = (await import(
  from("packages/testkit/src/cli/postgres.ts")
)) as typeof import("../cli/postgres.js");
const dataDir = await mkdtemp(join(tmpdir(), "rakazo-windows-eval-"));
const db = await startPostgres();
const databaseUrl = db.getConnectionUri();

try {
  Object.assign(process.env, {
    ...disposableDatabaseEnv(databaseUrl),
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    SANDBOX_SUPERVISOR_TOKEN: randomBytes(32).toString("hex"),
    SCREEN_PROXY_SECRET: randomBytes(32).toString("hex"),
    BETTER_AUTH_URL: "http://127.0.0.1:5173",
    WEB_ORIGIN: "http://127.0.0.1:5173",
    LOG_LEVEL: "error",
  });
  execFileSync("./node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: join(root, "packages/db"),
    env: { ...process.env, ...disposableDatabaseEnv(databaseUrl) },
    stdio: "pipe",
    timeout: 120_000,
  });
  const [
    { createApp },
    { runTrial },
    { EvalSandboxProvider },
    { PiAgentRuntime, dispatcherFetch },
    { createAgentDesktopHostScreen },
    { makeWorkbench, workbenchApp },
  ] = await Promise.all([
    import(from("apps/api/src/app.ts")) as Promise<typeof import("@rakazo/api/app")>,
    import(from("packages/testkit/src/evals/runner.ts")) as Promise<typeof import("./runner.js")>,
    import(from("packages/testkit/src/evals/sandbox.ts")) as Promise<typeof import("./sandbox.js")>,
    import(from("packages/adapters/src/index.ts")) as Promise<typeof import("@rakazo/adapters")>,
    import(from("packages/adapters/src/computers/screens/agent-desktop-host-screen.ts")) as Promise<
      typeof import("@rakazo/adapters/agent-desktop-host-screen")
    >,
    import(fixture) as Promise<{
      makeWorkbench: (badge?: string) => Workbench;
      workbenchApp: string;
    }>,
  ]);
  const bench = makeWorkbench(input.badge);
  const screen = createAgentDesktopHostScreen({ run: bench.run, selfPid: -1 });
  const device = {
    deviceId: "fixture",
    name: "Fixture Windows",
    platform: "win32",
    screenOnly: true,
  };
  type Gateway = NonNullable<NonNullable<Parameters<typeof createApp>[0]>["userDevices"]>;
  type Request = Parameters<Gateway["request"]>[1];
  const gateway: Gateway = {
    async connected(_owner, id) {
      return id === undefined || id === device.deviceId ? device : null;
    },
    async list() {
      return [{ ...device, bound: true, connected: true }];
    },
    async pairedSince() {
      return new Date(0);
    },
    async *request<T>(_owner: string, request: Request, signal: AbortSignal) {
      if (
        (request.method !== "screenObserve" && request.method !== "screenAct") ||
        request.app.toLowerCase() !== workbenchApp
      )
        throw new Error("The fixture only drives workbench.");
      bench.recordToolCall();
      const scope = { botId: request.botId, signal };
      if (request.method === "screenObserve")
        yield (await screen.observe(scope, request.app, request)) as T;
      else yield (await screen.act(scope, request.app, request.actions, request)) as T;
    },
  };

  let imageRequests = 0;
  // OpenRouter uses the pinned route for every request on this trial.
  const modelFetch: typeof fetch = (request, init) => {
    const url = new URL(request instanceof Request ? request.url : request);
    if (url.origin !== "https://openrouter.ai" || typeof init?.body !== "string")
      throw new Error("Unexpected model request");
    const body = JSON.parse(init.body) as {
      messages?: Array<{ content?: string | Array<{ type: string }> }>;
    };
    if (
      body.messages?.some(
        ({ content }) => Array.isArray(content) && content.some(({ type }) => type === "image_url"),
      )
    )
      imageRequests++;
    return dispatcherFetch(request, {
      ...init,
      body: JSON.stringify({ ...body, provider: { only: [route], allow_fallbacks: false } }),
    });
  };

  let calls = 0;
  const runtime = new PiAgentRuntime({
    modelFetch,
    modelCallObserver: {
      beforeCall: () => {
        if (++calls > 18) throw new Error("Eval model call budget exhausted");
        return String(calls);
      },
      afterCall: () => {},
    },
  });

  const trial = await runTrial(
    {
      id: "native-windows",
      purpose: "Save the requested record through the paired Windows app",
      connections: [],
      steps: [{ ask: input.prompt }],
      grade: () => {
        const { saved, screenshots } = bench.outcome();
        return [
          {
            id: "saved-correct-order",
            pass:
              saved?.summary === input.summary &&
              saved?.assignee === input.assignee &&
              saved?.inspectionCode === input.badge,
          },
          ...(input.badge
            ? [{ id: "screenshot-sent-to-model", pass: screenshots > 0 && imageRequests > 0 }]
            : []),
        ];
      },
    },
    0,
    {
      connection: {
        provider: "openrouter",
        modelId: input.model,
        apiKey,
        maxTokens: 4_096,
      },
      maxToolCalls: 18,
      timeoutMs: 230_000,
      createApp: async (composio, messaging) => {
        const handles = await createApp({
          runtime,
          modelConnectionFetch: modelFetch,
          sandbox: new EvalSandboxProvider(),
          userDevices: gateway,
          databaseUrl,
          realtimeDatabaseUrl: databaseUrl,
          dataDir,
          sandboxProvider: "fake",
          agentRuntime: "pi",
          wakeupDriver: "memory",
          composio,
          messaging,
          web: composio.web,
          defaultProvider: "openrouter",
          defaultModel: input.model,
          deploymentModelKey: undefined,
          cloudAgentProvider: "none",
          signupsEnabled: "true",
          signupAllowlist: "",
          emailEmulator: true,
          emailProvider: "none",
          mcpStdioEnabled: false,
          mcpStdioAllowedCommands: [],
        });
        return {
          ...handles,
          // Grant the paired synthetic app access through the same settings RPC as an owner.
          app: {
            async request(url, options) {
              if (url === "/rpc/threads/send") {
                const allowed = await handles.app.request("/rpc/autoReview/set", {
                  ...options,
                  body: JSON.stringify({ json: { mode: "never" } }),
                });
                if (!allowed.ok) throw new Error("Could not set fixture approval mode");
              }
              const response = await handles.app.request(url, options);
              // GPT-6.2 Sol is newer than the OpenRouter catalog bundled in these refs.
              // Save the vision setting through the normal API for an uncatalogued model.
              if (
                url === "/rpc/models/connect" &&
                response.ok &&
                input.model === "openai/gpt-6.2-sol"
              ) {
                const { json: credential } = (await response.clone().json()) as {
                  json: { id: string };
                };
                const configured = await handles.app.request("/rpc/models/saveModelSettings", {
                  ...options,
                  body: JSON.stringify({
                    json: {
                      credentialId: credential.id,
                      modelId: input.model,
                      settings: { images: true, maxTokens: 4_096 },
                    },
                  }),
                });
                if (!configured.ok) throw new Error("Could not set fixture model image support");
              }
              return response;
            },
          },
        };
      },
    },
  );
  const { toolCalls, screenshots } = bench.outcome();
  const {
    status,
    category,
    reason,
    criteria,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    modelCalls,
    totalTokens,
    costUsd,
    latencyMs,
    trace,
  } = trial;
  await writeFile(
    resultFile,
    JSON.stringify({
      revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      status,
      category,
      reason,
      criteria,
      model: input.model,
      route,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      modelCalls,
      totalTokens,
      costUsd,
      toolCalls,
      screenshots,
      imageRequests,
      latencyMs,
      trace: trace.map(({ step, status, tools }) => ({ step, status, tools })),
    }),
    { mode: 0o600 },
  );
} finally {
  try {
    await db.stop();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}
