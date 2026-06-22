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

  test("accepts non-Linux process containment without a Bubblewrap preflight", () => {
    const deps = depsFor({ bwrap: "ok", userns: "ok" });

    expect(() =>
      assertMxcReadiness({
        config: processConfig,
        mxcBinaryPath: "wxc-exec.exe",
        platform: "win32",
        deps,
      }),
    ).not.toThrow();
    expect(deps.execFileSync).not.toHaveBeenCalledWith("bwrap", ["--version"], expect.any(Object));
  });

  test("rejects processcontainer before non-Windows platforms can register", () => {
    const deps = depsFor({ bwrap: "ok", userns: "ok" });

    for (const platform of ["darwin"] satisfies NodeJS.Platform[]) {
      expect(() =>
        assertMxcReadiness({
          config: { ...processConfig, containment: "processcontainer" },
          mxcBinaryPath: "mxc-exec-mac",
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
          mxcBinaryPath: "mxc-exec-mac",
          platform: "darwin",
          deps,
        }),
      ).toThrow(/not enabled/u);
    }
    expect(deps.execFileSync).not.toHaveBeenCalled();
  });
});
