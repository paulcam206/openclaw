import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * Deterministic MXC sandbox baseline policy helpers.
 *
 * These helpers only derive policy data owned by this plugin. Config loading and
 * untyped file parsing stay with the caller.
 */

export type SandboxBaselinePlatform =
  | "win32"
  | "darwin"
  | "linux"
  | "freebsd"
  | "openbsd"
  | "aix"
  | "sunos";

export const BASELINE_DENIED_CIDRS: readonly string[] = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
  "::/128",
  "::1/128",
  "::ffff:0:0/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001:0000::/32",
  "2001:2::/48",
  "2001:20::/28",
  "2001:db8::/32",
  "2002::/16",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
];

export const BASELINE_DENIED_HOSTS: readonly string[] = [
  "100.100.100.200",
  "169.254.169.254",
  "169.254.170.2",
  "169.254.170.23",
  "isatap",
  "kube-dns.kube-system.svc.cluster.local",
  "kubernetes.default",
  "kubernetes.default.svc",
  "kubernetes.default.svc.cluster.local",
  "localhost",
  "localhost.localdomain",
  "metadata.azure.com",
  "metadata.google.internal",
  "metadata.goog",
  "metadata.packet.net",
  "wpad",
];

export const BASELINE_DENIED_HOST_SUFFIXES: readonly string[] = [
  ".corp",
  ".home.arpa",
  ".internal",
  ".intranet",
  ".lan",
  ".local",
  ".localhost",
  ".private",
];

export const BASELINE_DENIED_PATHS_UNIX: readonly string[] = [
  "~/.aws",
  "~/.azure",
  "~/.config/gcloud",
  "~/.config/gh",
  "~/.config/google-chrome",
  "~/.config/chromium",
  "~/.docker/config.json",
  "~/.git-credentials",
  "~/.gnupg",
  "~/.kube",
  "~/.mozilla/firefox",
  "~/.netrc",
  "~/.npmrc",
  "~/.openclaw/agents/*/agent/auth-profiles.json",
  "~/.openclaw/credentials",
  "~/.pypirc",
  "~/.ssh",
  "~/Library/Application Support/Firefox",
  "~/Library/Application Support/Google/Chrome",
  "/etc/gshadow",
  "/etc/shadow",
  "/etc/sudoers",
  "/etc/sudoers.d",
];

export const BASELINE_DENIED_PATHS_WINDOWS: readonly string[] = [
  "~\\.aws",
  "~\\.azure",
  "~\\.config\\gcloud",
  "~\\.config\\gh",
  "~\\.docker\\config.json",
  "~\\.git-credentials",
  "~\\.gnupg",
  "~\\.kube",
  "~\\.netrc",
  "~\\.npmrc",
  "~\\.openclaw\\agents\\*\\agent\\auth-profiles.json",
  "~\\.openclaw\\credentials",
  "~\\.pypirc",
  "~\\.ssh",
  "~\\AppData\\Local\\Google\\Chrome\\User Data",
  "~\\AppData\\Local\\Microsoft\\Edge\\User Data",
  "~\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles",
  "C:\\Windows\\System32\\config",
  "C:\\Windows\\System32\\config\\SAM",
];

export const BASELINE_READONLY_PATHS_UNIX: readonly string[] = [
  "/bin",
  "/lib",
  "/lib64",
  "/opt/homebrew/bin",
  "/opt/homebrew/lib",
  "/usr/bin",
  "/usr/lib",
  "/usr/local/bin",
  "/usr/local/lib",
];

export const BASELINE_READONLY_PATHS_WINDOWS: readonly string[] = [
  "C:\\Program Files",
  "C:\\Program Files (x86)",
  "C:\\Windows\\System32",
  "C:\\Windows\\SysWOW64",
];

export const BASELINE_TIMEOUT_SECONDS = 300;

export type BaselineNetworkPolicy = {
  denyPrivateNetworks: boolean;
  denyCloudMetadata: boolean;
  additionalDeniedHosts: readonly string[];
  additionalDeniedCidrs: readonly string[];
};

export type BaselineNetworkPolicyInput = {
  denyPrivateNetworks?: boolean;
  denyCloudMetadata?: boolean;
  additionalDeniedHosts?: readonly string[];
  additionalDeniedCidrs?: readonly string[];
};

