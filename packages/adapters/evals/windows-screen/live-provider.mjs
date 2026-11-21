import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const runner = fileURLToPath(
  new URL("../../../testkit/src/evals/windows-screen-run.ts", import.meta.url),
);
const fixture = fileURLToPath(new URL("./fixture.ts", import.meta.url));

export default class RakazoWindows {
  constructor({ config }) {
    const { model, variant } = config;
    this.model = model;
    if (variant !== "base" && variant !== "pr") throw new Error("Expected base or pr");
    const envKey = variant === "base" ? "RAKAZO_EVAL_BASE" : "RAKAZO_EVAL_PR";
    if (!process.env[envKey]) throw new Error(`Set ${envKey} to the prepared Git checkout`);
    this.root = resolve(process.env[envKey]);
    this.label = `${model} ${variant}`;
  }

  id() {
    return this.label;
  }

  async callApi(prompt, { vars: { summary, assignee, badge } }, { abortSignal } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "rakazo-promptfoo-"));
    const resultPath = join(dir, "result.json");
    const apiKey = process.env.RAKAZO_EVAL_OPENROUTER_KEY;
    try {
      if (!apiKey) throw new Error("Set RAKAZO_EVAL_OPENROUTER_KEY");
      await run(
        join(this.root, "node_modules", ".bin", "tsx"),
        [
          runner,
          this.root,
          resultPath,
          JSON.stringify({ prompt, summary, assignee, badge, model: this.model }),
          fixture,
        ],
        {
          cwd: this.root,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            DOCKER_HOST: process.env.DOCKER_HOST,
            XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
            RAKAZO_EVAL_OPENROUTER_KEY: apiKey,
          },
          signal: abortSignal,
          timeout: 420_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      const trial = JSON.parse(await readFile(resultPath, "utf8"));
      const promptTokens =
        trial.totalTokens !== null && trial.outputTokens !== null
          ? trial.totalTokens - trial.outputTokens
          : null;
      return {
        output: { ...trial, promptTokens },
        ...(trial.costUsd !== null ? { cost: trial.costUsd } : {}),
        tokenUsage: {
          ...(promptTokens !== null ? { prompt: promptTokens } : {}),
          ...(trial.outputTokens !== null ? { completion: trial.outputTokens } : {}),
          ...(trial.cacheReadTokens !== null ? { cached: trial.cacheReadTokens } : {}),
          ...(trial.totalTokens !== null ? { total: trial.totalTokens } : {}),
          numRequests: trial.modelCalls,
        },
      };
    } catch (error) {
      const detail = (error.stderr || error.message || "Rakazo eval process failed").trim();
      return { error: (apiKey ? detail.replaceAll(apiKey, "[redacted]") : detail).slice(-2_000) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
