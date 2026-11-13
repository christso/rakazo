import { execFileSync } from "node:child_process";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { measureComputerResources, withComputerResources } from "./computer-resources.js";

const context = { signal: new AbortController().signal } as AdapterContext;
const computer = { id: "c", botId: "b", providerRef: "p", kind: "docker" } as ComputerRef;
const reading = {
  sampledAt: "2026-11-13T00:00:00.000Z",
  sampleMs: 200,
  scope: "cgroup-v2",
  memoryUsedBytes: 900 * 1024 ** 2,
  memoryLimitBytes: 1024 ** 3,
  cpuPercent: 96,
  cpuLimitCores: 1,
};
function provider(output: unknown) {
  return {
    async *execute() {
      yield { type: "stdout", data: JSON.stringify(output) };
      yield { type: "exit", code: 0 };
    },
  } as unknown as SandboxProvider;
}

describe("computer resource feedback", () => {
  it.each([
    {
      scope: "cgroup-v2",
      files: {
        "/proc/self/cgroup": "0::/lab",
        "/sys/fs/cgroup/lab/memory.current": "512",
        "/sys/fs/cgroup/lab/memory.stat": "inactive_file 128",
        "/sys/fs/cgroup/lab/memory.max": "max",
        "/sys/fs/cgroup/lab/cpu.max": "max 100000",
        "/sys/fs/cgroup/lab/cpu.stat": "usage_usec 0",
        "/sys/fs/cgroup/memory.max": "512",
        "/sys/fs/cgroup/cpu.max": "100000 100000",
      },
      expected: { memoryUsedBytes: 384, memoryLimitBytes: 512, cpuLimitCores: 1, cpuPercent: 50 },
    },
    {
      scope: "cgroup-v1",
      aliases: {
        "/sys/fs/cgroup/cpu": "/sys/fs/cgroup/cpu,cpuacct",
        "/sys/fs/cgroup/cpuacct": "/sys/fs/cgroup/cpu,cpuacct",
      },
      files: {
        "/proc/self/cgroup": "5:memory:/lab\n4:cpu,cpuacct:/lab",
        "/sys/fs/cgroup/memory/lab/memory.usage_in_bytes": "512",
        "/sys/fs/cgroup/memory/lab/memory.stat": "total_inactive_file 128",
        "/sys/fs/cgroup/memory/lab/memory.limit_in_bytes": "512",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712",
        "/sys/fs/cgroup/cpu,cpuacct/lab/cpuacct.usage": "0",
        "/sys/fs/cgroup/cpu,cpuacct/lab/cpu.cfs_quota_us": "50000",
        "/sys/fs/cgroup/cpu,cpuacct/lab/cpu.cfs_period_us": "100000",
        "/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us": "-1",
        "/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us": "100000",
        "/sys/fs/cgroup/cpu,cpuacct/cpuacct.usage": "0",
      },
      expected: {
        memoryUsedBytes: 384,
        memoryLimitBytes: 512,
        cpuLimitCores: 0.5,
        cpuPercent: 100,
      },
    },
    {
      scope: "cgroup-v1",
      files: {
        "/proc/self/cgroup": "5:memory:/lab/child\n4:cpu,cpuacct:/lab/child",
        "/sys/fs/cgroup/memory/lab/child/memory.usage_in_bytes": "120",
        "/sys/fs/cgroup/memory/lab/child/memory.stat": "total_inactive_file 0",
        "/sys/fs/cgroup/memory/lab/child/memory.limit_in_bytes": "9223372036854771712",
        "/sys/fs/cgroup/memory/lab/memory.limit_in_bytes": "128",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712",
        "/sys/fs/cgroup/cpu,cpuacct/lab/child/cpuacct.usage": "0",
        "/sys/fs/cgroup/cpu,cpuacct/lab/child/cpu.cfs_quota_us": "-1",
        "/sys/fs/cgroup/cpu,cpuacct/lab/child/cpu.cfs_period_us": "100000",
        "/sys/fs/cgroup/cpu,cpuacct/lab/cpu.cfs_quota_us": "50000",
        "/sys/fs/cgroup/cpu,cpuacct/lab/cpu.cfs_period_us": "100000",
        "/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us": "-1",
        "/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us": "100000",
      },
      expected: {
        memoryUsedBytes: 120,
        memoryLimitBytes: 128,
        memoryPercent: 94,
        memoryPressure: true,
        cpuLimitCores: 0.5,
        cpuPercent: 100,
      },
    },
  ])("reads $scope files and normalizes CPU against its quota", async (testCase) => {
    const { scope, files, expected } = testCase;
    const aliases = "aliases" in testCase ? testCase.aliases : {};
    const fixture = `
import json, pathlib, os, time
files = json.loads(${JSON.stringify(JSON.stringify(files))})
aliases = json.loads(${JSON.stringify(JSON.stringify(aliases))})
def resolve(path, *args, **kwargs):
    value = str(path)
    for alias, target in aliases.items():
        if value == alias or value.startswith(alias + "/"):
            return pathlib.Path(target + value[len(alias):])
    return path
pathlib.Path.resolve = resolve
reads = {}
def text(path, *args, **kwargs):
    key = str(path.resolve())
    reads[key] = reads.get(key, 0) + 1
    if key.endswith("cpu.stat"):
        return "usage_usec " + str((reads[key] - 1) * 100000)
    if key.endswith("cpuacct.usage"):
        return str((reads[key] - 1) * 100000000)
    return files[key]
pathlib.Path.read_text = text
pathlib.Path.exists = lambda path: str(path.resolve()) in files
os.sched_getaffinity = lambda pid: {0, 1, 2, 3}
clock = iter([100.0, 100.2])
time.monotonic = lambda: next(clock)
time.sleep = lambda seconds: None
`;
    const linux = {
      async *execute(_ref: ComputerRef, request: { argv: string[] }) {
        const script = request.argv.at(-1)!;
        const data = execFileSync("python3", ["-I", "-c", fixture + script], {
          encoding: "utf8",
        });
        yield { type: "stdout", data };
        yield { type: "exit", code: 0 };
      },
    } as unknown as SandboxProvider;
    expect(await measureComputerResources(linux, computer, context)).toMatchObject({
      scope,
      ...expected,
    });
  });

  it("reports the computer limit and pressure alongside fresh CPU readings", async () => {
    const resources = await measureComputerResources(provider(reading), computer, context);
    expect(resources).toMatchObject({ ...reading, memoryPercent: 88, memoryPressure: true });
    const result = withComputerResources({ error: "The page did not answer in time." }, resources);
    expect(result).toMatchObject({
      error: "The page did not answer in time.",
      computerResources: resources,
    });
  });

  it("keeps image results and gives the model the pressure warning as text", async () => {
    const resources = await measureComputerResources(provider(reading), computer, context);
    const image = { type: "image", data: "image", mimeType: "image/png" };
    const result = withComputerResources(
      { kind: "agent_tool_result", content: [image], details: { frameId: "f" } },
      resources,
    );
    expect(result).toMatchObject({ details: { frameId: "f", computerResources: resources } });
    expect((result as { content: unknown[] }).content).toContainEqual(image);
    expect((result as { content: { text?: string }[] }).content.at(-1)?.text).toContain(
      "memoryPressure",
    );
  });

  it("reports recovery and does not mistake an unknown limit for free memory", async () => {
    const recovered = await measureComputerResources(
      provider({ ...reading, memoryUsedBytes: 300 * 1024 ** 2 }),
      computer,
      context,
    );
    expect(recovered).toMatchObject({ memoryPressure: false, memoryPercent: 30 });
    const unlimited = await measureComputerResources(
      provider({ ...reading, memoryLimitBytes: null }),
      computer,
      context,
    );
    expect(unlimited).toMatchObject({
      memoryLimitBytes: null,
      memoryPercent: null,
      memoryPressure: false,
    });
  });

  it("leaves tool results intact when measurements are invalid or unavailable", async () => {
    for (const data of [
      {},
      { ...reading, memoryUsedBytes: -1 },
      { ...reading, cpuPercent: "busy" },
    ]) {
      expect(await measureComputerResources(provider(data), computer, context)).toBeUndefined();
    }
    const failing = {
      execute() {
        throw new Error("unavailable");
      },
    } as unknown as SandboxProvider;
    expect(await measureComputerResources(failing, computer, context)).toBeUndefined();
    const result = { ok: true };
    expect(withComputerResources(result, undefined)).toBe(result);
    expect(
      await measureComputerResources(failing, { ...computer, kind: "desktop" }, context),
    ).toBeUndefined();
  });
});
