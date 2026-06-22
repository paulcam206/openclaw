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

  if (platform !== "linux" || params.config.containment !== "process") {
    return;
  }

  const failures: string[] = [];

  try {
    deps.execFileSync("bwrap", ["--version"], {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5_000,
    });
  } catch {
    failures.push("Bubblewrap (`bwrap`) is not installed or is not on PATH.");
  }

  // Probe unprivileged user namespaces by running bwrap itself. This is the
  // ground-truth check: many newer kernels no longer expose
  // /proc/sys/kernel/unprivileged_userns_clone (Debian/Ubuntu still do,
  // Fedora/Arch typically don't), and Ubuntu 24.04 AppArmor restrictions can
  // block unprivileged userns even when the sysctl says 1. The readonly root
  // bind gives the probe access to /bin/true plus its loader/libraries while
  // still exercising the same userns, netns, and mount syscalls the sandbox
  // uses. The later --dev replaces the host /dev with Bubblewrap's dev tmpfs.
  // Skip when bwrap itself is missing; the failure above already covers that.
  if (failures.length === 0) {
    try {
      deps.execFileSync(
        "bwrap",
        ["--unshare-user", "--unshare-net", "--ro-bind", "/", "/", "--dev", "/dev", "/bin/true"],
        {
          encoding: "utf-8",
          stdio: "pipe",
          timeout: 5_000,
        },
      );
    } catch (error) {
      const detail = error instanceof Error && error.message ? `: ${error.message.trim()}` : "";
      failures.push(`Bubblewrap sandbox probe failed${detail}`);
    }
  }

  if (failures.length === 0) {
    return;
  }

  throw new Error(
    [
      `[mxc] MXC Bubblewrap sandbox is not ready. MXC Linux executor: ${params.mxcBinaryPath}.`,
      ...failures.map((failure) => `- ${failure}`),
      "Remediation: install Bubblewrap (`sudo apt install bubblewrap`, `sudo dnf install bubblewrap`, or `apk add bubblewrap`) and ensure the kernel allows unprivileged user namespaces. Some hosts (Ubuntu 24.04 with restricted AppArmor profiles, Debian with `kernel.unprivileged_userns_clone=0`) require enabling them explicitly, e.g. `sudo sysctl -w kernel.unprivileged_userns_clone=1` or relaxing the AppArmor profile via `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`.",
    ].join("\n"),
  );
}
