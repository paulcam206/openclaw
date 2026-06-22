import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type {
  SandboxBackendHandle,
  SandboxBackendExecSpec,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  CreateSandboxBackendParams,
  SandboxBackendManager,
} from "openclaw/plugin-sdk/sandbox";
import { resolveMxcBinaryPath } from "./binary-resolver.js";
import type { MxcConfig } from "./config.js";
import { resolveMxcLauncherPath } from "./plugin-root.js";
import {
  computeEffectiveBlockedHosts,
  computeEffectiveDeniedPaths,
  computeEffectiveReadonlyPaths,
  computeEffectiveReadwritePaths,
  type BaselineTempEnv,
  type SandboxBaselinePlatform,
  type SandboxBaselinePolicy,
} from "./sandbox-baseline.js";
import {
  loadSandboxBaselinePolicy,
  type SandboxPolicyLoaderOptions,
} from "./sandbox-policy-loader.js";

type MxcContainerConfig = {
  version: string;
  containerId: string;
  containment: string;
  lifecycle: { destroyOnExit: boolean };
  process: {
    commandLine: string;
    cwd: string;
    env: string[];
    timeout: number;
  };
  filesystem: {
    deniedPaths?: string[];
    readwritePaths?: string[];
    readonlyPaths?: string[];
    clearPolicyOnExit?: boolean;
  };
  network: {
    defaultPolicy: "allow" | "block";
    enforcementMode?: "capabilities" | "firewall" | "both";
    allowedHosts?: string[];
    blockedHosts?: string[];
  };
  processContainer?: {
    name: string;
    leastPrivilege: boolean;
    capabilities: string[];
    ui: {
      isolation: "container";
      desktopSystemControl: false;
      systemSettings: "none";
      ime: false;
    };
  };
};

const MXC_SCHEMA_VERSION = "0.6.0-alpha";
const PROCESS_CONTAINER_NAME_MAX_LEN = 64;

type MxcExecFinalizeToken = {
  payloadDir: string;
};

const LAUNCHER_ENV_KEYS = [
  "SystemRoot",
  "SystemDrive",
  "ComSpec",
  "WINDIR",
  "PATH",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
] as const;

function sanitizeRuntimeId(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `openclaw-mxc-${slug || "sandbox"}-${hash}`;
}

function createWindowsCommandBridge(params: {
  args: SandboxBackendCommandParams["args"];
  platform: NodeJS.Platform;
  script: string;
  workdir: string;
}): { command: string; cleanup: () => void } {
  if (params.platform !== "win32" || !params.args || params.args.length === 0) {
    return { command: params.script, cleanup: () => {} };
  }

  const bridgeDir = mkdtempSync(path.join(params.workdir, ".openclaw-mxc-cmd-"));
  const commandFile = path.join(bridgeDir, `${randomBytes(8).toString("hex")}.cmd`);
  try {
    writeFileSync(commandFile, `@echo off\r\n${params.script}`, { flag: "wx", mode: 0o600 });
  } catch (err) {
    rmSync(bridgeDir, { force: true, recursive: true });
    throw err;
  }
  return {
    command: commandFile,
    cleanup: () => rmSync(bridgeDir, { force: true, recursive: true }),
  };
}

// MXC containers are ephemeral (lifecycle.destroyOnExit=true) and named per invocation.
// Keep the runtimeId as the stable handle identifier (used for logs + SDK tracking) and
// derive a fresh per-call containerId from it so parallel spawns cannot collide on
// backend-specific runtime names.
const CONTAINER_ID_MAX_LEN = 80;
function uniqueContainerId(runtimeId: string): string {
  const suffix = randomBytes(4).toString("hex");
  const base =
    runtimeId.length + suffix.length + 1 > CONTAINER_ID_MAX_LEN
      ? runtimeId.slice(0, CONTAINER_ID_MAX_LEN - suffix.length - 1)
      : runtimeId;
  return `${base}-${suffix}`;
}

function configToBase64(config: MxcContainerConfig): string {
  return Buffer.from(JSON.stringify(config), "utf-8").toString("base64");
}

