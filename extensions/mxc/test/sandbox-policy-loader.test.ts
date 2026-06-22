import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  loadSandboxBaselinePolicy,
  readSandboxPolicyFile,
  resolveMachineSandboxPolicyPath,
  resolveUserSandboxPolicyPath,
} from "../src/sandbox-policy-loader.js";

const testDirs: string[] = [];

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function makeTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-mxc-policy-"));
  testDirs.push(dir);
  return dir;
}

function writePolicy(path: string, policy: unknown): void {
  writeFileSync(path, `${JSON.stringify(policy)}\n`, "utf-8");
}

function expectPolicyFileFailure(policyPath: string, action: () => unknown, detail: string): void {
  try {
    action();
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(policyPath);
    expect((err as Error).message).toContain(detail);
    return;
  }
  throw new Error("Expected policy loader failure.");
}

describe("loadSandboxBaselinePolicy", () => {
  test("resolves missing policy files with the default baseline", () => {
    const dir = makeTestDir();
    const userPolicyPath = join(dir, "missing-user-policy.json");
    const machinePolicyPath = join(dir, "missing-machine-policy.json");

    const policy = loadSandboxBaselinePolicy({ machinePolicyPath, userPolicyPath });

    expect(policy.network.denyPrivateNetworks).toBe(true);
    expect(policy.network.denyCloudMetadata).toBe(true);
    expect(policy.network.additionalDeniedHosts).toEqual([]);
    expect(policy.filesystem.denyCredentialStores).toBe(true);
    expect(policy.filesystem.restrictToProjectDir).toBe(true);
    expect(policy.filesystem.additionalReadwritePaths).toEqual([]);
    expect(policy.process.timeoutSeconds).toBe(300);
    expect(policy.process.timeoutSecondsConfigured).toBe(false);
  });

  test("layers user and machine policies in deterministic additive order", () => {
    const dir = makeTestDir();
    const userPolicyPath = join(dir, "user-policy.json");
    const machinePolicyPath = join(dir, "machine-policy.json");
    writePolicy(userPolicyPath, {
      filesystem: {
        additionalDeniedPaths: ["/user-secret", "/shared-secret"],
        additionalReadwritePaths: ["/user-write"],
      },
      network: {
        additionalDeniedHosts: ["user.example.test", "shared.example.test"],
        additionalDeniedCidrs: ["198.51.100.0/24"],
      },
      process: {
        timeoutSeconds: 90,
      },
    });
    writePolicy(machinePolicyPath, {
      filesystem: {
        additionalDeniedPaths: ["/machine-secret"],
        additionalReadonlyPaths: ["/machine-readonly"],
      },
      network: {
        additionalDeniedHosts: ["machine.example.test"],
        additionalDeniedCidrs: ["203.0.113.0/24"],
      },
      process: {
        timeoutSeconds: 120,
      },
    });

    const policy = loadSandboxBaselinePolicy({ machinePolicyPath, userPolicyPath });

    expect(policy.network.additionalDeniedHosts).toEqual([
      "user.example.test",
      "shared.example.test",
      "machine.example.test",
    ]);
    expect(policy.network.additionalDeniedCidrs).toEqual(["198.51.100.0/24", "203.0.113.0/24"]);
    expect(policy.filesystem.additionalDeniedPaths).toEqual([
      "/user-secret",
      "/shared-secret",
      "/machine-secret",
    ]);
    expect(policy.filesystem.additionalReadonlyPaths).toEqual(["/machine-readonly"]);
    expect(policy.filesystem.additionalReadwritePaths).toEqual(["/user-write"]);
    expect(policy.process.timeoutSeconds).toBe(90);
    expect(policy.process.timeoutSecondsConfigured).toBe(true);
  });

  test("concatenates arrays additively and de-dupes by first occurrence", () => {
    const dir = makeTestDir();
    const userPolicyPath = join(dir, "user-policy.json");
    const machinePolicyPath = join(dir, "machine-policy.json");
    writePolicy(userPolicyPath, {
      filesystem: {
        additionalReadonlyPaths: ["/shared-readonly", "/user-readonly"],
        additionalReadwritePaths: ["/shared-write", "/user-write"],
      },
      network: {
        additionalDeniedHosts: ["shared.example.test", "user.example.test"],
      },
    });
    writePolicy(machinePolicyPath, {
      filesystem: {
        additionalReadonlyPaths: ["/machine-readonly", "/shared-readonly"],
        additionalReadwritePaths: ["/machine-write", "/shared-write"],
      },
      network: {
        additionalDeniedHosts: ["machine.example.test", "shared.example.test"],
      },
    });

    const policy = loadSandboxBaselinePolicy({ machinePolicyPath, userPolicyPath });

    expect(policy.network.additionalDeniedHosts).toEqual([
      "shared.example.test",
      "user.example.test",
      "machine.example.test",
    ]);
    expect(policy.filesystem.additionalReadonlyPaths).toEqual([
      "/shared-readonly",
      "/user-readonly",
      "/machine-readonly",
    ]);
    expect(policy.filesystem.additionalReadwritePaths).toEqual([
      "/shared-write",
      "/user-write",
      "/machine-write",
    ]);
  });

  test("uses most-restrictive scalar semantics including smaller positive timeout", () => {
    const dir = makeTestDir();
    const userPolicyPath = join(dir, "user-policy.json");
    const machinePolicyPath = join(dir, "machine-policy.json");
    writePolicy(userPolicyPath, {
      filesystem: {
        denyCredentialStores: true,
      },
      network: {
        denyPrivateNetworks: true,
      },
      process: {
        timeoutSeconds: 75,
      },
    });
    writePolicy(machinePolicyPath, {
      filesystem: {
        restrictToProjectDir: true,
      },
      network: {
        denyCloudMetadata: true,
      },
      process: {
        timeoutSeconds: 30,
      },
    });

    const policy = loadSandboxBaselinePolicy({ machinePolicyPath, userPolicyPath });

    expect(policy.network.denyPrivateNetworks).toBe(true);
    expect(policy.network.denyCloudMetadata).toBe(true);
    expect(policy.filesystem.denyCredentialStores).toBe(true);
    expect(policy.filesystem.restrictToProjectDir).toBe(true);
    expect(policy.process.timeoutSeconds).toBe(30);
    expect(policy.process.timeoutSecondsConfigured).toBe(true);
  });

  test("rejects false hard security booleans instead of silently ignoring them", () => {
    const dir = makeTestDir();
    const userPolicyPath = join(dir, "user-policy.json");
    const machinePolicyPath = join(dir, "machine-policy.json");
    writePolicy(userPolicyPath, {
      filesystem: {
        denyCredentialStores: false,
        restrictToProjectDir: false,
      },
      network: {
        denyCloudMetadata: false,
        denyPrivateNetworks: false,
      },
    });
    writePolicy(machinePolicyPath, {
      filesystem: {
        denyCredentialStores: false,
        restrictToProjectDir: false,
      },
      network: {
        denyCloudMetadata: false,
        denyPrivateNetworks: false,
      },
    });

    expect(() => loadSandboxBaselinePolicy({ machinePolicyPath, userPolicyPath })).toThrow(
      /denyPrivateNetworks|denyCredentialStores/u,
    );
  });
});

