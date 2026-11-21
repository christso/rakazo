import { setTimeout as sleep } from "node:timers/promises";
import type { AgentDesktopRun } from "../../src/computers/screens/agent-desktop-host-screen.js";
import { createAgentDesktopHostScreen } from "../../src/computers/screens/agent-desktop-host-screen.js";
import type { HostScreenAction } from "../../src/computers/screens/host-screen.js";

export const workbenchApp = "workbench";
const title = "Work Order Desk";
const windowId = "w-orders";
const scope = { botId: "eval", signal: new AbortController().signal };

type Control = { role: string; name: string; value?: string };
type Stage = "list" | "loading" | "form" | "saved";
export type Variant = "baseline" | "candidate";

export function makeWorkbench(badge?: string) {
  let stage: Stage = "list";
  let availableAt = 0;
  let summary = "";
  let assignee = "";
  let inspectionCode = "";
  let saved: { summary: string; assignee: string; inspectionCode?: string } | null = null;
  let toolCalls = 0;
  let screenshots = 0;
  let snapshot = 0;
  const refs = new Map<string, { stage: Stage; control: Control }>();

  function controls(): Control[] {
    if (stage === "loading" && Date.now() >= availableAt) stage = "form";
    const navigation = [
      { role: "button", name: "Dashboard" },
      { role: "button", name: "Work orders" },
      { role: "button", name: "Team directory" },
      { role: "button", name: "Settings" },
    ];
    switch (stage) {
      case "list":
      case "saved":
        return [
          ...navigation,
          { role: "button", name: "New work order" },
          ...(saved
            ? [{ role: "statictext", name: `Saved: ${saved.summary} (${saved.assignee})` }]
            : []),
          ...Array.from({ length: 12 }, (_, i) => ({
            role: "row",
            name: `Work order ${104 + i}. ${i % 2 ? "Awaiting review" : "Completed"}. Warehouse ${i + 1}.`,
          })),
        ];
      case "loading":
        return [...navigation, { role: "statictext", name: "Loading form" }];
      case "form":
        return [
          ...navigation,
          { role: "group", name: "New work order details" },
          { role: "textfield", name: "Summary", value: summary },
          { role: "textfield", name: "Assignee", value: assignee },
          ...(badge
            ? [
                { role: "image", name: "Inspection badge" },
                { role: "textfield", name: "Inspection code", value: inspectionCode },
              ]
            : []),
          { role: "button", name: "Save work order" },
          { role: "button", name: "Cancel" },
          { role: "statictext", name: "Summary and assignee are required." },
        ];
    }
  }

  function collect() {
    const rows = controls();
    const snapshot_id = `fixture${++snapshot}`;
    return {
      snapshot_id,
      rows: rows.map((control, i) => {
        const ref_id = `@${snapshot_id}:e${i + 1}`;
        refs.set(ref_id, { stage, control });
        return { ...control, ref_id };
      }),
    };
  }

  async function screenshot() {
    screenshots++;
    const escapeXml = (s: string) =>
      s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const rows = controls().map(
      (control, i) =>
        `<text x="52" y="${120 + i * 29}" font-size="17">${escapeXml(control.name + (control.value ? `: ${control.value}` : ""))}</text>`,
    );
    const renderedBadge =
      badge && stage === "form"
        ? `<rect x="590" y="100" width="360" height="150" rx="9" fill="#e6edf4"/>
         <text x="615" y="150" font-size="25">Inspection badge</text>
         <text x="615" y="207" font-size="48" font-weight="bold">${escapeXml(badge)}</text>`
        : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="640">
      <rect width="1024" height="640" fill="#e6edf4"/>
      <rect x="28" y="80" rx="9" width="968" height="530" fill="white"/>
      <g font-family="sans-serif" fill="#132739">
        <text x="50" y="52" font-size="29">${title}</text>${rows.join("")}${renderedBadge}
      </g>
    </svg>`;
    const { default: sharp } = await import("sharp");
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    return { data: png.toString("base64"), format: "png", width: 1024, height: 640 };
  }

  const run: AgentDesktopRun = async ([command, ...args]) => {
    const ok = (data: unknown) => ({ ok: true, data });
    if (command === "list-windows")
      return ok([{ id: windowId, app_name: workbenchApp, title, pid: 1 }]);
    if (command === "screenshot") return ok(await screenshot());
    if (command === "snapshot" || command === "find") {
      const { rows, snapshot_id } = collect();
      if (command === "snapshot")
        return ok({ snapshot_id, tree: { role: "window", name: title, children: rows } });
      const option = (key: string) => args.find((arg) => arg.startsWith(key))?.slice(key.length);
      const query = option("--text=")?.toLowerCase();
      const name = option("--name=");
      const role = option("--role=");
      const matches = rows.filter((control) =>
        query
          ? control.name.toLowerCase().includes(query)
          : control.name === name && control.role === role,
      );
      return ok({ snapshot_id, matches, total_matches: matches.length, truncated: false });
    }
    const [ref, value] = args.slice(args.indexOf("--") + 1);
    const found = ref ? refs.get(ref) : undefined;
    if (!found || found.stage !== stage)
      return { ok: false, error: { code: "STALE_REF", disposition: { retry: "safe" } } };
    const { name } = found.control;
    if (command === "click" && name === "New work order") {
      stage = "loading";
      availableAt = Date.now() + 400;
    } else if (command === "set-value" && stage === "form" && value !== undefined) {
      if (name === "Summary") summary = value;
      else if (name === "Assignee") assignee = value;
      else if (name === "Inspection code") inspectionCode = value;
      else return { ok: false, error: { code: "ACTION_FAILED" } };
    } else if (command === "click" && name === "Save work order" && summary && assignee) {
      if (badge && inspectionCode !== badge)
        return {
          ok: false,
          error: { code: "ACTION_FAILED", message: "Enter the code from the inspection badge." },
        };
      saved = { summary, assignee, ...(badge ? { inspectionCode } : {}) };
      stage = "saved";
    } else {
      return {
        ok: false,
        error: { code: "ACTION_FAILED", message: "That control cannot run this action." },
      };
    }
    return ok({});
  };

  return {
    run,
    recordToolCall() {
      toolCalls++;
    },
    async awaitForm() {
      await sleep(Math.max(0, availableAt - Date.now()));
    },
    outcome: () => ({ saved, toolCalls, screenshots }),
  };
}

export function makeFixture(variant: Variant) {
  const workbench = makeWorkbench();
  const screen = createAgentDesktopHostScreen({ selfPid: -1, run: workbench.run });
  const includeScreenshot = variant === "baseline";
  return {
    async observe(query?: string) {
      workbench.recordToolCall();
      return screen.observe(scope, workbenchApp, { query, includeScreenshot });
    },
    async act(actions: HostScreenAction[]) {
      workbench.recordToolCall();
      return screen.act(scope, workbenchApp, actions, { includeScreenshot });
    },
    awaitForm: workbench.awaitForm,
    outcome: workbench.outcome,
  };
}