function createLauncherPayloadFile(
  payloadJson: string,
): MxcExecFinalizeToken & { payloadFile: string } {
  const payloadDir = mkdtempSync(path.join(tmpdir(), "openclaw-mxc-payload-"));
  const payloadFile = path.join(payloadDir, "payload.json");
  try {
    writeFileSync(payloadFile, payloadJson, { flag: "wx", mode: 0o600 });
  } catch (err) {
    rmSync(payloadDir, { force: true, recursive: true });
    throw err;
  }
  return { payloadDir, payloadFile };
}

function cleanupLauncherPayloadFile(token: unknown): void {
  if (
    token &&
    typeof token === "object" &&
    "payloadDir" in token &&
    typeof token.payloadDir === "string"
  ) {
    rmSync(token.payloadDir, { force: true, recursive: true });
  }
}

function buildLauncherEnv(hostEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of LAUNCHER_ENV_KEYS) {
    const value = getEnvValueCaseInsensitive(hostEnv, key);
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function defaultShell(platform: NodeJS.Platform): string {
  return platform === "win32" ? process.env.ComSpec?.trim() || "cmd.exe" : "/bin/sh";
}

// Build the commandLine string for MXC's `process.commandLine` field. Neither
// MXC runner we target propagates `process.env` to the child the way you'd
// expect, so inline the full script into commandLine on every platform.
//
// Linux (MXC executor): the runner parses commandLine via the host shell before
// the container env is honored. `/bin/sh -c $OPENCLAW_MXC_COMMAND_SCRIPT`
// with the var only set in `process.env` expanded to "" on the host and
// `/bin/sh -c` errored with "requires an argument".
//
// Windows (processcontainer / BaseContainerRunner): newer MXC SDK versions
// honour a non-empty `process.env` by building a replacement env block for
// CreateProcessInSandbox. When the block is present it replaces the entire
// default OS environment, so any vars not explicitly listed (SystemRoot,
// COMSPEC, …) are missing and cmd.exe fails with ERROR_ENVVAR_NOT_FOUND.
// The env block includes only required OS defaults plus caller overrides;
// `/s` makes cmd.exe strip exactly one outer quote pair without re-parsing,
// which lets the wrapped script keep embedded `"` chars.
function buildCommandLine(
  commandScript: string,
  args: readonly string[],
  platform: NodeJS.Platform,
): string {
  if (platform === "win32") {
    if (args.length === 0) {
      return `${defaultShell(platform)} /d /s /c "${commandScript}"`;
    }
    const escapedArgs = args.map(cmdArgumentEscape).join(" ");
    return `${defaultShell(platform)} /d /s /c "${cmdArgumentEscape(commandScript)} ${escapedArgs}"`;
  }
  // POSIX: when callers (e.g. the fs-bridge `read`/`write` tools) pass
  // positional args alongside a `set -eu` script that references `$1`/`$2`,
  // they must reach the inner script. Mirror the canonical pattern used by
  // the docker/ssh sandbox backends: `sh -c '<script>' openclaw-sandbox-fs
  // <arg1> <arg2> ...`; sh sees `openclaw-sandbox-fs` as `$0` (a name to
  // show in error messages) and the rest as `$1`, `$2`, etc.
  const head = `/bin/sh -c ${shellEscape(commandScript)}`;
  if (args.length === 0) {
    return head;
  }
  const argv0 = "openclaw-sandbox-fs";
  const escapedArgs = [argv0, ...args].map(shellEscape).join(" ");
  return `${head} ${escapedArgs}`;
}

function cmdArgumentEscape(value: string): string {
  return `"${value.replaceAll("^", "^^").replaceAll("%", "%%").replaceAll(`"`, `""`)}"`;
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function buildCommandScript(
  command: string,
  workdir: string,
  platform: NodeJS.Platform,
  stdinFile?: string,
): string {
  // Windows: do NOT prepend `cd /d <workdir>`. Inside the AppContainer
  // spawned by BaseContainer, cmd.exe runs under a restricted token that
  // can't access per-user paths like ~/.openclaw/sandboxes/<...>. The
  // sandbox API itself can launch the child in workdir (see resolveProcessCwd)
  // because MXC grants the AppContainer SID access to the cwd at spawn time;
  // a runtime `cd /d` from inside the sandbox is rejected with
  // "Access is denied" and bash tools see exit code 1.
  if (platform === "win32") {
    return command;
  }
  const escapedWorkdir = shellEscape(workdir);
  if (!stdinFile) {
    return `cd ${escapedWorkdir} && umask 0022 && ${command}`;
  }
  return `cd ${escapedWorkdir} && umask 0022 && (\n${command}\n) < ${shellEscape(stdinFile)}`;
}

function resolveProcessCwd(workdir: string): string {
  // Pass workdir as the sandbox's working directory. MXC's BaseContainer
  // runner grants the AppContainer SID access to this path at spawn time
  // (per readwritePaths brokering), so the child process starts inside
  // workdir without needing a script-level `cd` that the restricted token
  // would reject.
  return workdir;
}

function assertWorkdirInsideWorkspace(workspaceDir: string, workdir: string): string {
  const workspace = realpathForExistingPath(workspaceDir, "sandbox workspace");
  const candidate = realpathForPotentialPath(workdir);
  const relative = path.relative(workspace, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return candidate;
  }
  throw new Error(
    `MXC sandbox workdir ${workdir} is outside the sandbox workspace ${workspaceDir}. ` +
      `Use a workdir inside the sandbox workspace.`,
  );
}

function resolveWorkdirInsideWorkspace(workspaceDir: string, workdir: string): string {
  const candidate = assertWorkdirInsideWorkspace(workspaceDir, workdir);
  try {
    if (statSync(candidate).isDirectory()) {
      return candidate;
    }
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      throw new Error(`MXC sandbox workdir ${workdir} does not exist.`, { cause: err });
    }
    throw err;
  }
  throw new Error(`MXC sandbox workdir ${workdir} is not a directory.`);
}

function realpathForExistingPath(value: string, label: string): string {
  try {
    return realpathSync(path.resolve(value));
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      throw new Error(`MXC ${label} ${value} does not exist.`, { cause: err });
    }
    throw err;
  }
}

function realpathForPotentialPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync(resolved);
  } catch (err) {
    if (!isNodeError(err) || err.code !== "ENOENT") {
      throw err;
    }
    const parent = path.dirname(resolved);
    if (parent === resolved) {
      throw new Error(`MXC sandbox workdir ${value} does not exist.`, { cause: err });
    }
    return path.join(realpathForPotentialPath(parent), path.basename(resolved));
  }
}

function processContainerName(runtimeId: string): string {
  if (runtimeId.length <= PROCESS_CONTAINER_NAME_MAX_LEN) {
    return runtimeId;
  }
  const hash = createHash("sha256").update(runtimeId).digest("hex").slice(0, 8);
  return `${runtimeId.slice(0, PROCESS_CONTAINER_NAME_MAX_LEN - hash.length - 1)}-${hash}`;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function normalizeEnvRecord(env: Record<string, string>): string[] {
  const entries: string[] = [];
  for (const [key, value] of Object.entries(env).toSorted(([a], [b]) => a.localeCompare(b))) {
    if (!key || key.includes("=")) {
      continue;
    }
    entries.push(`${key}=${value}`);
  }
  return entries;
}

const WINDOWS_PROCESS_ENV_DEFAULT_KEYS = [
  "SystemRoot",
  "SystemDrive",
  "ComSpec",
  "WINDIR",
  "PATH",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ALLUSERSPROFILE",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "PUBLIC",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "NUMBER_OF_PROCESSORS",
] as const;

function getEnvValueCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const exact = env[key];
  if (exact !== undefined) {
    return exact;
  }
  const normalizedKey = key.toLowerCase();
  const match = Object.entries(env).find(
    ([candidate]) => candidate.toLowerCase() === normalizedKey,
  );
  return match?.[1];
}

function setCaseInsensitiveEnvEntry(
  entries: Map<string, { key: string; value: string }>,
  key: string,
  value: string | undefined,
): void {
  if (!key || key.includes("=") || value === undefined) {
    return;
  }
  entries.set(key.toLowerCase(), { key, value });
}

function normalizeWindowsProcessEnvRecord(
  callerEnv: Record<string, string>,
  hostEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  const entries = new Map<string, { key: string; value: string }>();
  for (const key of WINDOWS_PROCESS_ENV_DEFAULT_KEYS) {
    setCaseInsensitiveEnvEntry(entries, key, getEnvValueCaseInsensitive(hostEnv, key));
  }
  for (const [key, value] of Object.entries(callerEnv)) {
    setCaseInsensitiveEnvEntry(entries, key, value);
  }
  return [...entries.values()]
    .toSorted((a, b) => a.key.localeCompare(b.key))
    .map(({ key, value }) => `${key}=${value}`);
}

type BaselineApplicationContext = {
  platform: SandboxBaselinePlatform;
  homeDir: string;
  projectDir: string;
  tempEnv: BaselineTempEnv;
};

function resolveCurrentBaselineContext(
  projectDir: string,
  platform: NodeJS.Platform,
): BaselineApplicationContext {
  return {
    platform: toSandboxBaselinePlatform(platform),
    homeDir: homedir(),
    projectDir,
    tempEnv: {
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      TMPDIR: process.env.TMPDIR,
    },
  };
}

function toSandboxBaselinePlatform(platform: NodeJS.Platform): SandboxBaselinePlatform {
  switch (platform) {
    case "win32":
    case "darwin":
    case "linux":
    case "freebsd":
    case "openbsd":
    case "aix":
    case "sunos":
      return platform;
    default:
      return "linux";
  }
}

function applySandboxBaselineToConfig(
  config: MxcContainerConfig,
  baseline: SandboxBaselinePolicy,
  context: BaselineApplicationContext,
): MxcContainerConfig {
  const filesystem = config.filesystem;
  const readwritePaths = [...(filesystem.readwritePaths ?? [])];
  if (baseline.filesystem.restrictToProjectDir) {
    readwritePaths.push(
      ...computeEffectiveReadwritePaths({
        platform: context.platform,
        projectDir: context.projectDir,
        tempEnv: context.tempEnv,
        additionalReadwritePaths: baseline.filesystem.additionalReadwritePaths,
      }),
    );
  }

  config.filesystem = {
    ...filesystem,
    deniedPaths: dedupeStable([
      ...(filesystem.deniedPaths ?? []),
      ...computeEffectiveDeniedPaths(baseline.filesystem, {
        platform: context.platform,
        homeDir: context.homeDir,
      }),
    ]),
    readonlyPaths: dedupeStable([
      ...(filesystem.readonlyPaths ?? []),
      ...computeEffectiveReadonlyPaths(baseline.filesystem, context.platform),
    ]),
    readwritePaths: dedupeStable(readwritePaths),
    clearPolicyOnExit: filesystem.clearPolicyOnExit ?? true,
  };

  const network = config.network;
  config.network = {
    ...network,
    blockedHosts: dedupeStable([
      ...(network.blockedHosts ?? []),
      ...computeEffectiveBlockedHosts(baseline.network, network.allowedHosts ?? []),
    ]),
  };

  return config;
}

function isWindowsProcessContainment(
  containment: MxcConfig["containment"],
  platform: NodeJS.Platform,
): boolean {
  return platform === "win32" && (containment === "process" || containment === "processcontainer");
}

function assertSupportedContainmentForPlatform(
  containment: MxcConfig["containment"],
  platform: NodeJS.Platform,
): void {
  if (containment === "process") {
    return;
  }
  if (containment === "processcontainer" && platform === "win32") {
    return;
  }
  if (containment === "processcontainer") {
    throw new Error(
      `MXC containment "processcontainer" is Windows-only. Use "process" so MXC resolves to the platform process sandbox.`,
    );
  }
  throw new Error(
    `MXC containment "${containment}" is not enabled by the OpenClaw MXC plugin. Use "process" so MXC resolves to the platform process sandbox.`,
  );
}

function normalizeNetworkPolicyForContainment(params: {
  config: MxcContainerConfig;
  containment: MxcConfig["containment"];
  platform: NodeJS.Platform;
}): void {
  const network = params.config.network;
  delete network.enforcementMode;
  const hasAllowedHosts = (network.allowedHosts?.length ?? 0) > 0;
  const hasBlockedHosts = (network.blockedHosts?.length ?? 0) > 0;
  const hasHostRules = hasAllowedHosts || hasBlockedHosts;

  if (isWindowsProcessContainment(params.containment, params.platform)) {
    network.enforcementMode = hasHostRules ? "both" : "capabilities";
  }
}

function resolveProcessTimeoutSeconds(config: MxcConfig, baseline: SandboxBaselinePolicy): number {
  if (config.timeoutSecondsConfigured === true) {
    return config.timeoutSeconds;
  }
  return baseline.process.timeoutSeconds;
}

function dedupeStable(values: readonly string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    deduped.push(value);
  }
  return deduped;
}

// Windows ProcessContainer normally applies filesystem policy through
// BaseContainer, but wxc-exec can fall back to host DACL mutation. Filter
// entries that cannot exist on the host before the fallback path runs:
// - Non-existent paths fail the fallback with os error 2.
// - Existing directories are valid deny targets and must not be probed with
//   openSync(), which rejects directories on Windows before MXC can enforce
//   the deny policy.
function filterMissingWindowsProcessFilesystemEntries(
  filesystem: MxcContainerConfig["filesystem"],
): MxcContainerConfig["filesystem"] {
  const keepExisting = (values: readonly string[] | undefined): string[] | undefined => {
    if (!values) {
      return values;
    }
    return values.filter((value) => existsSync(value));
  };
  const keepDeniable = (values: readonly string[] | undefined): string[] | undefined => {
    if (!values) {
      return values;
    }
    return values.filter((value) => {
      if (!existsSync(value)) {
        return false;
      }
      try {
        const stat = statSync(value);
        if (stat.isDirectory()) {
          return true;
        }
        const fd = openSync(value, "r");
        closeSync(fd);
        return true;
      } catch {
        return false;
      }
    });
  };
  return {
    ...filesystem,
    readwritePaths: keepExisting(filesystem.readwritePaths),
    readonlyPaths: keepExisting(filesystem.readonlyPaths),
    deniedPaths: keepDeniable(filesystem.deniedPaths),
  };
}

function buildContainerConfig(params: {
  config: MxcConfig;
  baseline: SandboxBaselinePolicy;
  baselineContext: BaselineApplicationContext;
  runtimeId: string;
  command: string;
  args?: readonly string[];
  workdir: string;
  env: Record<string, string>;
  platform: NodeJS.Platform;
  stdinFile?: string;
}): MxcContainerConfig {
  const { config, baseline, baselineContext, runtimeId, command, args, workdir, env, platform } =
    params;
  assertSupportedContainmentForPlatform(config.containment, platform);
  const networkAllowed = config.network === "default";

  const readwritePaths = [path.resolve(workdir)];
  if (config.readwritePaths) {
    for (const p of config.readwritePaths) {
      const resolved = path.resolve(p);
      if (!readwritePaths.includes(resolved)) {
        readwritePaths.push(resolved);
      }
    }
  }

  const commandScript = buildCommandScript(command, workdir, platform, params.stdinFile);

  // Both platforms inline the script into commandLine; see buildCommandLine
  // for why neither MXC runner propagates process.env to the child.
  //
  // On Windows, MXC's BaseContainerRunner treats a non-empty process.env as a
  // replacement environment block for CreateProcessInSandbox. Include only the
  // minimal OS defaults needed by cmd/CreateProcess plus caller overrides so
  // explicit env vars work without leaking the full host environment.
  const processEnv = isWindowsProcessContainment(config.containment, platform)
    ? normalizeWindowsProcessEnvRecord(env)
    : normalizeEnvRecord(env);

  const mxcConfig: MxcContainerConfig = {
    version: MXC_SCHEMA_VERSION,
    containerId: uniqueContainerId(runtimeId),
    containment: config.containment,
    lifecycle: { destroyOnExit: true },
    process: {
      commandLine: buildCommandLine(commandScript, args ?? [], platform),
      cwd: resolveProcessCwd(workdir),
      env: processEnv,
      timeout: resolveProcessTimeoutSeconds(config, baseline) * 1000,
    },
    filesystem: { readwritePaths },
    network: {
      defaultPolicy: networkAllowed ? "allow" : "block",
    },
  };

  if (isWindowsProcessContainment(config.containment, platform)) {
    mxcConfig.processContainer = {
      name: processContainerName(runtimeId),
      leastPrivilege: true,
      capabilities: networkAllowed ? ["internetClient"] : [],
      ui: {
        isolation: "container",
        desktopSystemControl: false,
        systemSettings: "none",
        ime: false,
      },
    };
  }

  const merged = applySandboxBaselineToConfig(mxcConfig, baseline, baselineContext);
  normalizeNetworkPolicyForContainment({
    config: merged,
    containment: config.containment,
    platform,
  });
  if (isWindowsProcessContainment(config.containment, platform)) {
    merged.filesystem = filterMissingWindowsProcessFilesystemEntries(merged.filesystem);
  }
  return merged;
}

function buildMxcArgv(config: MxcConfig, payload: MxcContainerConfig): string[] {
  const binaryPath = resolveMxcBinaryPath(config.mxcBinaryPath);
  const argv = [binaryPath, "--config-base64", configToBase64(payload)];
  if (config.debug) {
    argv.push("--debug");
  }
  return argv;
}

/**
 * Creates a SandboxBackendHandle for a specific session.
 */
export function createMxcSandboxBackendHandle(params: {
  config: MxcConfig;
  runtimeId: string;
  workdir: string;
  platform?: NodeJS.Platform;
  sandboxPolicy?: Omit<SandboxPolicyLoaderOptions, "homeDir" | "platform">;
}): SandboxBackendHandle {
  const platform = params.platform ?? process.platform;
  const baselineContext = resolveCurrentBaselineContext(path.resolve(params.workdir), platform);
  const baseline = loadSandboxBaselinePolicy({
    platform,
    homeDir: baselineContext.homeDir,
    ...params.sandboxPolicy,
  });

  return {
    id: "mxc",
    runtimeId: params.runtimeId,
    runtimeLabel: params.runtimeId,
    workdir: params.workdir,

    async buildExecSpec({ command, workdir, env, usePty }): Promise<SandboxBackendExecSpec> {
      const effectiveWorkdir = resolveWorkdirInsideWorkspace(
        params.workdir,
        workdir ?? params.workdir,
      );
      const payload = buildContainerConfig({
        config: params.config,
        baseline,
        baselineContext,
        runtimeId: params.runtimeId,
        command,
        workdir: effectiveWorkdir,
        env,
        platform,
      });

      // Spawn via a plugin-side Node launcher that calls
      // `@microsoft/mxc-sdk`'s `spawnSandboxFromConfig` directly. The SDK
      // owns the PTY allocation, so the launcher process appears as a plain
      // child to the host runtime. AppContainer on Windows needs ConPTY for
      // stdio inheritance; routing through the launcher keeps that detail
      // inside the plugin instead of forcing the host to promote argv into
      // a shell-quoted PTY command line.
      const launcherPath = resolveMxcLauncherPath();
      const launcherOptions: { debug: boolean; executablePath?: string } = {
        debug: params.config.debug ?? false,
        executablePath: resolveMxcBinaryPath(params.config.mxcBinaryPath),
      };
      if (!usePty) {
        (launcherOptions as { usePty?: boolean }).usePty = false;
      }
      const payloadJson = JSON.stringify({
        config: payload,
        options: launcherOptions,
      });
      const payloadFile = createLauncherPayloadFile(payloadJson);

      return {
        argv: [process.execPath, launcherPath, "--payload-file", payloadFile.payloadFile],
        env: buildLauncherEnv(),
        stdinMode: usePty ? "pipe-open" : "pipe-closed",
        finalizeToken: payloadFile satisfies MxcExecFinalizeToken,
      };
    },

    async finalizeExec({ token }) {
      cleanupLauncherPayloadFile(token);
    },

    async runShellCommand(
      cmdParams: SandboxBackendCommandParams,
    ): Promise<SandboxBackendCommandResult> {
      // Shell commands use a restrictive policy (no network, 30s timeout)
      const restrictiveConfig: MxcConfig = {
        ...params.config,
        network: "none",
        timeoutSeconds: 30,
        timeoutSecondsConfigured: true,
      };
      const effectiveWorkdir = path.resolve(params.workdir);
      const commandBridge = createWindowsCommandBridge({
        args: cmdParams.args,
        platform,
        script: cmdParams.script,
        workdir: effectiveWorkdir,
      });
      const execInput = cmdParams.stdin === undefined ? Buffer.alloc(0) : toBuffer(cmdParams.stdin);

      try {
        const payload = buildContainerConfig({
          config: restrictiveConfig,
          baseline,
          baselineContext,
          runtimeId: params.runtimeId,
          command: commandBridge.command,
          args: cmdParams.args,
          workdir: effectiveWorkdir,
          env: {},
          platform,
        });

        const argv = buildMxcArgv(restrictiveConfig, payload);
        const [binaryPath, ...args] = argv;
        try {
          return await execFileBuffered(binaryPath, args, {
            input: execInput,
            timeout: 30_000,
            maxBuffer: 10 * 1024 * 1024,
            signal: cmdParams.signal,
          });
        } catch (err: unknown) {
          if (isAbortError(err)) {
            throw err;
          }
          const execErr = err as {
            stdout?: Buffer | string;
            stderr?: Buffer | string;
            status?: number;
            code?: number;
          };
          if (cmdParams.allowFailure) {
            return {
              stdout: toOptionalBuffer(execErr.stdout),
              stderr: toOptionalBuffer(execErr.stderr),
              code: execErr.status ?? execErr.code ?? 1,
            };
          }
          throw err;
        }
      } finally {
        commandBridge.cleanup();
      }
    },
  };
}

function execFileBuffered(
  binaryPath: string,
  args: readonly string[],
  options: {
    input: Buffer;
    timeout: number;
    maxBuffer: number;
    signal?: AbortSignal;
  },
): Promise<SandboxBackendCommandResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binaryPath,
      [...args],
      {
        encoding: "buffer",
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        const stdoutBuffer = toOptionalBuffer(stdout);
        const stderrBuffer = toOptionalBuffer(stderr);
        if (error) {
          const errorStatus = (error as { status?: unknown }).status;
          const status =
            typeof error.code === "number"
              ? error.code
              : typeof errorStatus === "number"
                ? errorStatus
                : 1;
          const rejection: Error = Object.assign(error, {
            stdout: stdoutBuffer,
            stderr: stderrBuffer,
            status,
          });
          reject(rejection);
          return;
        }
        resolve({ stdout: stdoutBuffer, stderr: stderrBuffer, code: 0 });
      },
    );
    child.stdin?.end(options.input);
  });
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" ||
      ("code" in err && (err as { code?: unknown }).code === "ABORT_ERR"))
  );
}

function toOptionalBuffer(value: Buffer | string | undefined): Buffer {
  if (value === undefined) {
    return Buffer.alloc(0);
  }
  return toBuffer(value);
}

function toBuffer(value: Buffer | string): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  return Buffer.from(value, "utf-8");
}

/** Factory function called by OpenClaw when sandbox.backend=mxc. */
export function createMxcSandboxBackendFactory(config: MxcConfig) {
  return async function createMxcSandboxBackend(
    params: CreateSandboxBackendParams,
  ): Promise<SandboxBackendHandle> {
    const runtimeId = sanitizeRuntimeId(params.scopeKey);
    return createMxcSandboxBackendHandle({
      config,
      runtimeId,
      workdir: params.workspaceDir,
    });
  };
}

/** Manager for `openclaw sandbox list` and `openclaw sandbox remove`. */
export const mxcSandboxBackendManager: SandboxBackendManager = {
  async describeRuntime() {
    return {
      running: true,
      actualConfigLabel: "mxc-process",
      configLabelMatch: true,
    };
  },
  async removeRuntime() {
    // MXC containers are ephemeral and destroyed on exit automatically.
  },
};
