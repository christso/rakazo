import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, globSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const remediation = JSON.parse(
  readFileSync(new URL("./picomatch-patches.json", import.meta.url), "utf8"),
);
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

// Follow dependency links from every workspace, including pnpm's sibling links.
// Old, unreachable virtual-store directories are deliberately not trusted as proof.
function installedPackages(root, workspace) {
  const patterns = workspace
    .split(/\n(?=\S)/, 1)[0]
    .split("\n")
    .slice(1)
    .filter((line) => /^ {2}- /.test(line));
  const moduleRoots = patterns.map((line) => {
    assert(/^ {2}- "[^"\n]+"$/.test(line), "Review changed workspace package syntax");
    return `${JSON.parse(line.slice(4))}/node_modules`;
  });
  assert(moduleRoots.length > 0, "No workspaces found");
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
    if (metadata.name === "picomatch") {
      installed.push({
        version: metadata.version,
        entrypoint: createRequire(packageFile).resolve(real),
        parser: path.join(real, "lib/parse.js"),
      });
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
  const documents = lockfile.split(/^---[ \t]*\r?$/m);
  for (const document of documents.slice(0, -1)) {
    assert(!/^ {2}picomatch@/m.test(document), "The package manager needs its own patch review");
  }
  const expected = Object.entries(remediation.packages).map(([version, patch]) => {
    assert.equal(digest(path.join(root, patch.patch)), patch.patchSha256, "Patch content changed");
    assert(workspace.includes(`picomatch@${version}: ${patch.patch}`));
    assert(lockfile.includes(`  picomatch@${version}: ${patch.patchSha256}\n`));
    return `${version}(patch_hash=${patch.patchSha256})`;
  });
  const snapshots = lockfile.slice(lockfile.lastIndexOf("\nsnapshots:\n"));
  const packages = [...snapshots.matchAll(/^ {2}picomatch@([^:]+):/gm)].map((match) => match[1]);
  assert.deepEqual(packages.sort(), expected.toSorted(), "Every locked picomatch must be patched");
  for (const [, reference] of snapshots.matchAll(/^\s+picomatch: ([^\n]+)$/gm)) {
    assert(expected.includes(reference), "An unpatched picomatch dependency is referenced");
  }
  const installed = installedPackages(root, workspace);
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
