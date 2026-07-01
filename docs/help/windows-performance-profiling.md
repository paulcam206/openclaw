---
summary: "Capture and compare Windows performance profiles for OpenClaw source workflows"
read_when:
  - Profiling OpenClaw install, build, startup, gateway, or TUI latency on Windows
  - Comparing a performance fix against a Windows baseline
  - Collecting ETW evidence for a local Windows performance investigation
title: "Windows performance profiling"
---

Use the Windows performance harness when an OpenClaw source checkout is slow on
Windows and you need repeatable evidence before changing code or preparing an
upstream/platform bug packet. The harness writes one artifact directory with
machine metadata, command logs, benchmark JSON, optional WPR ETW traces, and
summaries that can be compared with a baseline.

## Prerequisites

- Windows with PowerShell.
- Node and pnpm versions supported by the repo.
- A source checkout with dependencies installed.
- Windows Performance Toolkit when using `--wpr`.
- An elevated terminal when starting WPR traces.

The harness does not file bugs. It only captures evidence and classifies results
so a maintainer can decide whether to fix OpenClaw code, change local
configuration, or prepare an upstream/platform report.

## Quick start

From a source checkout:

```powershell
pnpm install
pnpm perf:windows -- --preset quick
```

The default `quick` preset runs the CLI startup benchmark and writes artifacts
under `.artifacts/perf/windows/<run-id>`.

To collect ETW traces, add `--wpr`. WPR capture is scenario-scoped by default,
so presets write one ETL per selected scenario:

```powershell
pnpm perf:windows -- --preset runtime --wpr --wpr-profile OpenClawWindowsDeepCompat
```

Use the compat profile first. If your Windows build accepts `FileIOInit`, use the
deeper profile:

```powershell
pnpm perf:windows -- --preset runtime --wpr --wpr-profile OpenClawWindowsDeep
```

## Scenario presets

| Preset    | Coverage                                                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `quick`   | CLI startup benchmark only.                                                                                                            |
| `build`   | `pnpm build` and `pnpm ui:build`.                                                                                                      |
| `runtime` | Onboarding, gateway startup, CLI startup, and gateway-backed TUI first-result smoke.                                                   |
| `source`  | Gateway startup, bundled plugin memory, CLI startup, and SQLite smoke.                                                                 |
| `full`    | Install, full build, onboarding, gateway startup, CLI startup, gateway-backed TUI first-result smoke, plugin memory, and SQLite smoke. |

Run one scenario directly with `--scenario <id>`:

```powershell
pnpm perf:windows -- --scenario onboarding
pnpm perf:windows -- --scenario gateway-startup --runs 5 --warmup 1
pnpm perf:windows -- --scenario tui-gateway-pty
```

The default TUI scenario starts a local Gateway, connects the TUI through the
Gateway WebSocket, sends an initial message, and waits for the first mocked
assistant response. It is not a live-provider proof. Gateway startup and TUI PTY
scenarios disable bundled source overlays so an unrelated source-overlay
discovery issue does not mask baseline timing.

## Artifacts

Each run writes:

- `metadata.json`: OS, Node, pnpm, git, selected options, and relevant env state.
- `plan.json`: selected scenarios and WPR settings.
- `timings.json`: scenario results as they finish.
- `summary.json`: final status, duration, source summary pointer, and WPR trace info.
- `logs/*.stdout.log` and `logs/*.stderr.log`: command output for each step.
- `source/**`: artifacts compatible with `scripts/openclaw-performance-source-summary.mjs` when the selected scenarios produce the required inputs.
- `traces/<scenario>.etl`: per-scenario WPR traces when `--wpr` is used.

When `cli-startup` runs with `--node-prof`, V8 CPU and heap profiles are written
under the run directory:

```powershell
pnpm perf:windows -- --scenario cli-startup --node-prof
```

## Baseline comparisons

Capture a baseline, keep its artifact directory, then run a candidate with
`--baseline-dir`:

```powershell
$baseline = ".artifacts/perf/windows/baseline"
pnpm perf:windows -- --preset source --output-dir $baseline

$candidate = ".artifacts/perf/windows/candidate"
pnpm perf:windows -- --preset source --output-dir $candidate --baseline-dir "$baseline/source"
```

For CLI startup only, reuse the benchmark comparator directly:

```powershell
node --import tsx scripts/bench-cli-startup.ts `
  --compare-baseline "$baseline/source/cli-startup.json" `
  --compare-candidate "$candidate/source/cli-startup.json"
```

## WPR profiles

The committed WPR profile file is `scripts/perf/openclaw-windows.wprp`.

| Profile                     | Use                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `OpenClawWindowsLight`      | Lower-overhead process, loader, disk, file, and hard-fault capture.                         |
| `OpenClawWindowsDeepCompat` | CPU, scheduler, registry, network, disk, file, and hard-fault capture without `FileIOInit`. |
| `OpenClawWindowsDeep`       | Same as compat plus `FileIOInit` when the OS accepts it.                                    |

Validate the profiles before a long run:

```powershell
wpr -profiles .\scripts\perf\openclaw-windows.wprp
```

If WPR is unavailable or blocked but you still want the benchmark artifacts, add
`--wpr-optional`.

Use one run-scoped ETL only when you need cross-scenario correlation:

```powershell
pnpm perf:windows -- --preset runtime --wpr --wpr-scope run
```

Run-scoped capture writes `openclaw-windows.etl` at the artifact root.

## Interpreting results

Start with `summary.json`, then inspect the scenario logs and benchmark JSON for
the slow phase. Use the ETL to decide whether the wall time is CPU, process
creation, file I/O, hard faults, registry work, network, or another process such
as security scanning. Use V8 profiles for Node CPU-bound phases.

Only treat an improvement as real after rerunning the affected scenario with the
same options and checking that adjacent scenarios do not regress.
