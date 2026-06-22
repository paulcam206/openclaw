# MXC sandbox execution plugin

Use the MXC plugin to run OpenClaw exec-tool commands inside OS-level
containment on hosts where MXC can create the selected sandbox backend. In this
README, an MXC-capable host means the gateway or node host has the MXC executor
installed and passes the platform readiness checks below.

The recommended path is explicit opt-in with MXC's abstract `process`
containment:

- Windows: ProcessContainer / AppContainer.
- Linux: Bubblewrap.
- macOS: Seatbelt.

The plugin builds MXC sandbox payloads for OpenClaw tool execution and applies
filesystem, network, and timeout policy before commands reach the host.

## Requirements

- OpenClaw must load the bundled `mxc` plugin, and `plugins.entries.mxc.enabled`
  must be `true`.
- The host must be Windows, Linux, or macOS.
- Windows hosts must be Windows build 26100 or later. Builds 26100 through 26499
  also require UBR 7965 or later. The IsoEnvBroker service must be running
  because MXC uses BaseContainer for AppContainer brokering.
- Linux hosts must have the MXC Linux executor available and Bubblewrap installed
  on `PATH`.
- macOS support uses MXC Seatbelt containment and is experimental. Prefer
  `containment: "process"` unless you are validating a platform-specific path.

## Quickstart

Add the plugin entry to `openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "mxc": {
        "enabled": true,
        "config": {
          "containment": "process",
          "network": "none",
        },
      },
    },
  },
}
```

Load the updated OpenClaw config, then run a small exec command with an explicit
sandbox host:

```json
{ "tool": "exec", "host": "sandbox", "command": "pwd" }
```

Expected result: the command runs in the MXC sandbox backend. If the host is not
ready, `host=sandbox` fails closed instead of falling back to gateway execution.

## Configuration

Set MXC options in `openclaw.json` under `plugins.entries.mxc.config`:

```jsonc
{
  "containment": "process",
  "network": "none",
  "timeoutSeconds": 120,
  "debug": false,
  "readwritePaths": ["/tmp"],
}
```

| Key              | Type     | Default                 | Description                                                                                      |
| ---------------- | -------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| `mxcBinaryPath`  | string   | auto-discover           | Override discovery of the platform MXC executor. Omit this unless you need a custom binary path. |
| `containment`    | string   | `"process"`             | Abstract MXC process containment. `processcontainer` is Windows-only.                            |
| `network`        | string   | `"none"`                | `"none"` blocks outbound network; `"default"` allows outbound network.                           |
| `timeoutSeconds` | number   | policy baseline (`300`) | Per-command timeout in seconds. When omitted, the sandbox policy timeout applies.                |
| `debug`          | boolean  | `false`                 | Pass debug mode to the MXC executor.                                                             |
| `readwritePaths` | string[] | none                    | Extra filesystem paths granted read-write access. The workdir is always added.                   |

## Sandbox policy files

Sandbox policy is configured through user and machine policy files. Policy layers
are loaded in this order:

1. User policy: `~/.openclaw/sandbox-policy.json`
2. Machine policy:
   - Windows: `C:\ProgramData\openclaw\sandbox-policy.json`
   - macOS: `/Library/Application Support/openclaw/sandbox-policy.json`
   - Linux/other Unix: `/etc/openclaw/sandbox-policy.json`

Example user policy:

```json
{
  "network": {
    "denyPrivateNetworks": true,
    "denyCloudMetadata": true,
    "additionalDeniedHosts": ["metadata.example.test"],
    "additionalDeniedCidrs": ["203.0.113.0/24"]
  },
  "filesystem": {
    "denyCredentialStores": true,
    "restrictToProjectDir": true,
    "additionalDeniedPaths": ["/workspace/.env"],
    "additionalReadonlyPaths": ["/usr/bin"],
    "additionalReadwritePaths": ["/tmp"]
  },
  "process": {
    "timeoutSeconds": 300
  }
}
```

Arrays are additive and de-duplicated. Scalar conflicts use the most restrictive
value. For baseline process timeouts, the most restrictive value is the shortest
configured timeout. Hardening booleans such as `denyCredentialStores`,
`restrictToProjectDir`, `denyPrivateNetworks`, and `denyCloudMetadata` can only
be set to `true`; policy files cannot weaken those defaults with `false`.
Malformed policy files and unknown keys fail loading instead of being ignored.

## Platform readiness

### Windows

Before registering the sandbox backend, the plugin checks the Windows build,
UBR threshold, and IsoEnvBroker availability. Unsupported hosts leave the plugin
dormant and print remediation.

### Linux

With `containment: "process"`, the plugin checks readiness before it registers
the sandbox backend. Load fails with remediation if any requirement is missing:

1. The MXC Linux executor is discoverable.
2. `bwrap --version` succeeds, meaning Bubblewrap is installed and on `PATH`.
3. A minimal
   `bwrap --unshare-user --unshare-net --ro-bind / / --dev /dev /bin/true`
   probe exits 0, proving the kernel and any active Linux Security Module allow
   the unprivileged user namespace and mount syscalls the sandbox needs. The
   root bind is readonly and only makes `/bin/true` plus its loader/libraries
   available inside the probe sandbox.

Common remediation:

```bash
# Debian/Ubuntu
sudo apt install bubblewrap

# Fedora/RHEL
sudo dnf install bubblewrap

# Alpine
apk add bubblewrap
```

If the probe fails after `bwrap` is installed, the host is blocking unprivileged
user namespaces:

