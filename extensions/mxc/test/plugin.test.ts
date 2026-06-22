import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { WindowsBuildSupportDecision } from "../src/windows-version.js";

const {
  assertMxcReadinessMock,
  createMxcSandboxBackendFactoryMock,
  factoryMock,
  formatWindowsBuildSupportWarningMock,
  getWindowsBuildSupportDecisionMock,
  mxcSandboxBackendManagerMock,
  registerSandboxBackendMock,
  resolveMxcBinaryPathMock,
  unregisterMock,
} = vi.hoisted(() => {
  const factory = { id: "factory" };
  const unregister = vi.fn();
  return {
    assertMxcReadinessMock: vi.fn(),
    createMxcSandboxBackendFactoryMock: vi.fn(() => factory),
    factoryMock: factory,
    formatWindowsBuildSupportWarningMock: vi.fn(
      (decision: { reason: string }) => `[mxc] ${decision.reason}. Plugin will be dormant.`,
    ),
    getWindowsBuildSupportDecisionMock: vi.fn(
      (): WindowsBuildSupportDecision => ({
        supported: true,
        build: 26500,
        buildSource: "registry-current-build",
        requirement: "build-only",
      }),
    ),
    mxcSandboxBackendManagerMock: { id: "manager" },
    registerSandboxBackendMock: vi.fn(() => unregister),
    resolveMxcBinaryPathMock: vi.fn(() => "mxc-test-binary"),
    unregisterMock: unregister,
  };
});

vi.mock("openclaw/plugin-sdk/sandbox", () => ({
  registerSandboxBackend: registerSandboxBackendMock,
}));

vi.mock("../src/binary-resolver.js", () => ({
  resolveMxcBinaryPath: resolveMxcBinaryPathMock,
}));

vi.mock("../src/mxc-backend.js", () => ({
  createMxcSandboxBackendFactory: createMxcSandboxBackendFactoryMock,
  mxcSandboxBackendManager: mxcSandboxBackendManagerMock,
}));

vi.mock("../src/readiness.js", () => ({
  assertMxcReadiness: assertMxcReadinessMock,
}));

vi.mock("../src/windows-version.js", () => ({
  formatWindowsBuildSupportWarning: formatWindowsBuildSupportWarningMock,
  getWindowsBuildSupportDecision: getWindowsBuildSupportDecisionMock,
}));

import { registerMxcPlugin } from "../src/plugin.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

type MxcPluginApiForTest = Pick<OpenClawPluginApi, "pluginConfig" | "registerService">;

function setProcessPlatformForTest(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: true,
    value: platform,
  });
}

function restoreProcessPlatformForTest(): void {
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
}

function createApi(pluginConfig: Record<string, unknown> | undefined = {}): {
  api: OpenClawPluginApi;
  registerService: ReturnType<typeof vi.fn>;
  services: OpenClawPluginService[];
} {
  const services: OpenClawPluginService[] = [];
  const registerService = vi.fn((service: OpenClawPluginService): void => {
    services.push(service);
  });
  const api = {
    pluginConfig,
    registerService,
  } satisfies MxcPluginApiForTest;

  return {
    api: api as unknown as OpenClawPluginApi,
    registerService,
    services,
  };
}

