import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, globSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, parseAllDocuments } from "yaml";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const remediation = JSON.parse(
  readFileSync(new URL("./picomatch-patches.json", import.meta.url), "utf8"),
);
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

// Follow dependency links from every workspace, including pnpm's sibling links.
// Old, unreachable virtual-store directories are deliberately not trusted as proof.
export function installedWorkspacePackages(
  root = repositoryRoot,
  workspace = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8"),
) {
  const patterns = parse(workspace).packages;
  assert(Array.isArray(patterns) && patterns.length > 0, "No workspaces found");
  const moduleRoots = patterns.map((pattern) => {
    assert(
      typeof pattern === "string" && !pattern.startsWith("!"),
      "Review changed workspace package patterns",
    );
    return `${pattern}/node_modules`;
  });
  const visitedModules = new Set();
  const visitedPackages = new Set();
  const installed = [];
  function visitModules(directory) {
    if (!existsSync(directory)) return;
    const real = realpathSync(directory);
    if (visitedModules.has(real)) return;
    visitedModules.add(real);
    for (const entry of readdirSync(real)) {
      if (entry.startsWith(".")) continue;
      if (entry.startsWith("@")) {
        for (const scoped of readdirSync(path.join(real, entry))) {
          visitPackage(path.join(real, entry, scoped));
        }
      } else visitPackage(path.join(real, entry));
    }
  }
  function visitPackage(directory) {
    const real = realpathSync(directory);
    if (visitedPackages.has(real)) return;
    visitedPackages.add(real);
    const packageFile = path.join(real, "package.json");
    if (!existsSync(packageFile)) return;
    const metadata = JSON.parse(readFileSync(packageFile, "utf8"));
    const item = { name: metadata.name, version: metadata.version, directory: real };
    installed.push(item);
    if (metadata.name === "picomatch") {
      item.entrypoint = createRequire(packageFile).resolve(real);
      item.parser = path.join(real, "lib/parse.js");
    }
    if (path.basename(path.dirname(real)) === "node_modules") visitModules(path.dirname(real));
    // Scoped packages have one more directory between their siblings and package.
    if (path.basename(path.dirname(path.dirname(real))) === "node_modules") {
      visitModules(path.dirname(path.dirname(real)));
    }
    visitModules(path.join(real, "node_modules"));
  }
  visitModules(path.join(root, "node_modules"));
  visitModules(path.join(root, "node_modules/.pnpm/node_modules"));
  for (const directory of globSync(moduleRoots, { cwd: root })) {
    visitModules(path.join(root, directory));
  }
  return installed;
}

export function verifyPicomatchPatches(root = repositoryRoot) {
  const lockfile = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
  const workspace = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
  const documents = parseAllDocuments(lockfile);
  for (const document of documents)
    assert.equal(document.errors.length, 0, "Invalid dependency lockfile");
  const locks = documents.map((document) => document.toJSON());
  for (const lock of locks.slice(0, -1)) {
    assert(
      ![...Object.keys(lock.packages ?? {}), ...Object.keys(lock.snapshots ?? {})].some((key) =>
        key.startsWith("picomatch@"),
      ),
      "The package manager needs its own patch review",
    );
  }
  const lock = locks.at(-1);
  assert(lock.snapshots && lock.importers, "Workspace dependency lock is missing");
  const config = parse(workspace);
  const expected = Object.entries(remediation.packages).map(([version, patch]) => {
    assert.equal(digest(path.join(root, patch.patch)), patch.patchSha256, "Patch content changed");
    assert.equal(config.patchedDependencies?.[`picomatch@${version}`], patch.patch);
    assert.equal(lock.patchedDependencies?.[`picomatch@${version}`], patch.patchSha256);
    return `${version}(patch_hash=${patch.patchSha256})`;
  });
  const packages = Object.keys(lock.snapshots)
    .filter((key) => key.startsWith("picomatch@"))
    .map((key) => key.slice("picomatch@".length));
  assert.deepEqual(packages.sort(), expected.toSorted(), "Every locked picomatch must be patched");
  for (const snapshot of Object.values(lock.snapshots)) {
    for (const section of ["dependencies", "optionalDependencies"]) {
      if (snapshot[section]?.picomatch !== undefined) {
        assert(
          expected.includes(snapshot[section].picomatch),
          "An unpatched picomatch dependency is referenced",
        );
      }
    }
  }
  for (const importer of Object.values(lock.importers)) {
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      if (importer[section]?.picomatch !== undefined) {
        assert(
          expected.includes(importer[section].picomatch.version),
          "An unpatched picomatch importer is referenced",
        );
      }
    }
  }
  const installed = installedWorkspacePackages(root, workspace).filter(
    (item) => item.name === "picomatch",
  );
  assert.deepEqual(
    [...new Set(installed.map((item) => item.version))].sort(),
    Object.keys(remediation.packages).sort(),
  );
  for (const item of installed) {
    assert.equal(
      digest(item.parser),
      remediation.packages[item.version].parserSha256,
      "Installed picomatch parser does not contain the reviewed patch",
    );
  }
  return installed;
}