- Debian and older Ubuntu kernels: `sudo sysctl -w kernel.unprivileged_userns_clone=1`
  (persist via `/etc/sysctl.d/`).
- Ubuntu 24.04 and other distros with restricted AppArmor profiles:
  `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` or grant the
  AppArmor `userns` capability to `bwrap`.
- Distros that omit the sysctl entirely, such as Fedora and Arch on recent
  kernels, usually allow unprivileged user namespaces by default. If the probe
  still fails, check the kernel `CONFIG_USER_NS` setting and any custom Linux
  Security Module policy.

### macOS

macOS uses MXC Seatbelt support through abstract `process` containment. Treat it
as experimental until validated on the target host.

## Backend selection

| Value                                                     | Platform              | Status       | Notes                                                                                    |
| --------------------------------------------------------- | --------------------- | ------------ | ---------------------------------------------------------------------------------------- |
| `process`                                                 | Windows, Linux, macOS | Recommended  | MXC resolves to ProcessContainer on Windows, Bubblewrap on Linux, and Seatbelt on macOS. |
| `processcontainer`                                        | Windows               | Supported    | Direct Windows ProcessContainer selection. Rejected on non-Windows platforms.            |
| `seatbelt`                                                | macOS                 | Experimental | Prefer abstract `process`; direct `seatbelt` requires MXC experimental support.          |
| `windows_sandbox`, `wslc`, `microvm`, `isolation_session` | Windows               | Experimental | Requires MXC experimental support that this plugin does not enable.                      |

When `mxcBinaryPath` is unset, the resolver searches for the platform MXC
executor in this order:

1. `@microsoft/mxc-sdk/bin/<arch>/<binary>` or `@microsoft/mxc-sdk/bin/<binary>`
2. `<binary>` on `PATH`
3. `~/.mxc/<binary>`
4. Platform-specific system install locations

The first existing file wins. Project-local `bin/` directories are not searched
implicitly; set `mxcBinaryPath` to use a custom executor path.

## Troubleshooting

### `host=sandbox` does not run on MXC

Check that `plugins.entries.mxc.enabled` is `true` and that the plugin
entry exists in `openclaw.json`. The plugin is explicit opt-in and stays dormant
without that top-level `enabled: true` flag.

### The plugin loads but does not register on Windows

Check the Windows build, UBR, and IsoEnvBroker service. Unsupported Windows
hosts leave the plugin dormant instead of registering a backend that cannot run.

### Linux readiness fails after installing Bubblewrap

Run `bwrap --version`, then check whether unprivileged user namespaces are
blocked by kernel or Linux Security Module policy. See the Linux remediation
commands above.

### Policy file loading fails

Validate the JSON shape in `~/.openclaw/sandbox-policy.json` and the machine
policy file. Unknown top-level keys, unknown section keys, invalid scalar types,
and non-string array entries fail loading.

### Explicit `host=sandbox` fails closed

This is expected when no sandbox backend is registered. Use the remediation
message to fix MXC readiness, or use `host=gateway` with approvals when sandbox
execution is not required.

## Maintainer notes

`buildExecSpec` builds an MXC config payload and invokes a plugin-side Node
launcher. The launcher imports `@microsoft/mxc-sdk`, calls
`spawnSandboxFromConfig`, and lets the SDK own PTY allocation.

`runShellCommand` is used by management and filesystem bridge paths. It calls the
MXC executor directly with `--config-base64`, no PTY, forced `network: "none"`,
and a 30 second timeout. On Linux Bubblewrap, non-empty stdin is written to a
temporary file inside the mounted workdir and the command reads from that file,
because MXC's current Bubblewrap runner starts `bwrap` with stdin closed.

Linux network policy is platform-aware:

- `network: "none"` with no allowlist drops baseline blocked hosts so MXC can use
  Bubblewrap's strict network namespace path.
- Host allow/block rules under Linux `process` request MXC firewall enforcement
  instead of AppContainer capabilities.
- Windows ProcessContainer still uses capabilities for network isolation.

### Limitations

- Experimental MXC backends are not enabled by this plugin. The launcher passes
  `{ debug }` to `spawnSandboxFromConfig`, not `experimental: true`.
- The sandboxed child does not inherit `process.env` from the MXC payload on all
  platforms, so the plugin inlines the command script into `process.commandLine`.
- Containers are ephemeral. Each command gets a fresh `containerId` and
  `lifecycle.destroyOnExit: true`.
- Windows commands are wrapped with `cmd.exe /d /s /c "<script>"`; the workdir is
  passed as MXC `process.cwd` rather than by running `cd /d` inside the sandbox.

### Module guide

```text
extensions/mxc/
|-- index.ts
|-- openclaw.plugin.json
|-- package.json
|-- src/
|   |-- binary-resolver.ts
|   |-- config.ts
|   |-- mxc-backend.ts
|   |-- mxc-spawn-launcher.mjs
|   |-- plugin-root.ts
|   |-- plugin.ts
|   |-- readiness.ts
|   |-- sandbox-baseline.ts
|   |-- sandbox-policy-loader.ts
|   `-- windows-version.ts
`-- test/
    |-- binary-resolver.test.ts
    |-- config.test.ts
    |-- mxc-backend.test.ts
    |-- mxc-spawn-launcher.test.ts
    |-- plugin-root.test.ts
    |-- plugin.test.ts
    |-- readiness.test.ts
    |-- sandbox-policy-loader.test.ts
    `-- windows-version.test.ts
```

## Testing

```bash
pnpm test extensions/mxc
```
