---
title: Hibernate and release managed computers
date: 2026-11-20
status: implemented
---

# Hibernate and release managed computers

Add an opt-in idle policy for managed cloud computers in Space settings. **Keep VM** powers the computer off and keeps its disk. **Hibernate and release** saves the disk as a provider snapshot and releases the VM. Existing Spaces default to **Keep VM**. The provider can charge for snapshot storage, and restoring a disk can take longer than starting a stopped VM.

## Main flow

1. An administrator chooses **Hibernate and release** for a Space with a supported computer connection.
2. Rakazo uses its existing idle checks and suspend claim to wait for the computer to finish work. It checkpoints the workspace and shuts down the VM before requesting a disk snapshot.
3. Rakazo records the snapshot attempt before contacting the provider. Once the provider confirms that the exact snapshot is ready, Rakazo records it as the recovery point, deletes the source VM, and confirms deletion.
4. The next start restores the same logical computer from that snapshot. Rakazo checks the authenticated runtime at the replacement VM’s address. The replacement boots with the same pinned per-computer gateway identity from the disk, and the recovery copy is kept until a later snapshot is ready or the computer is deleted.
5. Permanent deletion removes the VM and any snapshots Rakazo created for the computer. A bot's private computer is deleted with its owner. A Team computer remains available to other bots when a member bot is deleted. Warn about permanent loss of the private computer and its snapshots.

## Implementation

- [x] U1. Add the Space policy and expose it in web and mobile Computers settings for snapshot-capable connections. Validate capability on the server. Keep original credential bindings for existing computers and make the schema migration additive.
- [x] U2. Add provider snapshot creation, lookup, readiness, restoration, and deletion inside the two cloud adapters. Give each snapshot attempt a unique ownership marker. Recover the exact snapshot if a create response is lost. Use a distinct provider marker for the replacement VM and check its authenticated runtime at the new address.
- [x] U3. Integrate disk hibernation with the idle claim and next-start path. Store the source generation, snapshot attempt, and restore progress durably. Coordinate sleep, wake, reset, and delete for the same computer. Keep a good copy across timeout, worker loss, and restore failure. Let existing safety stops retain their current behavior.
- [x] U4. Extend computer teardown and credential retention to cover snapshots. Inspect the bot, reset, account, and Space deletion paths that use `computer-lifecycle.ts`. Reuse durable cleanup and keep ownership records and credentials available until the provider confirms cleanup. Check shared computers separately.
- [x] U5. Verify the settings, idle fencing, lost create response, failed snapshot, wake after VM release, failed restore, cleanup retries, and shared ownership offline. The provider smoke described below verifies the live restore separately.

## Recovery rules

The source disk remains authoritative until a ready snapshot is recorded. An accepted snapshot request can outlive a worker, so a retry reconciles its recorded attempt before it submits a second request. If snapshot creation fails, Rakazo can still start the source disk. If restore fails, the snapshot stays available for another attempt. Provider calls operate on exact owned resource identities. Deleting a bot or Space must preserve the information needed to finish provider cleanup.

The implementation starts from fork commit `22322b622`. Existing orchestration lives in `computer-idle.ts`, `computer-lifecycle.ts`, and `space-computer-connection-cleanup.ts`. The two provider clients share `CloudRuntimeSandbox`. Herdr's provider plugins establish the snapshot-before-delete order. Rakazo also needs to preserve Space connection routing and shared computer ownership.

## Verification and handoff

- Offline tests cover the Space default, failed snapshot, lost create responses, restore reconciliation, deletion retries, and foreign snapshots. PostgreSQL tests cover policy validation, tenant isolation, and retaining the computer row while a snapshot receipt exists. Chromium verifies the Space control and save payload.
- A single shell-environment test in the broader computer suite fails on the original provider branch too.
- When provider cleanup fails during Delete bot, Rakazo records a job that retries provider teardown. The bot remains until Delete bot succeeds. A Team computer belongs to the Space and survives member bot deletion.

### Live provider verification

Both providers passed on 20 November 2026 against Rakazo revision `ac6837ba3`. On each provider,
the idle handler waited for a ready snapshot and deleted the source VM. A replacement VM on a
different IP served the authenticated desktop and retained a file written before hibernation.
Deleting the dedicated bot removed the replacement VM and snapshot. The test invoked the idle
handler directly, so these timings exclude the time a worker waits before running the idle job.

| Provider | Test configuration                       | Hibernate and release | Wake and verify |
| -------- | ---------------------------------------- | --------------------: | --------------: |
| Hetzner  | Falkenstein (`fsn1`), `cpx22`, Debian 12 |                4m 21s |          1m 09s |
| Vultr    | Sydney (`syd`), `vc2-2c-4gb`, Debian 13  |               16m 33s |          7m 59s |

Hibernate and release includes the workspace export, VM shutdown, snapshot creation and
confirmation that the source VM was gone. Wake and verify ends when the saved file and desktop
work on the replacement. About 15 minutes elapsed between Vultr accepting the snapshot request
and confirmed source VM deletion. The Hetzner run recorded the full release time only.

Each provider ran once, with a different region, plan and guest image. The cause of the timing
gap is unknown.
