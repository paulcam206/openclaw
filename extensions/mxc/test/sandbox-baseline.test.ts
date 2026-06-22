import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  BASELINE_DENIED_CIDRS,
  BASELINE_DENIED_HOSTS,
  BASELINE_READONLY_PATHS_UNIX,
  BASELINE_READONLY_PATHS_WINDOWS,
  BASELINE_TIMEOUT_SECONDS,
  computeEffectiveBlockedHosts,
  computeEffectiveDeniedFilesystemPaths,
  computeEffectiveDeniedPaths,
  computeEffectiveReadonlyPaths,
  computeEffectiveReadwritePaths,
  DEFAULT_SANDBOX_BASELINE,
  NEVER_PUNCHABLE_NETWORK_ENTRIES,
  resolveSandboxBaseline,
} from "../src/sandbox-baseline.js";

function occurrenceCount(values: readonly string[], expected: string): number {
  return values.filter((value) => value === expected).length;
}

describe("resolveSandboxBaseline", () => {
  test("returns secure defaults", () => {
    expect(resolveSandboxBaseline()).toEqual(DEFAULT_SANDBOX_BASELINE);
    expect(resolveSandboxBaseline().network.denyPrivateNetworks).toBe(true);
    expect(resolveSandboxBaseline().network.denyCloudMetadata).toBe(true);
    expect(resolveSandboxBaseline().filesystem.denyCredentialStores).toBe(true);
    expect(resolveSandboxBaseline().filesystem.restrictToProjectDir).toBe(true);
    expect(resolveSandboxBaseline().process.timeoutSeconds).toBe(BASELINE_TIMEOUT_SECONDS);
    expect(resolveSandboxBaseline().process.timeoutSecondsConfigured).toBe(false);
  });

  test("merges partial input with defaults", () => {
    const baseline = resolveSandboxBaseline({
      filesystem: {
        additionalDeniedPaths: ["/secrets/token-store"],
        restrictToProjectDir: false,
      },
      network: {
        additionalDeniedHosts: ["blocked.example.com"],
      },
      process: {
        timeoutSeconds: 45,
      },
    });

    expect(baseline.network.denyPrivateNetworks).toBe(true);
    expect(baseline.network.denyCloudMetadata).toBe(true);
    expect(baseline.network.additionalDeniedHosts).toEqual(["blocked.example.com"]);
    expect(baseline.network.additionalDeniedCidrs).toEqual([]);
    expect(baseline.filesystem.denyCredentialStores).toBe(true);
    expect(baseline.filesystem.restrictToProjectDir).toBe(false);
    expect(baseline.filesystem.additionalDeniedPaths).toEqual(["/secrets/token-store"]);
    expect(baseline.filesystem.additionalReadonlyPaths).toEqual([]);
    expect(baseline.filesystem.additionalReadwritePaths).toEqual([]);
    expect(baseline.process.timeoutSeconds).toBe(45);
    expect(baseline.process.timeoutSecondsConfigured).toBe(true);
  });

  test("rejects invalid timeout values", () => {
    expect(() => resolveSandboxBaseline({ process: { timeoutSeconds: 0 } })).toThrow(RangeError);
  });
});

describe("computeEffectiveDeniedFilesystemPaths", () => {
  test("resolves Unix home-relative credential paths using explicit platform and home", () => {
    const baseline = resolveSandboxBaseline({
      filesystem: {
        additionalDeniedPaths: ["/workspace/.env", "/workspace/.env"],
      },
    });

    const deniedPaths = computeEffectiveDeniedFilesystemPaths(baseline.filesystem, {
      homeDir: "/home/alice/",
      platform: "linux",
    });

    expect(deniedPaths).toContain("/home/alice/.aws");
    expect(deniedPaths).toContain("/home/alice/.ssh");
    expect(deniedPaths).toContain("/home/alice/.openclaw/credentials");
    expect(deniedPaths).toContain("/etc/shadow");
    expect(deniedPaths).toContain("/workspace/.env");
    expect(occurrenceCount(deniedPaths, "/workspace/.env")).toBe(1);
  });

  test("expands OpenClaw auth-profile wildcard to concrete agent files", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "mxc-baseline-home-"));
    const authProfileFile = path.join(
      homeDir,
      ".openclaw",
      "agents",
      "agent-a",
      "agent",
      "auth-profiles.json",
    );
    try {
      mkdirSync(path.dirname(authProfileFile), { recursive: true });
      writeFileSync(authProfileFile, "{}");

      const deniedPaths = computeEffectiveDeniedFilesystemPaths(
        resolveSandboxBaseline().filesystem,
        {
          homeDir,
          platform: process.platform === "win32" ? "win32" : "linux",
        },
      );

      expect(deniedPaths).toContain(authProfileFile);
      expect(deniedPaths.some((value) => value.includes("*"))).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("resolves Windows home-relative credential paths using explicit platform and home", () => {
    const baseline = resolveSandboxBaseline();

    const deniedPaths = computeEffectiveDeniedPaths(baseline.filesystem, {
      homeDir: "C:\\Users\\Alice\\",
      platform: "win32",
    });

    expect(deniedPaths).toContain("C:\\Users\\Alice\\.aws");
    expect(deniedPaths).toContain("C:\\Users\\Alice\\.ssh");
    expect(deniedPaths).toContain("C:\\Users\\Alice\\AppData\\Local\\Microsoft\\Edge\\User Data");
    expect(deniedPaths).toContain("C:\\Windows\\System32\\config\\SAM");
  });

  test("keeps only additional denied paths when credential-store denial is disabled", () => {
    const baseline = resolveSandboxBaseline({
      filesystem: {
        additionalDeniedPaths: ["/custom/secret"],
        denyCredentialStores: false,
      },
    });

    expect(
      computeEffectiveDeniedFilesystemPaths(baseline.filesystem, {
        homeDir: "/home/alice",
        platform: "linux",
      }),
    ).toEqual(["/custom/secret"]);
  });
});

