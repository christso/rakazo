import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  bundledRemediation,
  loadBundledPicomatch,
  verifyPicomatchBundles,
} from "./picomatch-bundles.mjs";
import { attacks, options, ordinaryMatches } from "./picomatch-fixtures.mjs";
import { repositoryRoot, verifyPicomatchPatches } from "./picomatch-patches.mjs";

if (process.argv[2] === "--probe") {
  const file = JSON.parse(process.argv[3]);
  const pm = loadBundledPicomatch(file);
  for (const mode of options) for (const [pattern, input] of attacks) pm(pattern, mode)(input);
  for (const [pattern, input] of ordinaryMatches) {
    assert(pm(pattern)(input), pattern);
    assert(pm.makeRe(pattern).test(input), pattern);
    const state = pm.parse(pattern);
    assert(Array.isArray(state.tokens));
    assert(pm.compileRe(state).test(input), pattern);
  }
  assert(!pm("**/!(*.test).ts")("src/file.test.ts"));
  assert(!pm("**/*.ts")("src/file.js"));
  assert(pm("**/*.ts", { windows: true })("src\\nested\\file.ts"));
} else {
  const bundles = verifyPicomatchBundles();
  const parsers = verifyPicomatchPatches();
  test("every reviewed embedded parser factory is present in the full workspace install", () => {
    assert.equal(bundles.length, bundledRemediation.packages.flatMap((item) => item.files).length);
  });
  for (const file of bundles) {
    test(`${file.owner}/${file.file} uses the patched parser through its bundled matcher`, () => {
      const run = spawnSync(
        process.execPath,
        [import.meta.filename, "--probe", JSON.stringify(file)],
        {
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 1024 * 1024,
        },
      );
      assert.ifError(run.error);
      assert.equal(run.status, 0, run.stderr);
    });
  }
  test("isolated vendor dependencies work without root hoisting and bundle drift fails closed", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "picomatch-bundles-"));
    try {
      for (const file of ["pnpm-workspace.yaml", "pnpm-lock.yaml", "patches"]) {
        cpSync(path.join(repositoryRoot, file), path.join(root, file), { recursive: true });
      }
      for (const policy of bundledRemediation.packages) {
        // Separate owner directories allow two locked versions of the same package.
        const owner = path.join(
          root,
          "node_modules",
          `vendor-${policy.name.replace("/", "__")}${policy.version}`,
        );
        mkdirSync(owner, { recursive: true });
        writeFileSync(
          path.join(owner, "package.json"),
          JSON.stringify({ name: policy.name, version: policy.version }),
        );
        const parser = parsers.find((item) => item.version === policy.files[0].picomatch);
        cpSync(
          path.dirname(path.dirname(parser.parser)),
          path.join(owner, "node_modules/picomatch"),
          { recursive: true },
        );
        for (const file of bundles.filter(
          (item) => item.owner === `${policy.name}@${policy.version}`,
        )) {
          const target = path.join(owner, file.file);
          mkdirSync(path.dirname(target), { recursive: true });
          cpSync(file.bundle, target);
        }
      }
      assert.equal(verifyPicomatchBundles(root).length, bundles.length);
      const first = verifyPicomatchBundles(root)[0];
      const lock = path.join(root, "pnpm-lock.yaml");
      const lockSource = readFileSync(lock, "utf8");
      const owner = bundledRemediation.packages.find((item) => item.name === "rolldown");
      writeFileSync(
        lock,
        lockSource.replace(
          `\n  ${owner.name}@${owner.version}(patch_hash=${owner.patchSha256}):`,
          `\n  ${owner.name}@${owner.version}:`,
        ),
      );
      assert.throws(() => verifyPicomatchBundles(root), /Unpatched bundled matcher snapshot/);
      writeFileSync(
        lock,
        lockSource.replace(
          `${owner.name}: ${owner.version}(patch_hash=${owner.patchSha256})`,
          `${owner.name}: ${owner.version}`,
        ),
      );
      assert.throws(
        () => verifyPicomatchBundles(root),
        /Unpatched bundled matcher dependency reference/,
      );
      writeFileSync(lock, lockSource);
      const snapshot = `\n  ${owner.name}@${owner.version}(patch_hash=${owner.patchSha256}):`;
      writeFileSync(lock, lockSource.replace(snapshot, `\n  "${owner.name}@${owner.version}":`));
      assert.throws(() => verifyPicomatchBundles(root), /Unpatched bundled matcher snapshot/);
      writeFileSync(
        lock,
        lockSource.replace(
          `${owner.name}: ${owner.version}(patch_hash=${owner.patchSha256})`,
          `${owner.name}: "${owner.version}"`,
        ),
      );
      assert.throws(
        () => verifyPicomatchBundles(root),
        /Unpatched bundled matcher dependency reference/,
      );
      writeFileSync(lock, lockSource);

      const firstPolicy = bundledRemediation.packages.find(
        (item) => `${item.name}@${item.version}` === first.owner,
      );
      const nestedParser = path.join(
        root,
        "node_modules",
        `vendor-${firstPolicy.name.replace("/", "__")}${firstPolicy.version}`,
        "node_modules/picomatch",
      );
      const rootParser = path.join(root, "node_modules/picomatch");
      cpSync(nestedParser, rootParser, { recursive: true });
      rmSync(nestedParser, { recursive: true });
      const hoisted = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { verifyPicomatchBundles } from ${JSON.stringify(new URL("./picomatch-bundles.mjs", import.meta.url).href)}; verifyPicomatchBundles(process.argv[1]);`,
          root,
        ],
        { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 },
      );
      assert.ifError(hoisted.error);
      assert.equal(hoisted.status, 1);
      assert.match(hoisted.stderr, /own explicit parser dependency/);
      cpSync(rootParser, nestedParser, { recursive: true });
      rmSync(rootParser, { recursive: true });
      assert(loadBundledPicomatch(first)("**/*.ts")("src/file.ts"));
      const source = readFileSync(first.bundle, "utf8");
      writeFileSync(first.bundle, `${source}\n// changed bundle\n`);
      assert.throws(() => verifyPicomatchBundles(root), /Installed bundled matcher changed/);
      writeFileSync(first.bundle, source);
      writeFileSync(
        path.join(path.dirname(first.bundle), "unexpected.js"),
        'const signature = "POSIX_REGEX_SOURCE";',
      );
      assert.throws(() => verifyPicomatchBundles(root), /Unreviewed bundled matcher/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