export type BaselineFilesystemPolicy = {
  denyCredentialStores: boolean;
  restrictToProjectDir: boolean;
  additionalDeniedPaths: readonly string[];
  additionalReadonlyPaths: readonly string[];
  additionalReadwritePaths: readonly string[];
};

export type BaselineFilesystemPolicyInput = {
  denyCredentialStores?: boolean;
  restrictToProjectDir?: boolean;
  additionalDeniedPaths?: readonly string[];
  additionalReadonlyPaths?: readonly string[];
  additionalReadwritePaths?: readonly string[];
};

export type SandboxBaselinePolicy = {
  network: BaselineNetworkPolicy;
  filesystem: BaselineFilesystemPolicy;
  process: {
    timeoutSeconds: number;
    timeoutSecondsConfigured: boolean;
  };
};

export type SandboxBaselinePolicyInput = {
  network?: BaselineNetworkPolicyInput;
  filesystem?: BaselineFilesystemPolicyInput;
  process?: {
    timeoutSeconds?: number;
  };
};

export type EffectiveReadwritePathsInput = {
  platform: SandboxBaselinePlatform;
  projectDir: string;
  tempEnv?: BaselineTempEnv;
  additionalReadwritePaths?: readonly string[];
};

export type EffectiveDeniedFilesystemPathsInput = {
  platform: SandboxBaselinePlatform;
  homeDir: string;
};

export type BaselineTempEnv = {
  TEMP?: string;
  TMP?: string;
  TMPDIR?: string;
};

export const DEFAULT_BASELINE_NETWORK_POLICY: BaselineNetworkPolicy = {
  denyPrivateNetworks: true,
  denyCloudMetadata: true,
  additionalDeniedHosts: [],
  additionalDeniedCidrs: [],
};

export const DEFAULT_SANDBOX_BASELINE: SandboxBaselinePolicy = {
  network: DEFAULT_BASELINE_NETWORK_POLICY,
  filesystem: {
    denyCredentialStores: true,
    restrictToProjectDir: true,
    additionalDeniedPaths: [],
    additionalReadonlyPaths: [],
    additionalReadwritePaths: [],
  },
  process: {
    timeoutSeconds: BASELINE_TIMEOUT_SECONDS,
    timeoutSecondsConfigured: false,
  },
};

export const NEVER_PUNCHABLE_NETWORK_ENTRIES: readonly string[] = [
  ...BASELINE_DENIED_CIDRS,
  ...BASELINE_DENIED_HOSTS,
  ...BASELINE_DENIED_HOST_SUFFIXES.map((suffix) => `*${suffix}`),
];

const NEVER_PUNCHABLE_NETWORK_ENTRY_SET = new Set(
  normalizeNetworkEntries(NEVER_PUNCHABLE_NETWORK_ENTRIES),
);

export function resolveBaselineNetworkPolicy(
  input: BaselineNetworkPolicyInput = {},
): BaselineNetworkPolicy {
  return {
    denyPrivateNetworks: input.denyPrivateNetworks ?? true,
    denyCloudMetadata: input.denyCloudMetadata ?? true,
    additionalDeniedHosts: [...(input.additionalDeniedHosts ?? [])],
    additionalDeniedCidrs: [...(input.additionalDeniedCidrs ?? [])],
  };
}

export function resolveSandboxBaseline(
  input: SandboxBaselinePolicyInput = {},
): SandboxBaselinePolicy {
  const timeoutSecondsConfigured = input.process?.timeoutSeconds !== undefined;
  const timeoutSeconds = input.process?.timeoutSeconds ?? BASELINE_TIMEOUT_SECONDS;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1) {
    throw new RangeError("Sandbox baseline timeoutSeconds must be at least 1.");
  }

  return {
    network: resolveBaselineNetworkPolicy(input.network),
    filesystem: {
      denyCredentialStores: input.filesystem?.denyCredentialStores ?? true,
      restrictToProjectDir: input.filesystem?.restrictToProjectDir ?? true,
      additionalDeniedPaths: [...(input.filesystem?.additionalDeniedPaths ?? [])],
      additionalReadonlyPaths: [...(input.filesystem?.additionalReadonlyPaths ?? [])],
      additionalReadwritePaths: [...(input.filesystem?.additionalReadwritePaths ?? [])],
    },
    process: { timeoutSeconds, timeoutSecondsConfigured },
  };
}

