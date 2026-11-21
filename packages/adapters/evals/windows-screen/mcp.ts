import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { HostScreenObservation } from "../../src/computers/screens/host-screen.js";
import { hostScreenAction } from "../../src/computers/screens/host-screen.js";
import { makeFixture } from "./fixture.js";

const variant = process.argv[2];
if (variant !== "baseline" && variant !== "candidate")
  throw new Error("Expected baseline or candidate");
const fixture = makeFixture(variant, resolve(process.cwd(), "windows-screen-result.json"));
const server = new McpServer({ name: "windows_screen", version: "1.0.0" });

function content(observation?: HostScreenObservation) {
  if (!observation) return [];
  return [
    { type: "text" as const, text: observation.tree },
    ...(observation.image
      ? [
          {
            type: "image" as const,
            data: observation.image.data,
            mimeType: observation.image.mimeType,
          },
        ]
      : []),
  ];
}

server.registerTool(
  "observe",
  {
    description:
      "Read the workbench app as numbered Windows accessibility rows. Query optionally filters the rows.",
    inputSchema: { query: z.string().max(200).optional() },
  },
  async ({ query }) => ({ content: content(await fixture.observe(query)) }),
);

const [click, ...otherActions] = hostScreenAction.options;
const action =
  variant === "baseline"
    ? z.discriminatedUnion("kind", [
        click,
        ...otherActions.filter(
          (option) => !["clickControl", "setControl"].includes(option.shape.kind.value),
        ),
      ])
    : hostScreenAction;

server.registerTool(
  "act",
  {
    description:
      variant === "baseline"
        ? "Run ordered actions in the workbench app and return the window. Use element numbers from the latest observation."
        : "Run ordered actions and return accessibility rows. Use clickControl or setControl with exact accessible name and role. Each waits up to 2000 ms for controls created by earlier steps. When names and roles are known, send one batch to open, fill and save a form, then use the returned rows to verify it. Use setControl with value for text fields.",
    inputSchema: { actions: z.array(action).min(1).max(24) },
  },
  async ({ actions }) => {
    const result = await fixture.act(actions);
    return {
      content: [
        {
          type: "text",
          text: `Completed ${result.completed} of ${actions.length} actions.${result.error ? ` ${result.error}` : ""}`,
        },
        ...content(result.observation),
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
