# Computer CPU/RAM feedback under real load

The before and after recordings show the real Rakazo web app, API, Pi runtime, native shell tools and a real Docker computer. The account and data are disposable fixtures. Model responses come from the included deterministic policy emulator; this is a test of resource measurement and delivery through the model/tool boundary, not live LLM reasoning.

## Scenario

Both runs use the same temporary account, computer and prompt. The computer is capped at 1 GiB RAM and one CPU, with swap disabled (`MemorySwap` equals `Memory`). `workload.py` holds 800 MiB of real memory and runs a CPU loop; it exits automatically after four minutes. `page.py` serves a local fixture page. No real user browser session or retailer is involved.

The prompt is: “Inspect the local test page. Continue the task, and release only your fixture-owned unused work if the computer reports resource pressure.” The synthetic policy first inspects that page with a native shell tool. It selects cleanup only if the returned structured resource reading reports memory pressure. The cleanup stops only the fixture-owned workload, checks that the page still responds, and asks the new `computer_resources` tool for a fresh reading.

## Evidence

- [Before MP4](before.mp4): baseline fork revision `13c687758424bd775de504a68b01bcf012f2df8e`. Independent cgroup measurements show about 89% working-set memory and 99% CPU, with no OOM kills. The native tool result carries no automatic resource reading, so this synthetic policy has no signal to trigger cleanup.
- [After MP4](after.mp4): the same baseline plus the resource-feedback feature, identified by tested bundle hashes in [results.json](results.json). The model input receives a 90% RAM-pressure reading. The synthetic policy stops the fixture-owned workload and requests a fresh reading: 11% RAM and 40.9% CPU. An independent cgroup sample finishes at 10.2% working-set memory; the local fixture page remains available and there are zero OOM kills.
- [Before result frame](before-result.png) and [after result frame](after-result.png).
- Independent measurements are in [before-cgroup-metrics.json](before-cgroup-metrics.json) and [after-cgroup-metrics.json](after-cgroup-metrics.json). Working-set memory is `memory.current - inactive_file`, divided by the cgroup limit. CPU percentages in the tool use a short sample; the before caption uses the independent measurement window, so their intervals differ. In the definitive after run, the immediate 200 ms CPU reading was 40.9%; the later independent 2.1-second window averaged about 11%. These readings include background desktop work and measurement overhead.

`model.py` contains the synthetic decision policy. `workload.py` and `page.py` contain the real load and local page. The after feature exposes measurements and guidance; it does not automatically kill processes. Cleanup in this demonstration is explicitly selected by the synthetic policy.

The videos are H.264 MP4, 1280×940, yuv420p, with fast-start metadata. Captions sit below the actual captured viewport. Their numbers come from the recorded measurements.

## Limits

This demonstrates live resource sampling, automatic delivery to the agent, explicit resource-tool access and a controlled cleanup response under real CPU/RAM load. It does not establish how reliably a live language model chooses cleanup, reproduce the earlier payment prompt, or prove that every browser timeout was caused by RAM pressure. No OOM was induced, no paid model was used, and production accounts were not changed.

## Implementation and checks

The tested source is [the fork feature commit](https://github.com/christso/rakazo/commit/da30aca6b75e540d6bccacde9f05b5aed994a604). The new `computer_resources` tool returns fresh readings, and computer/browser tool results receive them automatically after the computer is used. Measurements include the timestamp, actual memory ceiling, working-set bytes, CPU quota and sampling interval. Memory pressure at 85% adds guidance to release unused resources created by the task while preserving other work. Unsupported measurements remain unavailable. This prototype adds agent feedback and an on-demand tool; it does not add a continuously refreshed resource dashboard.

Final focused verification passed 212 tests, including cgroup v1/v2 limits, inherited ceilings, controller aliases, tool-result delivery and loop-guard behavior. Core, contracts, adapters and API typechecks passed; repository-wide Biome check passed with warnings. The broader suite was not green. After correcting the test environment and rechecking every failed suite, 372 checks passed and nine failures remained across five unchanged test files (type scale, shell environment, backup scripts, screenshot inventory and desktop lifecycle). These failures were not reproduced on a clean baseline, so they are not claimed as proven pre-existing failures. See [verification.json](verification.json) for counts and scope. Live-LLM cleanup reliability and remote-provider overhead remain untested.
