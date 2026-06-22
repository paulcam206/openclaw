import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import { resolveMxcBinaryPath } from "./binary-resolver.js";
import { resolveConfig } from "./config.js";
import { createMxcSandboxBackendFactory, mxcSandboxBackendManager } from "./mxc-backend.js";
import { assertMxcReadiness } from "./readiness.js";
import {
  formatWindowsBuildSupportWarning,
  getWindowsBuildSupportDecision,
} from "./windows-version.js";

const SUPPORTED_PLATFORMS = new Set(["win32", "darwin"]);

export function registerMxcPlugin(api: OpenClawPluginApi): void {
  const config = resolveConfig(api.pluginConfig);

  if (!SUPPORTED_PLATFORMS.has(process.platform)) {
    console.warn(
      `[mxc] Sandbox backend not available on ${process.platform}. Plugin will be dormant.`,
    );
    return;
  }

  if (process.platform === "win32") {
    const windowsSupport = getWindowsBuildSupportDecision();
    if (!windowsSupport.supported) {
      console.warn(formatWindowsBuildSupportWarning(windowsSupport));
      return;
    }
  }

  // Binary and host readiness checks fail load with actionable remediation.
  let mxcBinaryPath: string;
  try {
    mxcBinaryPath = resolveMxcBinaryPath(config.mxcBinaryPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[mxc] MXC sandbox backend cannot load: ${reason}. Install @microsoft/mxc-sdk or set mxcBinaryPath.`,
      { cause: err },
    );
  }
  assertMxcReadiness({ config, mxcBinaryPath });

  // Register the backend
  const unregister = registerSandboxBackend("mxc", {
    factory: createMxcSandboxBackendFactory(config),
    manager: mxcSandboxBackendManager,
  });

  // Cleanup service unregisters backend on shutdown.
  const cleanupService: OpenClawPluginService = {
    id: "mxc-sandbox-cleanup",
    start() {
      /* no-op */
    },
    stop() {
      unregister();
    },
  };
  api.registerService(cleanupService);
}
