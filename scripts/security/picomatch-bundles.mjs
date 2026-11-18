import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, globSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { parse, parseAllDocuments } from "yaml";
import { installedWorkspacePackages, remediation, repositoryRoot } from "./picomatch-patches.mjs";

export const bundledRemediation = JSON.parse(
  readFileSync(new URL("./picomatch-bundles.json", import.meta.url), "utf8"),
);
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

// These implementation signatures also identify renamed/minified factories.
// A normal import of the separately patched dependency is not an embedded copy.
function hasMatcherImplementation(source) {
  return (
    source.includes("POSIX_REGEX_SOURCE") ||
    source.includes("REGEX_SPECIAL_CHARS_BACKREF") ||
    (source.includes("Input length:") && source.includes("exceeds maximum allowed length")) ||
    source.includes("Expected pattern to be a non-empty string")
  );
}

export function verifyPicomatchBundles(root = repositoryRoot) {
  const workspaceText = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
  const workspace = parse(workspaceText);
  const documents = parseAllDocuments(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
  for (const document of documents)
    assert.equal(document.errors.length, 0, "Invalid dependency lockfile");
  const lock = documents.at(-1).toJSON();
  assert(lock.snapshots && lock.importers, "Workspace dependency lock is missing");
  const known = new Map(
    bundledRemediation.packages.map((item) => [`${item.name}@${item.version}`, item]),
  );
  for (const item of known.values()) {
    const owner = `${item.name}@${item.version}`;
    assert.equal(
      digest(path.join(root, item.patch)),
      item.patchSha256,
      "Bundled matcher patch changed",
    );
    assert.equal(workspace.patchedDependencies?.[owner], item.patch);
    assert.equal(
      workspace.packageExtensions?.[owner]?.dependencies?.picomatch,
      item.files[0].picomatch,
    );
    assert.equal(
      lock.patchedDependencies?.[owner],
      item.patchSha256,
      "Bundled matcher lock hash changed",
    );
    const keys = Object.keys(lock.snapshots).filter(
      (key) => key === owner || key.startsWith(`${owner}(`),
    );
    assert(keys.length > 0, "Bundled matcher snapshot missing");
    for (const key of keys) {
      assert(
        key.startsWith(`${owner}(patch_hash=${item.patchSha256})`),
        "Unpatched bundled matcher snapshot",
      );
    }
    const checkReference = (reference) => {
      assert.equal(typeof reference, "string", "Invalid dependency reference");
      if (reference === item.version || reference.startsWith(`${item.version}(`)) {
        assert(
          reference.startsWith(`${item.version}(patch_hash=${item.patchSha256})`),
          "Unpatched bundled matcher dependency reference",
        );
      }
    };
    for (const snapshot of Object.values(lock.snapshots)) {
      for (const section of ["dependencies", "optionalDependencies"]) {
        if (snapshot[section]?.[item.name] !== undefined)
          checkReference(snapshot[section][item.name]);
      }
    }
    for (const importer of Object.values(lock.importers)) {
      for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
        if (importer[section]?.[item.name] !== undefined)
          checkReference(importer[section][item.name].version);
      }
    }
  }
  const result = [];
  const unreviewed = [];
  for (const installed of installedWorkspacePackages(root, workspaceText)) {
    if (installed.name === "picomatch") continue;
    const owner = `${installed.name}@${installed.version}`;
    const policy = known.get(owner);
    const expected = new Map((policy?.files ?? []).map((file) => [file.file, file]));
    const seen = new Set();
    for (const relative of globSync("**/*.{js,mjs,cjs}", {
      cwd: installed.directory,
      exclude: ["node_modules/**"],
    })) {
      const bundle = path.join(installed.directory, relative);
      const source = readFileSync(bundle, "utf8");
      if (!hasMatcherImplementation(source) && !expected.has(relative)) continue;
      const file = expected.get(relative);
      if (!file) {
        unreviewed.push(`${owner}/${relative}`);
        continue;
      }
      assert.equal(
        digest(bundle),
        file.sha256,
        `Installed bundled matcher changed: ${owner}/${relative}`,
      );
      const redirects = [...source.matchAll(/\("picomatch\/lib\/parse\.js"\)/g)];
      assert.equal(redirects.length, 1, "Review every embedded parser factory");
      const body = source.slice(file.parserFactory.start, file.parserFactory.end);
      assert(body.includes('("picomatch/lib/parse.js")'), "The parser factory does not redirect");
      assert(!hasMatcherImplementation(body), "An embedded parser implementation remains");
      const request = createRequire(bundle);
      const packageFile = request.resolve("picomatch/package.json");
      const dependency = JSON.parse(readFileSync(packageFile, "utf8"));
      assert.equal(dependency.version, file.picomatch, "Bundled matcher major/version changed");
      const parser = request.resolve("picomatch/lib/parse.js");
      assert.equal(digest(parser), remediation.packages[file.picomatch].parserSha256);
      // pnpm keeps explicit dependencies beside the package in its virtual
      // node_modules. A nested install is valid too; root hoisting is not proof.
      let localDependency = path.join(installed.directory, "node_modules/picomatch/package.json");
      if (!existsSync(localDependency)) {
        const parent = path.dirname(installed.directory);
        const modules = path.basename(parent).startsWith("@") ? path.dirname(parent) : parent;
        assert.equal(path.basename(modules), "node_modules");
        assert.equal(
          path.basename(path.dirname(path.dirname(modules))),
          ".pnpm",
          "Bundled matcher needs its own explicit parser dependency",
        );
        localDependency = path.join(modules, "picomatch/package.json");
      }
      assert.equal(realpathSync(localDependency), realpathSync(packageFile));
      seen.add(relative);
      result.push({ owner, bundle, ...file });
    }
    assert.deepEqual(
      [...seen].sort(),
      [...expected.keys()].sort(),
      "A reviewed vendor bundle is missing",
    );
  }
  assert.equal(
    unreviewed.length,
    0,
    `Unreviewed bundled matcher implementations: ${unreviewed.join(", ")}`,
  );
  return result;
}

