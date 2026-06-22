import { beforeEach, describe, expect, test, vi } from "vitest";

const { execFileSyncMock, osReleaseMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  osReleaseMock: vi.fn(() => "10.0.26100"),
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

vi.mock("node:os", () => ({
  release: osReleaseMock,
}));

import {
  evaluateWindowsBuildSupport,
  formatWindowsBuildSupportWarning,
  getWindowsBuildSupportDecision,
  parseBuildLabExBuild,
  parseWindowsOsReleaseBuild,
  parseWindowsRegistryVersionInfo,
  resolveWindowsSystemExecutable,
} from "../src/windows-version.js";

describe("Windows version parsing", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    osReleaseMock.mockReset();
    osReleaseMock.mockReturnValue("10.0.26100");
  });

  test("parses CurrentBuildNumber, BuildLabEx, and hexadecimal UBR from reg output", () => {
    const info = parseWindowsRegistryVersionInfo(`
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion
    CurrentBuildNumber    REG_SZ    26100
    UBR                   REG_DWORD    0x1f1d
    BuildLabEx            REG_SZ    26200.1.amd64fre.ge_release.240331-1435
`);

    expect(info).toEqual({
      currentBuildNumber: 26100,
      buildLabExBuild: 26200,
      ubr: 7965,
    });
  });

  test("parses decimal UBR values", () => {
    const info = parseWindowsRegistryVersionInfo(`
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion
    UBR    REG_DWORD    7965
`);

    expect(info.ubr).toBe(7965);
  });

  test("parses BuildLabEx and os.release build fallbacks", () => {
    expect(parseBuildLabExBuild("26100.1.amd64fre.ge_release.240331-1435")).toBe(26100);
    expect(parseWindowsOsReleaseBuild("10.0.26500")).toBe(26500);
    expect(parseWindowsOsReleaseBuild("not-a-windows-release")).toBeUndefined();
  });

  test("uses BuildLabEx when CurrentBuildNumber is missing", () => {
    execFileSyncMock.mockReturnValue(`
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion
    BuildLabEx    REG_SZ    26100.1.amd64fre.ge_release.240331-1435
    UBR           REG_DWORD    0x1f1d
`);

    expect(getWindowsBuildSupportDecision()).toMatchObject({
      supported: true,
      build: 26100,
      buildSource: "registry-build-lab-ex",
      ubr: 7965,
      ubrSource: "registry-ubr",
      requirement: "build-and-ubr",
    });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      resolveWindowsSystemExecutable("reg.exe"),
      expect.any(Array),
      expect.any(Object),
    );
  });

  test("uses os.release build when registry data is unavailable", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("reg unavailable");
    });
    osReleaseMock.mockReturnValue("10.0.26500");

    expect(getWindowsBuildSupportDecision()).toMatchObject({
      supported: true,
      build: 26500,
      buildSource: "os-release",
      requirement: "build-only",
    });
  });
});

describe("evaluateWindowsBuildSupport", () => {
  test("fails closed when build is missing", () => {
    expect(evaluateWindowsBuildSupport({})).toEqual({
      supported: false,
      reason: "missing-build",
      requirement: "build-only",
    });
  });

  test("rejects builds below 26100", () => {
    expect(
      evaluateWindowsBuildSupport({
        build: 26099,
        buildSource: "registry-current-build",
      }),
    ).toMatchObject({
      supported: false,
      reason: "build-too-old",
      requirement: "build-only",
    });
  });

  test("requires UBR 7965 for builds below 26500", () => {
    expect(
      evaluateWindowsBuildSupport({
        build: 26100,
        buildSource: "registry-current-build",
      }),
    ).toMatchObject({
      supported: false,
      reason: "missing-ubr",
      requirement: "build-and-ubr",
    });

    expect(
      evaluateWindowsBuildSupport({
        build: 26499,
        buildSource: "registry-current-build",
        ubr: 7964,
        ubrSource: "registry-ubr",
      }),
    ).toMatchObject({
      supported: false,
      reason: "ubr-too-old",
      requirement: "build-and-ubr",
    });

    expect(
      evaluateWindowsBuildSupport({
        build: 26100,
        buildSource: "registry-current-build",
        ubr: 7965,
        ubrSource: "registry-ubr",
      }),
    ).toMatchObject({
      supported: true,
      requirement: "build-and-ubr",
    });
  });

  test("accepts build 26500 and later without UBR", () => {
    expect(
      evaluateWindowsBuildSupport({
        build: 26500,
        buildSource: "registry-current-build",
      }),
    ).toMatchObject({
      supported: true,
      requirement: "build-only",
    });
  });

  test("formats unsupported host warnings with the dormant suffix", () => {
    expect(
      formatWindowsBuildSupportWarning({
        supported: false,
        reason: "ubr-too-old",
        requirement: "build-and-ubr",
        build: 26100,
        buildSource: "registry-current-build",
        ubr: 7964,
        ubrSource: "registry-ubr",
      }),
    ).toBe(
      "[mxc] Windows build 26100.7964 is not supported. MXC requires UBR 7965+ for Windows builds 26100-26499. Plugin will be dormant.",
    );
  });
});
