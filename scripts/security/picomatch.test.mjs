import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { verifyPicomatchPatches } from "./picomatch-patches.mjs";

const packages = verifyPicomatchPatches();
const attacks = [
  ["+(a?|a??)", `${"a".repeat(200)}/`],
  ["+(a[ab]|a[ab][ab])", `${"a".repeat(200)}!`],
  ["+(@(a|aa))", `${"a".repeat(200)}!`],
  ['+(a|"a")', `${"a".repeat(200)}!`],
  ["+(🐱|🐱🐱)", `${"🐱".repeat(200)}!`],
  ["+(Σ|ς)", `${"Σ".repeat(200)}!`],
  ["+(a|ab|ba)", `${"ab".repeat(200)}!`],
  ["+(A|aa)", `${"a".repeat(200)}!`],
  ["+([a-z]+)", `${"a".repeat(200)}!`],
  ["+([a]+)", `${"a".repeat(200)}!`],
  ["([[:alpha:]]+)+", `${"a".repeat(200)}!`],
  ["+(*a)", `${"a".repeat(200)}!`],
  ["*(*a)", `${"a".repeat(200)}!`],
  ["+(*)", `${"a".repeat(200)}/`],
  ["*(*)", `${"a".repeat(200)}/`],
  ["+(a*)", `${"a".repeat(200)}/`],
  ["+(*?a)", `${"a".repeat(200)}!`],
  ["+(a*|b)", `${"a".repeat(200)}/`],
  ["+(ab|abab)", `${"ab".repeat(200)}!`],
  ["+(ab|abab|c)", `${"ab".repeat(200)}!`],
  ["+(!(a))", `${"a".repeat(200)}/`],
  ["@(*a)+", `${"a".repeat(200)}!`],
  ["(*a)+", `${"a".repeat(200)}!`],
  ["{*a,b}+", `${"a".repeat(200)}!`],
  ['(*|+((""))', `${"a".repeat(200)}/`],
];
const options = [
  {},
  { nocase: true },
  { flags: "i" },
  { flags: "iu" },
  { bash: true },
  { windows: true },
  { capture: true },
  { fastpaths: false },
];

for (const { version, entrypoint } of packages) {
  test(`picomatch ${version} terminates on repeated-wildcard attacks`, () => {
    // A vulnerable matcher can never block the test process or the CI worker.
    const run = spawnSync(
      process.execPath,
      [
        "-e",
        "const pm = require(process.argv[1]);" +
          "for (const options of JSON.parse(process.argv[3]))" +
          "for (const [pattern,input] of JSON.parse(process.argv[2])) pm(pattern,options)(input);" +
          "const wide='+('+Array.from({length:6000},(_,i)=>'x'+i.toString(36).padStart(4,'0')+'z').join('|')+')';" +
          "pm(wide)('x0001zx0002z!');" +
          "pm('+('+ 'a'.repeat(20000) + '*)')('a'.repeat(30000)+'!');" +
          "pm('+(*a)')('a'.repeat(30000)+'!');",
        entrypoint,
        JSON.stringify(attacks),
        JSON.stringify(options),
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
  });

  test(`picomatch ${version} preserves ordinary and safe extglob matches`, async () => {
    const { default: picomatch } = await import(entrypoint);
    const matches = [
      ["**/*.ts", "src/nested/file.ts"],
      ["**/!(*.test).ts", "src/file.ts"],
      ["{src,test}/**/*.{ts,tsx}", "src/nested/file.tsx"],
      ["+(foo|bar)", "foobarfoo"],
      ["foo/*.+(js|jsx)", "foo/baz.jsx"],
      ["*(fo|foo)", "fofoofoofofoo"],
      ["+(a|abc)", "abc"],
      ["?(foo|bar)", "foo"],
      ["@(foo|bar)", "bar"],
      ["+(\\*a)", "*a*a"],
      ["+([*a])", "a*a"],
      ['+("*a")', "*a*a"],
      ["+(f*(o))", "fofoo"],
      ["+(*.js)", "first.jssecond.js"],
      ["*(a*b)", "axbayb"],
      ["+(*)c", "abc"],
      ["*(*a)b", "b"],
    ];
    for (const [pattern, input] of matches) assert(picomatch(pattern)(input), pattern);
    assert(!picomatch("**/!(*.test).ts")("src/file.test.ts"));
    assert(!picomatch("**/*.ts")("src/file.js"));
    assert(picomatch("**/*.ts", { windows: true })("src\\nested\\file.ts"));
  });

  test(`picomatch ${version} keeps short-string matching under wildcard rewrites`, async () => {
    const { default: picomatch } = await import(entrypoint);
    const bodies = ["*", "*a", "a*", "a*b", "?*a", "a*?", "*.js"];
    const contexts = [
      ["+(", ")"],
      ["*(", ")"],
      ["prefix/+(", ").js"],
      ["x*(", ")y"],
    ];
    let inputs = [""];
    let level = [""];
    for (let length = 0; length < 4; length++) {
      level = level.flatMap((prefix) => ["a", "b", ".", "/", "x"].map((ch) => prefix + ch));
      inputs = inputs.concat(level);
    }
    const modes = [
      {},
      { dot: true },
      { nocase: true },
      { windows: true },
      { capture: true },
      { bash: true },
    ];
    for (const mode of modes) {
      for (const body of bodies) {
        // In bash mode '?' can match a newline while '*' cannot; that complex
        // repeated combination deliberately falls back to a literal pattern.
        if (mode.bash && body.includes("?")) continue;
        for (const [prefix, suffix] of contexts) {
          const pattern = prefix + body + suffix;
          const protectedMatch = picomatch(pattern, mode);
          const originalMatch = picomatch(pattern, { ...mode, maxExtglobRecursion: false });
          for (const input of inputs.concat(["a.jsb.js", "a\na", "a\ra"])) {
            assert.equal(protectedMatch(input), originalMatch(input), `${pattern}: ${input}`);
          }
        }
      }
    }
  });
}