// Load only the reviewed matcher factories, never a vendor CLI's top-level code.
// Whole-bundle hashes bind the ranges and helper names to the reviewed release.
export function loadBundledPicomatch(file) {
  const source = readFileSync(file.bundle, "utf8");
  const commonJS = (factory) => {
    let module;
    return () => {
      if (!module) {
        module = { exports: {} };
        (typeof factory === "function" ? factory : Object.values(factory)[0])(
          module.exports,
          module,
        );
      }
      return module.exports;
    };
  };
  const request = createRequire(file.bundle);
  const context = {
    process,
    require: request,
    __require: request,
    patchedPicomatchRequire: request,
    __commonJS: commonJS,
    __commonJSMin: commonJS,
    import_chunk_2ESYSVXG: { __commonJS: commonJS, __require: request },
    i: (fn) => fn,
    f: () => {},
    ge: request("node:path"),
    Te: request,
    module: { exports: {} },
  };
  for (const name of file.globals ?? []) context[name] = undefined;
  for (const name of file.objects ?? []) context[name] = {};
  for (const name of file.helpers) context[name] = commonJS;
  if (file.webpack) {
    const definitions = file.modules
      .map((item) => `${JSON.stringify(item.name)}: ${source.slice(item.start, item.end)}`)
      .join(",");
    const factories = vm.runInNewContext(`({${definitions}})`, context, { timeout: 2_000 });
    const cache = new Map();
    const load = (id) => {
      const key = String(id);
      if (!cache.has(key)) {
        assert(factories[key], "Unexpected bundled matcher dependency");
        const module = { exports: {} };
        cache.set(key, module);
        factories[key](module, module.exports, load);
      }
      return cache.get(key).exports;
    };
    return load(file.entry);
  }
  const definitions = file.modules
    .map(
      (item) =>
        `${item.declarator ? "var " : ""}${source.slice(item.start, item.end)}${item.declarator ? ";" : ""}`,
    )
    .join("\n");
  vm.runInNewContext(`${definitions}\nmodule.exports = ${file.entry}();`, context, {
    timeout: 2_000,
  });
  return context.module.exports;
}
