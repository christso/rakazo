import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { expectLinearTime } from "@rakazo/contracts/test-timing";
import { deadlineSignal } from "@rakazo/core";
import { expect, it } from "vitest";
import { FakeBrowserProvider } from "./fake-browser.js";

const context = { signal: new AbortController().signal } as AdapterContext;
const computer = { id: "fixture-computer", kind: "fake" } as ComputerRef;
const url = "https://fixture.example.test/";

it.each([
  "<button>Keep body</button>",
  "<html><head><title>Old title</title></head><body><button>Keep body</button></body></html>",
  '<HEAD data-theme="dark"><TITLE>Old title</TITLE></HEAD><button>Keep body</button>',
])("sets a seeded title through the parsed document and preserves its body", async (html) => {
  const title = 'Fixture <title> & "quoted"';
  const browser = new FakeBrowserProvider({ pages: { [url]: { html, title } } });
  try {
    expect(await browser.navigate(computer, { url }, context)).toMatchObject({ title });
    expect(await browser.snapshot(computer, {}, context)).toMatchObject({
      tree: expect.stringContaining('button "Keep body"'),
    });
  } finally {
    browser.sessions.clear();
  }
});

it("keeps the document title when no seeded title was supplied", async () => {
  const browser = new FakeBrowserProvider({
    pages: { [url]: { html: "<title>Document title</title>", title: "" } },
  });
  try {
    expect(await browser.navigate(computer, { url }, context)).toMatchObject({
      title: "Document title",
    });
  } finally {
    browser.sessions.clear();
  }
});

it.each(["<title>", "<title ", "<head "])(
  "handles repeated malformed %s openings without regex backtracking",
  async (prefix) => {
    // A regressed regex cannot hang the test worker when it runs in a separate process.
    const child = fork(
      fileURLToPath(new URL("./fake-browser-title.test-support.ts", import.meta.url)),
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        timeout: 15_000,
      },
    );
    const signal = deadlineSignal(20_000);
    try {
      expect((await once(child, "message", { signal }))[0]).toBe("ready");
      await expectLinearTime(async () => {
        const answer = once(child, "message", { signal });
        child.send(prefix);
        const [result] = await answer;
        expect(result).toEqual({ url, title: "Fixture title" });
      });
    } finally {
      child.kill();
    }
  },
);
