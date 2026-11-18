import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkAuditSecurity } from "../checks/dependency-audit.mjs";
import { verifyPicomatchBundles } from "./picomatch-bundles.mjs";
import { remediation, repositoryRoot, verifyPicomatchPatches } from "./picomatch-patches.mjs";

const outputDirectory = path.join(repositoryRoot, ".tmp/security");
mkdirSync(outputDirectory, { recursive: true });
const reportFile = path.join(outputDirectory, "dependency-audit.json");
const proofFile = path.join(outputDirectory, "dependency-remediation.json");
rmSync(proofFile, { force: true });
const audit = spawnSync("pnpm", ["audit", "--audit-level", "high", "--json"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
});
// Preserve the original audit, including the locally remediated version-based
// finding. A malformed report or network failure must never become a clean run.
writeFileSync(reportFile, audit.stdout ?? "");
assert.ifError(audit.error);
assert([0, 1].includes(audit.status), "Dependency audit did not complete");
const report = JSON.parse(audit.stdout);
const installed = verifyPicomatchPatches();
const bundles = verifyPicomatchBundles();
const regressions = spawnSync(
  process.execPath,
  [
    "--test",
    "scripts/security/picomatch.test.mjs",
    "scripts/security/picomatch-attestation.test.mjs",
    "scripts/security/picomatch-bundles.test.mjs",
  ],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  },
);
process.stdout.write(regressions.stdout ?? "");
process.stderr.write(regressions.stderr ?? "");
assert.ifError(regressions.error);
assert.equal(regressions.status, 0, "The installed dependency security regressions failed");
const remediated = checkAuditSecurity(
  readFileSync(path.join(repositoryRoot, "pnpm-lock.yaml"), "utf8"),
  report,
  installed.map((item) => item.version),
);
writeFileSync(
  proofFile,
  `${JSON.stringify({ remediated, patches: remediation.packages, bundles: bundles.map(({ owner, file, sha256, picomatch }) => ({ owner, file, sha256, picomatch })) }, null, 2)}\n`,
);
for (const item of remediated) {
  process.stdout.write(
    `Verified local remediation: ${item.advisory}; review by ${item.reviewBy}\n`,
  );
}
process.stdout.write("Complete dependency audit has no unremediated high/critical advisories.\n");
