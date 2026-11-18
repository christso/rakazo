# Dependency security

Run `pnpm audit:security` after a frozen install. It audits the complete workspace,
including build and release tooling and the package-manager lock document. The
original registry report and any local remediation evidence are retained under
`.tmp/security/`; CI uploads both reports even when verification fails.

## Temporary picomatch remediation

[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
affects the installed picomatch 2.3.2 and 4.0.7 releases. At the time this patch was
added, the registry offered no fixed release. The exact versions are patched with
pnpm rather than replaced with a different major version.

The patches collapse single-branch repeated wildcard extglobs when their matching
language is unchanged, reject ambiguous literal-prefix alternatives, and check the
compiled expression for remaining nested wildcard repetition. Repeated wildcard
alternatives whose unique decoding is uncertain, unsafe complex expressions, and
repeated non-ASCII alternatives with explicit Unicode case-folding flags fall back
to literal matching, following the parser's existing
hardening policy. Ordinary globs and safe extglobs remain supported. Capture values
inside rewritten repeated groups can differ; callers that explicitly set
`maxExtglobRecursion: false` retain the upstream opt-out and its risks. This is a
remediation for the repeated-wildcard advisory, not a general safe-regex engine.

An expanded comparison against the upstream matcher suite found deliberate
matching changes for repeated negations, uncertain complex alternatives and
malformed repeated patterns. These include `*(!(f))`, `*(a*|b)` and
`*(b+(c)d|e*(f)g?|?(h)i@(j|k))`. Common literal alternatives such as
`+(js|jsx)` and `*(fo|foo)` keep their matches. Callers relying on the more complex
forms must account for literal fallback; the upstream suite is not claimed to
pass unchanged.

The compiled-expression guard is adapted from
[upstream PR 264](https://github.com/micromatch/picomatch/pull/264); single-branch
rewrites follow the approach in
[PR 266](https://github.com/micromatch/picomatch/pull/266). These proposals were
unmerged when this remediation was added.

The registry still reports the affected version numbers. The audit gate accepts
that one finding only after verifying the tracked patch hashes, every lockfile
reference, every installed picomatch reachable through workspace dependency links,
and bounded subprocess exploit regressions. Unknown versions, separate unpatched
runtime copies, changed patches, incomplete audits and other high or critical
advisories fail. The original finding remains visible in the report.

The acceptance expires on the date in
`scripts/security/picomatch-patches.json` (initially 18 December 2026). Before then,
review upstream releases and proposals. When a fixed release is available, upgrade
all affected versions, remove the temporary patch acceptance, and retain useful
exploit regressions. Changes to a local patch require renewed review, new hashes
and a regenerated lockfile; changing only the expiry does not establish a fix.