describe("computeEffectiveReadonlyPaths", () => {
  test("returns Unix readonly paths with additional entries de-duped", () => {
    const additionalReadonlyPath = "/nix/store";
    const baseline = resolveSandboxBaseline({
      filesystem: {
        additionalReadonlyPaths: [additionalReadonlyPath, additionalReadonlyPath],
      },
    });

    const readonlyPaths = computeEffectiveReadonlyPaths(baseline.filesystem, "linux");

    expect(readonlyPaths).toEqual([...BASELINE_READONLY_PATHS_UNIX, additionalReadonlyPath]);
    expect(readonlyPaths).not.toContain(BASELINE_READONLY_PATHS_WINDOWS[0]);
  });

  test("returns Windows readonly paths", () => {
    const baseline = resolveSandboxBaseline();

    expect(computeEffectiveReadonlyPaths(baseline.filesystem, "win32")).toEqual([
      ...BASELINE_READONLY_PATHS_WINDOWS,
    ]);
  });
});

describe("computeEffectiveReadwritePaths", () => {
  test("includes project dir, Unix temp dir, additional paths, and de-dupes", () => {
    const readwritePaths = computeEffectiveReadwritePaths({
      additionalReadwritePaths: [
        "/var/openclaw-output",
        "/var/openclaw-output",
        "/workspace/project",
      ],
      platform: "linux",
      projectDir: "/workspace/project",
      tempEnv: { TMPDIR: "/run/user/1000/tmp" },
    });

    expect(readwritePaths).toEqual([
      "/workspace/project",
      "/run/user/1000/tmp",
      "/var/openclaw-output",
    ]);
  });

  test("uses Windows TEMP for the platform temp dir", () => {
    const readwritePaths = computeEffectiveReadwritePaths({
      additionalReadwritePaths: ["D:\\cache"],
      platform: "win32",
      projectDir: "D:\\project",
      tempEnv: { TEMP: "C:\\Users\\Alice\\AppData\\Local\\Temp", TMP: "D:\\tmp" },
    });

    expect(readwritePaths).toEqual([
      "D:\\project",
      "C:\\Users\\Alice\\AppData\\Local\\Temp",
      "D:\\cache",
    ]);
  });
});

describe("computeEffectiveBlockedHosts", () => {
  test("merges defaults, wildcard suffix entries, additional entries, and de-dupes", () => {
    const baseline = resolveSandboxBaseline({
      network: {
        additionalDeniedCidrs: ["203.0.113.0/24", "203.0.113.0/24"],
        additionalDeniedHosts: ["Bad.Example.com", "bad.example.com"],
      },
    });

    const blockedHosts = computeEffectiveBlockedHosts(baseline.network);

    expect(blockedHosts).toContain(BASELINE_DENIED_CIDRS[1]);
    expect(blockedHosts).toContain(BASELINE_DENIED_HOSTS[1]);
    expect(blockedHosts).toContain("*.internal");
    expect(blockedHosts).toContain("bad.example.com");
    expect(occurrenceCount(blockedHosts, "bad.example.com")).toBe(1);
    expect(occurrenceCount(blockedHosts, "203.0.113.0/24")).toBe(1);
  });

  test("removes allowlisted additional entries but never punches baseline-protected entries", () => {
    const baseline = resolveSandboxBaseline({
      network: {
        additionalDeniedCidrs: ["198.51.100.0/24", "203.0.114.0/24"],
        additionalDeniedHosts: ["allowed.example.com", "metadata.azure.com"],
      },
    });

    const blockedHosts = computeEffectiveBlockedHosts(baseline.network, [
      "10.0.0.0/8",
      "169.254.169.254",
      "*.local",
      "198.51.100.0/24",
      "allowed.example.com",
      "metadata.azure.com",
    ]);

    expect(blockedHosts).toContain("10.0.0.0/8");
    expect(blockedHosts).toContain("169.254.169.254");
    expect(blockedHosts).toContain("*.local");
    expect(blockedHosts).toContain("198.51.100.0/24");
    expect(blockedHosts).toContain("metadata.azure.com");
    expect(blockedHosts).toContain("203.0.114.0/24");
    expect(blockedHosts).not.toContain("allowed.example.com");
  });

  test("exports never-punchable network entries for policy callers", () => {
    expect(NEVER_PUNCHABLE_NETWORK_ENTRIES).toContain("10.0.0.0/8");
    expect(NEVER_PUNCHABLE_NETWORK_ENTRIES).toContain("169.254.169.254");
    expect(NEVER_PUNCHABLE_NETWORK_ENTRIES).toContain("*.local");
  });
});

describe("BASELINE_TIMEOUT_SECONDS", () => {
  test("is 300 seconds", () => {
    expect(BASELINE_TIMEOUT_SECONDS).toBe(300);
  });
});