describe("registerMxcPlugin", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    assertMxcReadinessMock.mockClear();
    createMxcSandboxBackendFactoryMock.mockClear();
    formatWindowsBuildSupportWarningMock.mockClear();
    getWindowsBuildSupportDecisionMock.mockReset();
    getWindowsBuildSupportDecisionMock.mockReturnValue({
      supported: true,
      build: 26500,
      buildSource: "registry-current-build",
      requirement: "build-only",
    });
    registerSandboxBackendMock.mockClear();
    resolveMxcBinaryPathMock.mockReset();
    resolveMxcBinaryPathMock.mockReturnValue("mxc-test-binary");
    unregisterMock.mockClear();
    setProcessPlatformForTest("linux");
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    restoreProcessPlatformForTest();
  });

  test("warns and stays dormant on unsupported platforms", () => {
    setProcessPlatformForTest("freebsd");
    const { api, registerService } = createApi();

    registerMxcPlugin(api);

    expect(warnSpy).toHaveBeenCalledWith(
      "[mxc] Sandbox backend not available on freebsd. Plugin will be dormant.",
    );
    expect(getWindowsBuildSupportDecisionMock).not.toHaveBeenCalled();
    expect(resolveMxcBinaryPathMock).not.toHaveBeenCalled();
    expect(assertMxcReadinessMock).not.toHaveBeenCalled();
    expect(registerSandboxBackendMock).not.toHaveBeenCalled();
    expect(registerService).not.toHaveBeenCalled();
  });

  test("warns and stays dormant when Windows build support check fails", () => {
    setProcessPlatformForTest("win32");
    getWindowsBuildSupportDecisionMock.mockReturnValue({
      supported: false,
      reason: "missing-ubr",
      requirement: "build-and-ubr",
      build: 26100,
      buildSource: "registry-current-build",
    });
    const { api, registerService } = createApi();

    registerMxcPlugin(api);

    expect(formatWindowsBuildSupportWarningMock).toHaveBeenCalledWith({
      supported: false,
      reason: "missing-ubr",
      requirement: "build-and-ubr",
      build: 26100,
      buildSource: "registry-current-build",
    });
    expect(warnSpy).toHaveBeenCalledWith("[mxc] missing-ubr. Plugin will be dormant.");
    expect(resolveMxcBinaryPathMock).not.toHaveBeenCalled();
    expect(assertMxcReadinessMock).not.toHaveBeenCalled();
    expect(registerSandboxBackendMock).not.toHaveBeenCalled();
    expect(registerService).not.toHaveBeenCalled();
  });

  test("bypasses the Windows build guard on supported non-Windows platforms", () => {
    setProcessPlatformForTest("linux");
    const { api } = createApi();

    registerMxcPlugin(api);

    expect(getWindowsBuildSupportDecisionMock).not.toHaveBeenCalled();
    expect(resolveMxcBinaryPathMock).toHaveBeenCalledWith(undefined);
    expect(assertMxcReadinessMock).toHaveBeenCalledWith({
      config: expect.objectContaining({ containment: "process" }),
      mxcBinaryPath: "mxc-test-binary",
    });
    expect(registerSandboxBackendMock).toHaveBeenCalledWith("mxc", {
      factory: factoryMock,
      manager: mxcSandboxBackendManagerMock,
    });
  });

  test("registers the sandbox backend on supported Windows builds", () => {
    setProcessPlatformForTest("win32");
    const { api, services } = createApi({ timeoutSeconds: 60 });

    registerMxcPlugin(api);

    expect(getWindowsBuildSupportDecisionMock).toHaveBeenCalledTimes(1);
    expect(resolveMxcBinaryPathMock).toHaveBeenCalledWith(undefined);
    expect(assertMxcReadinessMock).toHaveBeenCalledWith({
      config: expect.objectContaining({
        timeoutSeconds: 60,
      }),
      mxcBinaryPath: "mxc-test-binary",
    });
    expect(createMxcSandboxBackendFactoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutSeconds: 60,
      }),
    );
    expect(registerSandboxBackendMock).toHaveBeenCalledWith("mxc", {
      factory: factoryMock,
      manager: mxcSandboxBackendManagerMock,
    });
    expect(services).toHaveLength(1);

    void services[0]?.stop?.({} as OpenClawPluginServiceContext);
    expect(unregisterMock).toHaveBeenCalledTimes(1);
  });

  test("keeps the existing binary-resolution failure path after host support passes", () => {
    resolveMxcBinaryPathMock.mockImplementation(() => {
      throw new Error("missing binary");
    });
    const { api, registerService } = createApi();

    expect(() => registerMxcPlugin(api)).toThrow(
      "[mxc] MXC sandbox backend cannot load: missing binary. Install @microsoft/mxc-sdk or set mxcBinaryPath.",
    );

    expect(warnSpy).not.toHaveBeenCalled();
    expect(assertMxcReadinessMock).not.toHaveBeenCalled();
    expect(registerSandboxBackendMock).not.toHaveBeenCalled();
    expect(registerService).not.toHaveBeenCalled();
  });
});