describe("readSandboxPolicyFile", () => {
  test("returns undefined for missing files", () => {
    expect(readSandboxPolicyFile(join(makeTestDir(), "missing.json"))).toBeUndefined();
  });

  test("fails closed with path-inclusive errors for malformed existing files", () => {
    const dir = makeTestDir();
    const cases: ReadonlyArray<{
      name: string;
      content: string;
      detail: string;
    }> = [
      {
        name: "invalid-json.json",
        content: "{",
        detail: "Failed to load sandbox policy file at",
      },
      {
        name: "array.json",
        content: "[]",
        detail: "must be a JSON object",
      },
      {
        name: "string.json",
        content: '"policy"',
        detail: "must be a JSON object",
      },
      {
        name: "invalid-section.json",
        content: '{"network":[]}',
        detail: ".network must be a JSON object",
      },
      {
        name: "invalid-field.json",
        content: '{"filesystem":{"additionalDeniedPaths":[42]}}',
        detail: ".filesystem.additionalDeniedPaths[0]",
      },
      {
        name: "unknown-top-level-key.json",
        content: '{"unexpected":true}',
        detail: ".unexpected is not supported",
      },
      {
        name: "unknown-section-key.json",
        content: '{"network":{"unexpected":true}}',
        detail: ".network.unexpected is not supported",
      },
    ];

    for (const testCase of cases) {
      const policyPath = join(dir, testCase.name);
      writeFileSync(policyPath, testCase.content, "utf-8");

      expectPolicyFileFailure(policyPath, () => readSandboxPolicyFile(policyPath), testCase.detail);
    }
  });

  test("fails closed with path-inclusive errors when loaded policy files are invalid", () => {
    const dir = makeTestDir();
    const userPolicyPath = join(dir, "user-policy.json");
    const machinePolicyPath = join(dir, "missing-machine-policy.json");
    writeFileSync(userPolicyPath, '{"process":{"timeoutSeconds":"fast"}}', "utf-8");

    expectPolicyFileFailure(
      userPolicyPath,
      () => loadSandboxBaselinePolicy({ machinePolicyPath, userPolicyPath }),
      ".process.timeoutSeconds",
    );
  });
});

describe("sandbox policy path resolution", () => {
  test("resolves machine policy paths by platform", () => {
    expect(resolveMachineSandboxPolicyPath("win32")).toBe(
      "C:\\ProgramData\\openclaw\\sandbox-policy.json",
    );
    expect(resolveMachineSandboxPolicyPath("darwin")).toBe(
      "/Library/Application Support/openclaw/sandbox-policy.json",
    );
    expect(resolveMachineSandboxPolicyPath("linux")).toBe("/etc/openclaw/sandbox-policy.json");
  });

  test("resolves user policy path under the supplied home directory", () => {
    expect(resolveUserSandboxPolicyPath("/home/alice")).toBe(
      join("/home/alice", ".openclaw", "sandbox-policy.json"),
    );
  });
});
