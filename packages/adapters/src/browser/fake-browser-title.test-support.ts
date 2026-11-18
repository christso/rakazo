import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { FakeBrowserProvider } from "./fake-browser.js";

const context = { signal: new AbortController().signal } as AdapterContext;
const computer = { id: "fixture-computer", kind: "fake" } as ComputerRef;

process.once("message", async (prefix) => {
  if (
    typeof prefix !== "string" ||
    prefix.length > 7 ||
    !["<title>", "<title ", "<head "].includes(prefix)
  )
    throw new Error("Expected a fixture prefix");
  const url = "https://fixture.example.test/";
  const browser = new FakeBrowserProvider({
    pages: { [url]: { html: prefix.repeat(40_000), title: "Fixture title" } },
  });
  try {
    process.send?.(await browser.navigate(computer, { url }, context));
  } finally {
    browser.sessions.clear();
  }
});
process.send?.("ready");
