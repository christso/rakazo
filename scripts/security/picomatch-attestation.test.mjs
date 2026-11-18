import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { repositoryRoot, verifyPicomatchPatches } from "./picomatch-patches.mjs";

const installed = verifyPicomatchPatches();

test("attestation rejects a separate unpatched runtime copy, changed patches and lock references", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "picomatch-attestation-"));
  try {
    for (const name of ["pnpm-lock.yaml", "pnpm-workspace.yaml", "patches"]) {
      cpSync(path.join(repositoryRoot, name), path.join(root, name), { recursive: true });
    }
    for (const item of installed) {
      const destination = path.join(root, "node_modules", `picomatch-${item.version}`);
      cpSync(path.dirname(path.dirname(item.parser)), destination, { recursive: true });
    }
    assert.equal(verifyPicomatchPatches(root).length, installed.length);

    // A second live copy must be checked even when representative consumers are patched.
    const runtime = path.join(root, "packages/runtime/node_modules/picomatch");
    mkdirSync(path.dirname(runtime), { recursive: true });
    cpSync(path.dirname(path.dirname(installed[0].parser)), runtime, { recursive: true });
    const parser = path.join(runtime, "lib/parse.js");
    writeFileSync(parser, `${readFileSync(parser, "utf8")}\n// changed installed code\n`);
    assert.throws(() => verifyPicomatchPatches(root), /Installed picomatch parser/);
    rmSync(path.join(root, "packages"), { recursive: true });

    // pnpm's hoisted fallback directory is also visible to runtime consumers.
    const hoisted = path.join(root, "node_modules/.pnpm/node_modules/picomatch");
    cpSync(path.dirname(path.dirname(installed[0].parser)), hoisted, { recursive: true });
    const hoistedParser = path.join(hoisted, "lib/parse.js");
    writeFileSync(
      hoistedParser,
      `${readFileSync(hoistedParser, "utf8")}\n// unverified hoisted code\n`,
    );
    assert.throws(() => verifyPicomatchPatches(root), /Installed picomatch parser/);
    rmSync(path.join(root, "node_modules/.pnpm"), { recursive: true });

    const patch = path.join(root, "patches/picomatch@2.3.2.patch");
    const patchText = readFileSync(patch, "utf8");
    writeFileSync(patch, `${patchText}\n`);
    assert.throws(() => verifyPicomatchPatches(root), /Patch content changed/);
    writeFileSync(patch, patchText);

    const lock = path.join(root, "pnpm-lock.yaml");
    writeFileSync(
      lock,
      readFileSync(lock, "utf8").replace(/(picomatch: 2\.3\.2)\(patch_hash=[a-f0-9]+\)/, "$1"),
    );
    assert.throws(() => verifyPicomatchPatches(root), /unpatched picomatch dependency/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
