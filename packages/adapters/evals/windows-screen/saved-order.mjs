import { readFileSync } from "node:fs";
import { join } from "node:path";

export default function savedOrder(_output, { vars, providerResponse }) {
  try {
    const state = JSON.parse(
      readFileSync(
        join(providerResponse.metadata.workspace.path, "windows-screen-result.json"),
        "utf8",
      ),
    );
    const pass = state.saved?.summary === vars.summary && state.saved?.assignee === vars.assignee;
    return {
      pass,
      score: Number(pass),
      reason: pass
        ? "The app saved the expected work order."
        : "The saved work order did not match.",
      namedScores: { "tool calls": state.toolCalls, screenshots: state.screenshots },
    };
  } catch {
    return { pass: false, score: 0, reason: "No saved state was recorded by the app fixture." };
  }
}
