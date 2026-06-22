export type MxcContainment =
  | "process"
  | "processcontainer"
  | "windows_sandbox"
  | "wslc"
  | "microvm"
  | "seatbelt"
  | "isolation_session";

export type MxcNetworkMode = "none" | "default";

const CONTAINMENTS = new Set<MxcContainment>([
  "process",
  "processcontainer",
  "windows_sandbox",
  "wslc",
  "microvm",
  "seatbelt",
  "isolation_session",
]);

export type MxcConfig = {
  mxcBinaryPath?: string;
  containment: MxcContainment;
  network: MxcNetworkMode;
  timeoutSeconds: number;
  timeoutSecondsConfigured?: boolean;
  debug: boolean;
  readwritePaths?: string[];
};

const DEFAULT_CONTAINMENT: MxcContainment = "process";
const DEFAULT_NETWORK: MxcNetworkMode = "none";
const DEFAULT_TIMEOUT_SECONDS = 120;

export function resolveConfig(raw: unknown): MxcConfig {
  if (raw == null || typeof raw !== "object") {
    return {
      containment: DEFAULT_CONTAINMENT,
      network: DEFAULT_NETWORK,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      debug: false,
    };
  }
  const input = raw as Record<string, unknown>;
  const containment = resolveContainment(input);

  const network =
    input.network === "none" || input.network === "default"
      ? (input.network as MxcNetworkMode)
      : DEFAULT_NETWORK;

  const inputTimeoutSeconds = input.timeoutSeconds;
  let timeoutSecondsConfigured = false;
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  if (
    typeof inputTimeoutSeconds === "number" &&
    Number.isFinite(inputTimeoutSeconds) &&
    inputTimeoutSeconds >= 1
  ) {
    timeoutSecondsConfigured = true;
    timeoutSeconds = inputTimeoutSeconds;
  }

  const resolved: MxcConfig = {
    mxcBinaryPath:
      typeof input.mxcBinaryPath === "string" && input.mxcBinaryPath.trim().length > 0
        ? input.mxcBinaryPath.trim()
        : undefined,
    containment,
    network,
    timeoutSeconds,
    debug: input.debug === true,
    readwritePaths: Array.isArray(input.readwritePaths)
      ? input.readwritePaths.filter((p: unknown) => typeof p === "string")
      : undefined,
  };

  if (timeoutSecondsConfigured) {
    resolved.timeoutSecondsConfigured = true;
  }

  return resolved;
}

function resolveContainment(input: Record<string, unknown>): MxcContainment {
  if (input.containment === "lxc") {
    console.warn(
      `[mxc] containment "lxc" is not ready in the OpenClaw MXC plugin; using "process" instead.`,
    );
    return DEFAULT_CONTAINMENT;
  }
  const legacyLxcKeys = ["lxcDistribution", "lxcRelease"].filter((key) => key in input);
  if (legacyLxcKeys.length > 0) {
    console.warn(
      `[mxc] ignoring unsupported LXC configuration key(s): ${legacyLxcKeys.join(
        ", ",
      )}. LXC is not ready in the OpenClaw MXC plugin.`,
    );
  }
  return typeof input.containment === "string" &&
    CONTAINMENTS.has(input.containment as MxcContainment)
    ? (input.containment as MxcContainment)
    : DEFAULT_CONTAINMENT;
}