export function computeEffectiveBlockedHosts(
  baseline: BaselineNetworkPolicy,
  allowedHosts: readonly string[] = [],
): string[] {
  const blockedEntries: string[] = [];

  if (baseline.denyPrivateNetworks) {
    blockedEntries.push(...BASELINE_DENIED_CIDRS);
  }

  if (baseline.denyCloudMetadata) {
    blockedEntries.push(...BASELINE_DENIED_HOSTS);
    blockedEntries.push(...BASELINE_DENIED_HOST_SUFFIXES.map((suffix) => `*${suffix}`));
  }

  blockedEntries.push(...baseline.additionalDeniedHosts);
  blockedEntries.push(...baseline.additionalDeniedCidrs);

  const allowlist = new Set(normalizeNetworkEntries(allowedHosts));
  const effective = normalizeNetworkEntries(blockedEntries).filter((entry) => {
    if (NEVER_PUNCHABLE_NETWORK_ENTRY_SET.has(entry)) {
      return true;
    }
    return !allowlist.has(entry);
  });

  return dedupeSorted(effective);
}

export function computeEffectiveDeniedFilesystemPaths(
  baseline: BaselineFilesystemPolicy,
  input: EffectiveDeniedFilesystemPathsInput,
): string[] {
  const deniedPathTemplates = baseline.denyCredentialStores
    ? baselineDeniedPathsForPlatform(input.platform)
    : [];
  const deniedPaths = deniedPathTemplates.flatMap((template) =>
    expandDeniedPathTemplate(template, input.homeDir, input.platform),
  );

  deniedPaths.push(...baseline.additionalDeniedPaths);
  return dedupeStable(deniedPaths);
}

export function computeEffectiveDeniedPaths(
  baseline: BaselineFilesystemPolicy,
  input: EffectiveDeniedFilesystemPathsInput,
): string[] {
  return computeEffectiveDeniedFilesystemPaths(baseline, input);
}

export function computeEffectiveReadonlyPaths(
  baseline: BaselineFilesystemPolicy,
  platform: SandboxBaselinePlatform,
): string[] {
  const platformPaths =
    platform === "win32" ? BASELINE_READONLY_PATHS_WINDOWS : BASELINE_READONLY_PATHS_UNIX;
  return dedupeStable([...platformPaths, ...baseline.additionalReadonlyPaths]);
}

export function computeEffectiveReadwritePaths(input: EffectiveReadwritePathsInput): string[] {
  const tempDir = resolveTempDir(input.platform, input.tempEnv);
  return dedupeStable([input.projectDir, tempDir, ...(input.additionalReadwritePaths ?? [])]);
}

function baselineDeniedPathsForPlatform(platform: SandboxBaselinePlatform): readonly string[] {
  return platform === "win32" ? BASELINE_DENIED_PATHS_WINDOWS : BASELINE_DENIED_PATHS_UNIX;
}

function expandDeniedPathTemplate(
  value: string,
  homeDir: string,
  platform: SandboxBaselinePlatform,
): string[] {
  const expanded = expandHomePath(value, homeDir);
  if (!isOpenClawAuthProfileWildcard(expanded)) {
    return [expanded];
  }
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const agentsDir = pathApi.join(trimTrailingPathSeparator(homeDir), ".openclaw", "agents");
  try {
    return readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => pathApi.join(agentsDir, entry.name, "agent", "auth-profiles.json"));
  } catch {
    return [];
  }
}

function isOpenClawAuthProfileWildcard(value: string): boolean {
  return /[\\/]\.openclaw[\\/]agents[\\/]\*[\\/]agent[\\/]auth-profiles\.json$/u.test(value);
}

function resolveTempDir(platform: SandboxBaselinePlatform, env: BaselineTempEnv = {}): string {
  if (platform === "win32") {
    return env.TEMP ?? env.TMP ?? "C:\\Windows\\Temp";
  }
  return env.TMPDIR ?? env.TMP ?? "/tmp";
}

function expandHomePath(value: string, homeDir: string): string {
  if (value === "~") {
    return homeDir;
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return `${trimTrailingPathSeparator(homeDir)}${value.slice(1)}`;
  }
  return value;
}

function trimTrailingPathSeparator(value: string): string {
  if (value === "/" || value === "\\" || /^[A-Za-z]:[\\/]$/.test(value)) {
    return value;
  }
  return value.replace(/[\\/]+$/u, "");
}

function normalizeNetworkEntries(entries: readonly string[]): string[] {
  return entries.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
}

function dedupeSorted(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted(compareCodePoints);
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
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
