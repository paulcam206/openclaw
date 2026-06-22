import { execFileSync } from "node:child_process";
import * as os from "node:os";
import path from "node:path";

export const MIN_SUPPORTED_BUILD = 26100;
export const UBR_CHECK_MAX_BUILD = 26500;
export const MIN_SUPPORTED_UBR_IN_RANGE = 7965;

const CURRENT_VERSION_REGISTRY_KEY = "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";
const REGISTRY_QUERY_TIMEOUT_MS = 1500;
const REGISTRY_QUERY_MAX_BUFFER_BYTES = 64 * 1024;

export type WindowsBuildSource = "os-release" | "registry-build-lab-ex" | "registry-current-build";
export type WindowsUbrSource = "registry-ubr";

export type WindowsVersionInfo = {
  build?: number;
  buildSource?: WindowsBuildSource;
  ubr?: number;
  ubrSource?: WindowsUbrSource;
};

export type WindowsBuildUnsupportedReason =
  | "build-too-old"
  | "missing-build"
  | "missing-ubr"
  | "ubr-too-old";

export type WindowsBuildSupportDecision =
  | {
      supported: true;
      build: number;
      buildSource: WindowsBuildSource;
      ubr?: number;
      ubrSource?: WindowsUbrSource;
      requirement: "build-and-ubr" | "build-only";
    }
  | {
      supported: false;
      reason: WindowsBuildUnsupportedReason;
      build?: number;
      buildSource?: WindowsBuildSource;
      ubr?: number;
      ubrSource?: WindowsUbrSource;
      requirement: "build-and-ubr" | "build-only";
    };

export type UnsupportedWindowsBuildSupportDecision = Extract<
  WindowsBuildSupportDecision,
  { supported: false }
>;

type WindowsRegistryVersionInfo = {
  currentBuildNumber?: number;
  buildLabExBuild?: number;
  ubr?: number;
};

function parseDecimalInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) {
    return undefined;
  }

  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseRegistryInteger(value: string): number | undefined {
  const trimmed = value.trim();
  const hexMatch = /^0x([0-9a-f]+)\b/iu.exec(trimmed);
  if (hexMatch) {
    const parsed = Number.parseInt(hexMatch[1] ?? "", 16);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }

  return parseDecimalInteger(trimmed);
}

export function parseBuildLabExBuild(value: string): number | undefined {
  const match = /^\s*(\d+)(?:\.|$)/u.exec(value);
  return match?.[1] ? parseDecimalInteger(match[1]) : undefined;
}

export function parseWindowsOsReleaseBuild(value: string): number | undefined {
  const match = /^\s*\d+\.\d+\.(\d+)(?:\.|$)/u.exec(value);
  return match?.[1] ? parseDecimalInteger(match[1]) : undefined;
}

export function parseWindowsRegistryVersionInfo(output: string): WindowsRegistryVersionInfo {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(\S+)\s+REG_\S+\s+(.+?)\s*$/u.exec(line);
    if (match?.[1] && match[2]) {
      values.set(match[1].toLowerCase(), match[2]);
    }
  }

  const currentBuildNumber = values.get("currentbuildnumber");
  const buildLabEx = values.get("buildlabex");
  const ubr = values.get("ubr");

  return {
    currentBuildNumber:
      currentBuildNumber !== undefined ? parseDecimalInteger(currentBuildNumber) : undefined,
    buildLabExBuild: buildLabEx !== undefined ? parseBuildLabExBuild(buildLabEx) : undefined,
    ubr: ubr !== undefined ? parseRegistryInteger(ubr) : undefined,
  };
}

function readCurrentVersionRegistry(): string | undefined {
  try {
    return execFileSync(
      resolveWindowsSystemExecutable("reg.exe"),
      ["query", CURRENT_VERSION_REGISTRY_KEY],
      {
        encoding: "utf8",
        maxBuffer: REGISTRY_QUERY_MAX_BUFFER_BYTES,
        timeout: REGISTRY_QUERY_TIMEOUT_MS,
        windowsHide: true,
      },
    );
  } catch {
    return undefined;
  }
}

export function resolveWindowsSystemExecutable(executable: string): string {
  const systemRoot = process.env.SystemRoot?.trim() || "C:\\Windows";
  return path.win32.join(systemRoot, "System32", executable);
}

