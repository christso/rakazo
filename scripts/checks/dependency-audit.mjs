import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const remediation = JSON.parse(
  readFileSync(new URL("../security/picomatch-patches.json", import.meta.url), "utf8"),
);
const LOCAL_PICOMATCH_ADVISORY = remediation.advisory;
const PATCHED_PICOMATCH_VERSIONS = new Set(Object.keys(remediation.packages));
const PATCH_REVIEW_BY = remediation.reviewBy;

// pnpm 12 writes package-manager and workspace locks as separate YAML documents.
// Count package keys across every document; omitting either document must fail.
export function checkAuditCoverage(lockfile, report) {
  const counts = lockfile.split(/^---[ \t]*\r?$/m).map((document) => {
    let inPackages = false;
    let count = 0;
    for (const line of document.split("\n")) {
      if (/^\S/.test(line)) inPackages = line.trim() === "packages:";
      else if (inPackages && /^ {2}\S/.test(line)) count++;
    }
    return count;
  });
  const minimum = counts.reduce((total, count) => total + count, 0);
  assert(minimum > 0, "No lockfile package entries found; audit coverage cannot be checked");
  const actual = report.metadata?.totalDependencies;
  assert(
    Number.isInteger(actual) && actual >= minimum,
    `Incomplete dependency audit: expected at least ${minimum} packages, got ${actual}`,
  );
}

export function checkPatchReviewDate(reviewBy) {
  assert(
    /^\d{4}-\d{2}-\d{2}$/.test(reviewBy) &&
      !Number.isNaN(Date.parse(reviewBy)) &&
      new Date(reviewBy).toISOString().slice(0, 10) === reviewBy,
    "Invalid local patch review date",
  );
}

/**
 * Only a verified installed-code remediation can clear the version-based
 * picomatch finding. The caller must verify the locked patches and run the
 * exploit regressions before supplying verifiedVersions.
 */
export function checkAuditSecurity(lockfile, report, verifiedVersions = [], now = new Date()) {
  checkAuditCoverage(lockfile, report);
  checkPatchReviewDate(PATCH_REVIEW_BY);
  const advisories = report.advisories;
  assert(advisories && typeof advisories === "object" && !Array.isArray(advisories));
  const counts = report.metadata?.vulnerabilities;
  for (const severity of ["high", "critical"]) {
    assert(Number.isInteger(counts?.[severity]) && counts[severity] >= 0, "Invalid audit totals");
  }
  for (const item of Object.values(advisories)) {
    assert(
      item &&
        typeof item === "object" &&
        ["info", "low", "moderate", "high", "critical"].includes(item.severity),
      "Malformed dependency advisory",
    );
  }
  const severe = Object.values(advisories).filter((item) =>
    ["high", "critical"].includes(item.severity),
  );
  assert.equal(severe.length, counts.high + counts.critical, "Audit findings and totals disagree");
  const remaining = [];
  const remediated = [];
  for (const advisory of severe) {
    const findings = advisory.findings;
    const verified =
      advisory.github_advisory_id === LOCAL_PICOMATCH_ADVISORY &&
      advisory.module_name === "picomatch" &&
      Array.isArray(findings) &&
      findings.length > 0 &&
      findings.every(
        (finding) =>
          PATCHED_PICOMATCH_VERSIONS.has(finding.version) &&
          verifiedVersions.includes(finding.version) &&
          Array.isArray(finding.paths) &&
          finding.paths.length > 0,
      );
    if (!verified) {
      remaining.push(advisory.github_advisory_id ?? advisory.title ?? "Unknown advisory");
      continue;
    }
    assert(
      now.toISOString().slice(0, 10) <= PATCH_REVIEW_BY,
      "The local picomatch security patch needs its scheduled review",
    );
    remediated.push({
      advisory: LOCAL_PICOMATCH_ADVISORY,
      versions: [...new Set(findings.map((item) => item.version))].sort(),
      reviewBy: PATCH_REVIEW_BY,
    });
  }
  assert.equal(
    remaining.length,
    0,
    `Unremediated high/critical advisories: ${remaining.join(", ")}`,
  );
  return remediated;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkAuditCoverage(
    readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8"),
    JSON.parse(readFileSync(process.argv[2], "utf8")),
  );
}
