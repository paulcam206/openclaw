import { describe, expect, test, vi } from "vitest";
import { resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  test("default config from empty/null input", () => {
    const config = resolveConfig(null);
    expect(config).toEqual({
      mxcBinaryPath: undefined,
      containment: "process",
      network: "none",
      timeoutSeconds: 120,
      debug: false,
    });
    const config2 = resolveConfig({});
    expect(config2.containment).toBe("process");
    expect(config2.network).toBe("none");
    expect(config2.timeoutSeconds).toBe(120);
    expect(config2.debug).toBe(false);
    expect(config2).not.toHaveProperty("sandboxBaseline");
  });

  test("all config overrides applied correctly", () => {
    const config = resolveConfig({
      mxcBinaryPath: "C:\\custom\\wxc-exec.exe",
      containment: "wslc",
      network: "default",
      timeoutSeconds: 60,
      debug: true,
      readwritePaths: ["/tmp"],
    });

    expect(config.mxcBinaryPath).toBe("C:\\custom\\wxc-exec.exe");
    expect(config.containment).toBe("wslc");
    expect(config.network).toBe("default");
    expect(config.timeoutSeconds).toBe(60);
    expect(config.timeoutSecondsConfigured).toBe(true);
    expect(config.debug).toBe(true);
    expect(config.readwritePaths).toEqual(["/tmp"]);
  });

  test("sandboxBaseline is not part of plugin config", () => {
    const config = resolveConfig({
      sandboxBaseline: {
        process: { timeoutSeconds: 45 },
      },
    });

    expect(config).not.toHaveProperty("sandboxBaseline");
  });

  test("legacy LXC containment normalizes to process", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = resolveConfig({
      containment: "lxc",
      lxcDistribution: "ubuntu",
      lxcRelease: "24.04",
    });
    expect(config.containment).toBe("process");
    expect(config).not.toHaveProperty("lxcDistribution");
    expect(config).not.toHaveProperty("lxcRelease");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('containment "lxc"'));
    warn.mockRestore();
  });

  test("legacy LXC option keys are ignored with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = resolveConfig({
      containment: "process",
      lxcDistribution: "ubuntu",
      lxcRelease: "24.04",
    });
    expect(config.containment).toBe("process");
    expect(config).not.toHaveProperty("lxcDistribution");
    expect(config).not.toHaveProperty("lxcRelease");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("lxcDistribution, lxcRelease"));
    warn.mockRestore();
  });

  test("empty strings for paths are treated as undefined", () => {
    const config = resolveConfig({
      mxcBinaryPath: "   ",
    });
    expect(config.mxcBinaryPath).toBeUndefined();
  });

  test("invalid containment value falls back to process", () => {
    const config = resolveConfig({ containment: "invalid" });
    expect(config.containment).toBe("process");
  });

  test("all containment options are accepted", () => {
    for (const c of [
      "process",
      "processcontainer",
      "windows_sandbox",
      "wslc",
      "microvm",
      "seatbelt",
      "isolation_session",
    ]) {
      const config = resolveConfig({ containment: c });
      expect(config.containment).toBe(c);
    }
  });

  test("invalid network value falls back to none", () => {
    const config = resolveConfig({ network: "allow-all" });
    expect(config.network).toBe("none");
  });

  test("invalid timeoutSeconds falls back to default", () => {
    expect(resolveConfig({ timeoutSeconds: -5 }).timeoutSeconds).toBe(120);
    expect(resolveConfig({ timeoutSeconds: 0 }).timeoutSeconds).toBe(120);
    expect(resolveConfig({ timeoutSeconds: "fast" }).timeoutSeconds).toBe(120);
    expect(resolveConfig({ timeoutSeconds: -5 })).not.toHaveProperty("timeoutSecondsConfigured");
  });
});
