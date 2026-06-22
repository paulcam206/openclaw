import { execFileSync } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import type { MxcConfig } from "../src/config.js";
import { assertMxcReadiness } from "../src/readiness.js";
import { resolveWindowsSystemExecutable } from "../src/windows-version.js";

const processConfig: MxcConfig = {
  containment: "process",
  network: "none",
  timeoutSeconds: 120,
  debug: false,
};

function depsFor(params: {
  bwrap?: "ok" | "missing";
  isoEnvBroker?: "missing" | "running" | "stopped";
  userns?: "ok" | "denied";
}) {
  const exec = vi.fn((command: string, args: readonly string[]) => {
    if (command === resolveWindowsSystemExecutable("sc.exe")) {
      if (params.isoEnvBroker === "missing") {
        throw new Error("service missing");
      }
      return params.isoEnvBroker === "stopped"
        ? "STATE              : 1  STOPPED"
        : "STATE              : 4  RUNNING";
    }
    if (command !== "bwrap") {
      throw new Error(`unexpected command: ${command}`);
    }
    if (args[0] === "--version") {
      if (params.bwrap === "missing") {
        throw new Error("ENOENT");
      }
      return "bwrap 0.9.0";
    }
    if (args[0] === "--unshare-user") {
      if (params.userns === "denied") {
        throw new Error(
          "bwrap: setting up uid map: Permission denied (user namespaces unavailable)",
        );
      }
      return "";
    }
    throw new Error(`unexpected bwrap args: ${args.join(" ")}`);
  }) as unknown as typeof execFileSync;
  return { execFileSync: exec };
}

const readinessProbeArgs = [
  "--unshare-user",
  "--unshare-net",
  "--ro-bind",
  "/",
  "/",
  "--dev",
  "/dev",
  "/bin/true",
];

describe("assertMxcReadiness", () => {
  test("skips Bubblewrap preflight outside Linux process containment", () => {
    const deps = depsFor({ bwrap: "missing", isoEnvBroker: "running", userns: "denied" });

    expect(() =>
      assertMxcReadiness({
        config: processConfig,
        mxcBinaryPath: "wxc-exec.exe",
        platform: "win32",
        deps,
      }),
    ).not.toThrow();
    expect(deps.execFileSync).toHaveBeenCalledWith(
      resolveWindowsSystemExecutable("sc.exe"),
      ["query", "IsoEnvBroker"],
      expect.any(Object),
    );
    expect(deps.execFileSync).not.toHaveBeenCalledWith(
      "bwrap",
      expect.any(Array),
      expect.any(Object),
    );
  });

  test("rejects Windows hosts when IsoEnvBroker is unavailable", () => {
    for (const isoEnvBroker of ["missing", "stopped"] as const) {
      const deps = depsFor({ isoEnvBroker });

      expect(() =>
        assertMxcReadiness({
          config: processConfig,
          mxcBinaryPath: "wxc-exec.exe",
          platform: "win32",
          deps,
        }),
      ).toThrow(/IsoEnvBroker/u);
    }
  });

  test("accepts Linux process containment when bwrap and user namespaces are ready", () => {
    const deps = depsFor({ bwrap: "ok", userns: "ok" });

    expect(() =>
      assertMxcReadiness({
        config: processConfig,
        mxcBinaryPath: "/usr/bin/lxc-exec",
        platform: "linux",
        deps,
      }),
    ).not.toThrow();
    expect(deps.execFileSync).toHaveBeenCalledWith("bwrap", ["--version"], expect.any(Object));
    expect(deps.execFileSync).toHaveBeenCalledWith("bwrap", readinessProbeArgs, expect.any(Object));
  });

  test("mounts a readonly filesystem before executing the Bubblewrap probe command", () => {
    const deps = depsFor({ bwrap: "ok", userns: "ok" });

    assertMxcReadiness({
      config: processConfig,
      mxcBinaryPath: "/usr/bin/lxc-exec",
      platform: "linux",
      deps,
    });

    expect(deps.execFileSync).toHaveBeenNthCalledWith(
      2,
      "bwrap",
      readinessProbeArgs,
      expect.any(Object),
    );
  });

  test("reports actionable remediation when Bubblewrap is missing", () => {
    const deps = depsFor({ bwrap: "missing", userns: "ok" });

    expect(() =>
      assertMxcReadiness({
        config: processConfig,
        mxcBinaryPath: "/usr/bin/lxc-exec",
        platform: "linux",
        deps,
      }),
    ).toThrow(/install Bubblewrap/u);
    // Once bwrap itself is missing, the userns probe is skipped — the install
    // failure already covers that case.
    expect(deps.execFileSync).toHaveBeenCalledTimes(1);
  });

  test("reports a failed Bubblewrap sandbox probe", () => {
    const deps = depsFor({ bwrap: "ok", userns: "denied" });

    expect(() =>
      assertMxcReadiness({
        config: processConfig,
        mxcBinaryPath: "/usr/bin/lxc-exec",
        platform: "linux",
        deps,
      }),
    ).toThrow(/Bubblewrap sandbox probe failed/u);
  });

  test("rejects processcontainer before non-Windows platforms can register", () => {
    const deps = depsFor({ bwrap: "ok", userns: "ok" });

    for (const platform of ["linux", "darwin"] satisfies NodeJS.Platform[]) {
      expect(() =>
        assertMxcReadiness({
          config: { ...processConfig, containment: "processcontainer" },
          mxcBinaryPath: "/usr/bin/lxc-exec",
          platform,
          deps,
        }),
      ).toThrow(/processcontainer.*Windows-only/u);
    }
    expect(deps.execFileSync).not.toHaveBeenCalled();
  });

  test("rejects direct experimental containments before registration", () => {
    const deps = depsFor({ bwrap: "ok", userns: "ok" });

    for (const containment of [
      "windows_sandbox",
      "wslc",
      "microvm",
      "seatbelt",
      "isolation_session",
    ] as const) {
      expect(() =>
        assertMxcReadiness({
          config: { ...processConfig, containment },
          mxcBinaryPath: "/usr/bin/lxc-exec",
          platform: "linux",
          deps,
        }),
      ).toThrow(/not enabled/u);
    }
    expect(deps.execFileSync).not.toHaveBeenCalled();
  });
});