export function readWindowsVersionInfo(): WindowsVersionInfo {
  const registryOutput = readCurrentVersionRegistry();
  const registryInfo =
    registryOutput !== undefined ? parseWindowsRegistryVersionInfo(registryOutput) : undefined;

  if (registryInfo?.currentBuildNumber !== undefined) {
    return {
      build: registryInfo.currentBuildNumber,
      buildSource: "registry-current-build",
      ubr: registryInfo.ubr,
      ubrSource: registryInfo.ubr !== undefined ? "registry-ubr" : undefined,
    };
  }

  if (registryInfo?.buildLabExBuild !== undefined) {
    return {
      build: registryInfo.buildLabExBuild,
      buildSource: "registry-build-lab-ex",
      ubr: registryInfo.ubr,
      ubrSource: registryInfo.ubr !== undefined ? "registry-ubr" : undefined,
    };
  }

  const osReleaseBuild = parseWindowsOsReleaseBuild(os.release());
  return {
    build: osReleaseBuild,
    buildSource: osReleaseBuild !== undefined ? "os-release" : undefined,
    ubr: registryInfo?.ubr,
    ubrSource: registryInfo?.ubr !== undefined ? "registry-ubr" : undefined,
  };
}

export function evaluateWindowsBuildSupport(
  version: WindowsVersionInfo,
): WindowsBuildSupportDecision {
  const { build, buildSource, ubr, ubrSource } = version;
  if (build === undefined || buildSource === undefined) {
    return {
      supported: false,
      reason: "missing-build",
      requirement: "build-only",
      ubr,
      ubrSource,
    };
  }

  if (build < MIN_SUPPORTED_BUILD) {
    return {
      supported: false,
      reason: "build-too-old",
      requirement: "build-only",
      build,
      buildSource,
      ubr,
      ubrSource,
    };
  }

  if (build >= UBR_CHECK_MAX_BUILD) {
    return {
      supported: true,
      requirement: "build-only",
      build,
      buildSource,
      ubr,
      ubrSource,
    };
  }

  if (ubr === undefined) {
    return {
      supported: false,
      reason: "missing-ubr",
      requirement: "build-and-ubr",
      build,
      buildSource,
    };
  }

  if (ubr < MIN_SUPPORTED_UBR_IN_RANGE) {
    return {
      supported: false,
      reason: "ubr-too-old",
      requirement: "build-and-ubr",
      build,
      buildSource,
      ubr,
      ubrSource,
    };
  }

  return {
    supported: true,
    requirement: "build-and-ubr",
    build,
    buildSource,
    ubr,
    ubrSource,
  };
}

export function getWindowsBuildSupportDecision(): WindowsBuildSupportDecision {
  return evaluateWindowsBuildSupport(readWindowsVersionInfo());
}

function formatBuildRangeRequirement(): string {
  return `Windows build ${MIN_SUPPORTED_BUILD}+ and UBR ${MIN_SUPPORTED_UBR_IN_RANGE}+ for builds below ${UBR_CHECK_MAX_BUILD}`;
}

export function formatWindowsBuildSupportWarning(
  decision: UnsupportedWindowsBuildSupportDecision,
): string {
  if (decision.reason === "missing-build") {
    return `[mxc] Windows build could not be determined. MXC requires ${formatBuildRangeRequirement()}. Plugin will be dormant.`;
  }

  if (decision.reason === "build-too-old") {
    return `[mxc] Windows build ${decision.build} is not supported. MXC requires ${formatBuildRangeRequirement()}. Plugin will be dormant.`;
  }

  if (decision.reason === "missing-ubr") {
    return `[mxc] Windows UBR could not be determined for build ${decision.build}. MXC requires UBR ${MIN_SUPPORTED_UBR_IN_RANGE}+ for Windows builds ${MIN_SUPPORTED_BUILD}-${UBR_CHECK_MAX_BUILD - 1}. Plugin will be dormant.`;
  }

  return `[mxc] Windows build ${decision.build}.${decision.ubr} is not supported. MXC requires UBR ${MIN_SUPPORTED_UBR_IN_RANGE}+ for Windows builds ${MIN_SUPPORTED_BUILD}-${UBR_CHECK_MAX_BUILD - 1}. Plugin will be dormant.`;
}
