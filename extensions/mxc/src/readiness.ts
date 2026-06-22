import { execFileSync } from "node:child_process";
import type { MxcConfig } from "./config.js";
import { resolveWindowsSystemExecutable } from "./windows-version.js";

type ReadinessDeps = {
  execFileSync: typeof execFileSync;
};

const DEFAULT_DEPS: ReadinessDeps = { execFileSync };

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
      `[mxc] MXC sandbox backend cannot load: containment "processcontainer" is Windows-only. ` +
        `Use containment "process" so MXC resolves to the platform process sandbox.`,
    );
  }
  throw new Error(
    `[mxc] MXC sandbox backend cannot load: containment "${containment}" is not enabled by the OpenClaw MXC plugin. ` +
      `Use containment "process" so MXC resolves to the platform process sandbox.`,
  );
}

function assertWindowsIsoEnvBrokerReady(deps: ReadinessDeps): void {
  let output: string;
  try {
    output = deps.execFileSync(
      resolveWindowsSystemExecutable("sc.exe"),
      ["query", "IsoEnvBroker"],
      {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 5_000,
        windowsHide: true,
      },
    );
  } catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message.trim()}` : "";
    throw new Error(
      `[mxc] MXC Windows ProcessContainer sandbox is not ready: IsoEnvBroker service check failed${detail}. ` +
        `Start the IsoEnvBroker service before enabling MXC sandbox execution.`,
      { cause: error },
    );
  }
  if (!/\bRUNNING\b/u.test(output)) {
    throw new Error(
      `[mxc] MXC Windows ProcessContainer sandbox is not ready: IsoEnvBroker service is not running. ` +
        `Start the IsoEnvBroker service before enabling MXC sandbox execution.`,
    );
  }
}

export function assertMxcReadiness(params: {
  config: MxcConfig;
  mxcBinaryPath: string;
  platform?: NodeJS.Platform;
  deps?: Partial<ReadinessDeps>;
}): void {
  const platform = params.platform ?? process.platform;
  const deps = { ...DEFAULT_DEPS, ...params.deps };
  assertSupportedContainmentForPlatform(params.config.containment, platform);

  if (platform === "win32") {
    assertWindowsIsoEnvBrokerReady(deps);
  }
}
