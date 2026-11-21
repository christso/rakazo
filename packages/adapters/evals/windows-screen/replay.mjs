import { createRequire } from "node:module";
import { resolve } from "node:path";
import { tsImport } from "tsx/esm/api";

const { makeFixture } = await tsImport("./fixture.ts", import.meta.url);
const { getEncoding } = createRequire(resolve("package.json"))("js-tiktoken");
const encoding = getEncoding("o200k_base");

function number(tree, name) {
  const row = tree.split("\n").find((line) => line.includes(` "${name}"`));
  const id = row?.match(/\[(\d+)\]/)?.[1];
  if (!id) throw new Error(`No numbered control for ${name}`);
  return Number(id);
}

export default class Replay {
  constructor({ config }) {
    this.variant = config.variant;
  }

  id() {
    return this.variant;
  }

  async callApi(_prompt, { vars: { summary, assignee } }) {
    const fixture = makeFixture(this.variant);
    let textTokens = 0;

    function read(verb, observation) {
      textTokens += encoding.encode(`${verb}\n${observation.tree}`).length;
      return observation.tree;
    }

    async function act(actions) {
      const result = await fixture.act(actions);
      if (result.error) throw new Error(result.error);
      return read(
        `Completed ${result.completed} of ${actions.length} actions.`,
        result.observation,
      );
    }

    const home = read("Observed", await fixture.observe());
    const open = { kind: "click", element: number(home, "New work order") };
    if (this.variant === "baseline") {
      let form = await act([open]);
      if (form.includes("Loading form")) {
        await fixture.awaitForm();
        form = read("Observed", await fixture.observe());
      }
      await act([
        { kind: "set", element: number(form, "Summary"), value: summary },
        { kind: "set", element: number(form, "Assignee"), value: assignee },
        { kind: "click", element: number(form, "Save work order") },
      ]);
    } else {
      await act([
        open,
        { kind: "setControl", role: "textfield", name: "Summary", value: summary },
        { kind: "setControl", role: "textfield", name: "Assignee", value: assignee },
        { kind: "clickControl", role: "button", name: "Save work order" },
      ]);
    }
    return { output: { ...fixture.outcome(), textTokens } };
  }
}
