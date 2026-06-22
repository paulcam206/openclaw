import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock node:fs and node:os for controlled testing
const { existsSyncMock, homedirMock, platformMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  homedirMock: vi.fn(),
  platformMock: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
}));

vi.mock("node:os", () => ({
  homedir: homedirMock,
  platform: platformMock,
}));

import { resolveMxcBinaryPath } from "../src/binary-resolver.js";

describe("resolveMxcBinaryPath", () => {
  const originalPath = process.env.PATH;

  beforeEach(() => {
    existsSyncMock.mockReset();
    homedirMock.mockReturnValue("/home/openclaw");
    platformMock.mockReturnValue("darwin");
    process.env.PATH = "";
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  test("config override returns the override path when file exists", () => {
    existsSyncMock.mockReturnValue(true);
    const result = resolveMxcBinaryPath("C:\\custom\\wxc-exec.exe");
    expect(result).toBe("C:\\custom\\wxc-exec.exe");
  });

  test("config override throws when file does not exist", () => {
    existsSyncMock.mockReturnValue(false);
    expect(() => resolveMxcBinaryPath("C:\\missing\\wxc-exec.exe")).toThrow(
      /not found at configured path/,
    );
  });

  test("missing binary with no override throws descriptive error", () => {
    existsSyncMock.mockReturnValue(false);
    // Without override, it tries to discover; all paths will fail.
    expect(() => resolveMxcBinaryPath()).toThrow(/not found/);
  });

  test("ignores project bin candidates during discovery", () => {
    const projectCandidate = path.join(process.cwd(), "bin", "mxc-exec-mac");
    const trustedDir = "/trusted-path";
    const pathCandidate = path.join(trustedDir, "mxc-exec-mac");
    process.env.PATH = trustedDir;
    existsSyncMock.mockImplementation((candidate) => {
      const candidatePath = String(candidate);
      return candidatePath === projectCandidate || candidatePath === pathCandidate;
    });

    expect(resolveMxcBinaryPath()).toBe(pathCandidate);
  });

  test("prefers SDK binary over PATH binary", () => {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const trustedDir = "/trusted-path";
    const pathCandidate = path.join(trustedDir, "mxc-exec-mac");
    process.env.PATH = trustedDir;
    let sdkCandidate: string | undefined;
    existsSyncMock.mockImplementation((candidate) => {
      const candidatePath = String(candidate);
      if (candidatePath.endsWith(`${path.sep}bin${path.sep}${arch}`)) {
        return true;
      }
      if (candidatePath.endsWith(`${path.sep}bin${path.sep}${arch}${path.sep}mxc-exec-mac`)) {
        sdkCandidate = candidatePath;
        return true;
      }
      return candidatePath === pathCandidate;
    });

    expect(resolveMxcBinaryPath()).toBe(sdkCandidate);
  });

  test("falls back to PATH when SDK binary is absent", () => {
    const trustedDir = "/trusted-path";
    const pathCandidate = path.join(trustedDir, "mxc-exec-mac");
    process.env.PATH = trustedDir;
    existsSyncMock.mockImplementation((candidate) => String(candidate) === pathCandidate);

    expect(resolveMxcBinaryPath()).toBe(pathCandidate);
  });

  test("ignores empty and relative PATH entries during discovery", () => {
    const relativeCandidate = path.join("relative-path", "mxc-exec-mac");
    const currentDirectoryCandidate = path.join("", "mxc-exec-mac");
    const trustedDir = "/trusted-path";
    const trustedCandidate = path.join(trustedDir, "mxc-exec-mac");
    process.env.PATH = `:relative-path:${trustedDir}`;
    existsSyncMock.mockImplementation((candidate) => {
      const candidatePath = String(candidate);
      return [relativeCandidate, currentDirectoryCandidate, trustedCandidate].includes(
        candidatePath,
      );
    });

    expect(resolveMxcBinaryPath()).toBe(trustedCandidate);
  });
});
