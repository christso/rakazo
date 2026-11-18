import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkAuditCoverage,
  checkAuditSecurity,
  checkPatchReviewDate,
} from "./dependency-audit.mjs";

const lockfile = `---
packages:
  pnpm@12: {}
---
importers:
  apps/api: {}
packages:
  foo@1:
    resolution: {integrity: example}
  bar@1: {}
  baz@1: {}
snapshots:
  foo@1: {}
`;

test("rejects a clean audit that covered only the package manager document", () => {
  assert.throws(
    () => checkAuditCoverage(lockfile, { metadata: { totalDependencies: 1 } }),
    /Incomplete/,
  );
});

test("rejects a workspace-only audit that omitted the package manager document", () => {
  assert.throws(
    () => checkAuditCoverage(lockfile, { metadata: { totalDependencies: 3 } }),
    /Incomplete/,
  );
});

test("accepts complete multi-document and single-document audits", () => {
  checkAuditCoverage(lockfile, { metadata: { totalDependencies: 4 } });
  checkAuditCoverage(lockfile.slice(lockfile.indexOf("importers:")), {
    metadata: { totalDependencies: 3 },
  });
});

test("missing inventory or report metadata cannot pass as clean", () => {
  assert.throws(() => checkAuditCoverage("", {}), /No lockfile package/);
  assert.throws(() => checkAuditCoverage(lockfile, {}), /Incomplete/);
});

const advisory = (changes = {}) => ({
  github_advisory_id: "GHSA-fc5q-39xc-vjpf",
  module_name: "picomatch",
  severity: "high",
  findings: [
    { version: "2.3.2", paths: ["fixture>picomatch"] },
    { version: "4.0.7", paths: ["another-fixture>picomatch"] },
  ],
  ...changes,
});
const report = (finding = advisory()) => ({
  advisories: { finding },
  metadata: { totalDependencies: 4, vulnerabilities: { high: 1, critical: 0 } },
});
const reviewDate = new Date("2026-11-18T00:00:00Z");

test("the exact advisory requires both installed patched versions", () => {
  assert.throws(() => checkAuditSecurity(lockfile, report(), [], reviewDate), /Unremediated/);
  assert.throws(
    () => checkAuditSecurity(lockfile, report(), ["4.0.7"], reviewDate),
    /Unremediated/,
  );
  assert.equal(
    checkAuditSecurity(lockfile, report(), ["2.3.2", "4.0.7"], reviewDate)[0].advisory,
    "GHSA-fc5q-39xc-vjpf",
  );
});

test("other advisories, packages and versions cannot use the remediation", () => {
  for (const changed of [
    advisory({ github_advisory_id: "GHSA-unrelated" }),
    advisory({ module_name: "another-package" }),
    advisory({ findings: [{ version: "4.0.8", paths: ["fixture>picomatch"] }] }),
    advisory({ findings: [] }),
  ]) {
    assert.throws(
      () => checkAuditSecurity(lockfile, report(changed), ["2.3.2", "4.0.7"], reviewDate),
      /Unremediated/,
    );
  }
});

test("the patch exception expires and incomplete or inconsistent reports still fail", () => {
  assert.throws(
    () =>
      checkAuditSecurity(lockfile, report(), ["2.3.2", "4.0.7"], new Date("2026-12-19T00:00:00Z")),
    /scheduled review/,
  );
  assert.throws(() => checkAuditSecurity(lockfile, { metadata: { totalDependencies: 4 } }));
  const missing = report();
  missing.advisories = {};
  assert.throws(
    () => checkAuditSecurity(lockfile, missing, ["2.3.2", "4.0.7"], reviewDate),
    /totals disagree/,
  );
});

test("malformed advisory severities cannot masquerade as a clean audit", () => {
  for (const item of [null, {}, { severity: "unknown" }]) {
    const malformed = report(item);
    malformed.metadata.vulnerabilities.high = 0;
    assert.throws(() => checkAuditSecurity(lockfile, malformed), /Malformed dependency advisory/);
  }
});

test("patch review dates require a real ISO calendar date", () => {
  checkPatchReviewDate("2026-12-18");
  for (const value of ["forever", "2026-99-99", "2026-02-30", "2026-1-1", "2026-12-18T00:00:00Z"]) {
    assert.throws(() => checkPatchReviewDate(value), /Invalid local patch review date/);
  }
});
