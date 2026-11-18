import type { RpcPath, SpaceChangeKind } from "@rakazo/contracts";
import { queryClient } from "./query";

type ReadChangeKind = Exclude<SpaceChangeKind, "computerUpdates">;
/** A procedure as its query key ends, typed so a renamed procedure fails to compile here. */
type ProcedureSegments<Path extends string> = Path extends `${infer Head}/${infer Rest}`
  ? readonly [Head, ...ProcedureSegments<Rest>]
  : readonly [Path];
type Procedure = ProcedureSegments<RpcPath>;

const READS: Record<ReadChangeKind, readonly Procedure[]> = {
  runs: [
    ["runs", "list"],
    ["routines", "history"],
    ["usage", "breakdown"],
  ],
  routines: [["routines", "list"]],
  computerProvider: [["computerProvider", "space", "get"]],
};

export const isReadChangeKind = (kind: string): kind is ReadChangeKind =>
  Object.hasOwn(READS, kind);

/** Reads again what the server says may have changed; only screens showing it refetch. */
export function spaceChanged(kind: ReadChangeKind, client = queryClient): Promise<void> {
  const procedures = READS[kind];
  return client.invalidateQueries({
    predicate: ({ queryKey: [path] }) =>
      Array.isArray(path) &&
      procedures.some(
        (procedure) => path.slice(-procedure.length).join("/") === procedure.join("/"),
      ),
  });
}
