import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { z } from "zod";
import { usesNativeShell } from "./native-shell.js";

const MEASURE_TIMEOUT_MS = 2_000;
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const resourceReading = z.object({
  sampledAt: z.iso.datetime(),
  sampleMs: z.number().positive().max(MEASURE_TIMEOUT_MS),
  scope: z.enum(["cgroup-v2", "cgroup-v1"]),
  memoryUsedBytes: bytes,
  memoryLimitBytes: bytes.positive().nullable(),
  cpuPercent: z.number().nonnegative().nullable(),
  cpuLimitCores: z.number().positive().nullable(),
});

export type ComputerResources = z.infer<typeof resourceReading> & {
  memoryPercent: number | null;
  memoryPressure: boolean;
  guidance?: string;
};

// Read the sandbox's cgroup, never /proc/meminfo (which may describe the host).
// Python is part of the Linux computer image; no package or privileged host access is needed.
const RESOURCE_PROBE = `
import datetime, json, os, pathlib, time

def read(path):
    return pathlib.Path(path).read_text().strip()

def finite(raw):
    return int(raw) if raw != "max" and 0 < int(raw) < 2**60 else None

def stats(path):
    return dict(line.split() for line in read(path).splitlines())

def ancestors(group, mount):
    while group.is_relative_to(mount):
        yield group
        if group == mount:
            break
        group = group.parent

root = pathlib.Path("/sys/fs/cgroup")
groups = [line.split(":", 2) for line in read("/proc/self/cgroup").splitlines()]
v2 = next((path for _, controllers, path in groups if controllers == ""), None)
if v2 is not None:
    candidate = (root / v2.lstrip("/")).resolve()
    group = candidate if candidate.is_relative_to(root) and (candidate / "memory.current").exists() else root
    used = int(read(group / "memory.current"))
    inactive = int(stats(group / "memory.stat").get("inactive_file", 0))
    memory_limit, cpu_limit = None, None
    for parent in ancestors(group, root):
        limit = finite(read(parent / "memory.max"))
        if limit is not None:
            memory_limit = min(memory_limit or limit, limit)
        quota, period = read(parent / "cpu.max").split()
        if quota != "max":
            cores = int(quota) / int(period)
            cpu_limit = min(cpu_limit or cores, cores)
    def cpu_usage():
        return int(stats(group / "cpu.stat")["usage_usec"]) / 1e6
    scope = "cgroup-v2"
else:
    def controller(name, filename):
        path = next(path for _, controllers, path in groups if name in controllers.split(","))
        mounts = [root / name, root / "cpu,cpuacct", root / "cpuacct,cpu"]
        for mount in mounts:
            mount = mount.resolve()
            for candidate in [(mount / path.lstrip("/")).resolve(), mount]:
                if candidate.is_relative_to(mount) and (candidate / filename).exists():
                    return candidate, mount
        raise RuntimeError("cgroup controller unavailable")
    memory, memory_root = controller("memory", "memory.usage_in_bytes")
    cpu, cpu_root = controller("cpu", "cpu.cfs_quota_us")
    accounting, _ = controller("cpuacct", "cpuacct.usage")
    used = int(read(memory / "memory.usage_in_bytes"))
    inactive = int(stats(memory / "memory.stat").get("total_inactive_file", 0))
    memory_limit, cpu_limit = None, None
    for parent in ancestors(memory, memory_root):
        limit = finite(read(parent / "memory.limit_in_bytes"))
        if limit is not None:
            memory_limit = min(memory_limit or limit, limit)
    for parent in ancestors(cpu, cpu_root):
        quota = int(read(parent / "cpu.cfs_quota_us"))
        if quota > 0:
            cores = quota / int(read(parent / "cpu.cfs_period_us"))
            cpu_limit = min(cpu_limit or cores, cores)
    def cpu_usage():
        return int(read(accounting / "cpuacct.usage")) / 1e9
    scope = "cgroup-v1"

affinity = len(os.sched_getaffinity(0))
cpu_limit = min(cpu_limit or affinity, affinity)
start, usage = time.monotonic(), cpu_usage()
time.sleep(0.2)
elapsed, consumed = time.monotonic() - start, cpu_usage() - usage
print(json.dumps({
    "sampledAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "sampleMs": round(elapsed * 1000, 2), "scope": scope,
    "memoryUsedBytes": max(0, used - inactive), "memoryLimitBytes": memory_limit,
    "cpuPercent": round(max(0, consumed) / elapsed / cpu_limit * 100, 1),
    "cpuLimitCores": cpu_limit,
}))
`;

export async function measureComputerResources(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
): Promise<ComputerResources | undefined> {
  if (usesNativeShell(computer.kind) || computer.kind === "none" || computer.kind === "fake") {
    return undefined;
  }
  try {
    let stdout = "";
    let exitCode: number | undefined;
    for await (const event of sandbox.execute(
      computer,
      { argv: ["python3", "-I", "-c", RESOURCE_PROBE], cwd: ".", timeoutMs: MEASURE_TIMEOUT_MS },
      {
        ...context,
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(MEASURE_TIMEOUT_MS)]),
      },
    )) {
      if (event.type === "stdout") {
        stdout += event.data;
        if (stdout.length > 4_096) return undefined;
      }
      if (event.type === "exit") exitCode = event.code;
    }
    if (exitCode !== 0) return undefined;
    const parsed = resourceReading.safeParse(JSON.parse(stdout));
    if (!parsed.success) return undefined;
    const reading = parsed.data;
    const memoryPercent =
      reading.memoryLimitBytes === null
        ? null
        : Math.ceil((reading.memoryUsedBytes / reading.memoryLimitBytes) * 100);
    const memoryPressure = memoryPercent !== null && memoryPercent >= 85;
    return {
      ...reading,
      memoryPercent,
      memoryPressure,
      ...(memoryPressure
        ? {
            guidance:
              "Memory is nearly full. Close temporary tabs and stop background processes you created and no longer need, then check computer_resources again. Preserve other people's tabs and work. If usage stays high, tell the user before starting more work.",
          }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export function withComputerResources(
  result: unknown,
  resources: ComputerResources | undefined,
): unknown {
  if (!resources || !result || typeof result !== "object" || Array.isArray(result)) return result;
  const value = result as Record<string, unknown>;
  if (value.kind === "agent_tool_result" && Array.isArray(value.content)) {
    return {
      ...value,
      content: [
        ...value.content,
        { type: "text", text: JSON.stringify({ computerResources: resources }) },
      ],
      details: {
        ...(value.details as Record<string, unknown> | undefined),
        computerResources: resources,
      },
    };
  }
  return { ...value, computerResources: resources };
}
