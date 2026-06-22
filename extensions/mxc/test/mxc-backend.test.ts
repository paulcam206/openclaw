import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveConfig, type MxcConfig } from "../src/config.js";
import { createMxcSandboxBackendHandle, mxcSandboxBackendManager } from "../src/mxc-backend.js";

const { execFileMock, mockedHomeDir, stdinEndMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  mockedHomeDir: { value: undefined as string | undefined },
  stdinEndMock: vi.fn(),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockedHomeDir.value ?? actual.homedir(),
  };
});

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("../src/binary-resolver.js", () => ({
  resolveMxcBinaryPath: () => "mxc-test-binary",
}));

const baseConfig: MxcConfig = {
  containment: "process",
  network: "none",
  timeoutSeconds: 120,
  timeoutSecondsConfigured: true,
  debug: false,
};

const baseParams = {
  config: baseConfig,
  runtimeId: "openclaw-mxc-test-abc12345",
  workdir: "/workspace",
  platform: "darwin" as NodeJS.Platform,
};

const testDirs: string[] = [];

function sandboxPolicyOptions(policy: unknown) {
  const dir = mkdtempSync(path.join(tmpdir(), "mxc-policy-"));
  testDirs.push(dir);
  const userPolicyPath = path.join(dir, "user-policy.json");
  writeFileSync(userPolicyPath, `${JSON.stringify(policy)}\n`, "utf-8");
  return {
    userPolicyPath,
    machinePolicyPath: path.join(dir, "missing-machine-policy.json"),
  };
}

function decodePayload(
  argv: readonly string[],
  options: { cleanupPayloadFile?: boolean } = {},
): {
  config: Record<string, unknown>;
  options: Record<string, unknown>;
} {
  const payloadFileIndex = argv.indexOf("--payload-file");
  if (payloadFileIndex >= 0 && argv[payloadFileIndex + 1]) {
    const payloadFile = argv[payloadFileIndex + 1];
    const decoded = JSON.parse(readFileSync(payloadFile, "utf-8")) as {
      config: Record<string, unknown>;
      options: Record<string, unknown>;
    };
    if (options.cleanupPayloadFile !== false) {
      rmSync(path.dirname(payloadFile), { force: true, recursive: true });
    }
    return decoded;
  }
  const payloadIndex = argv.indexOf("--payload");
  if (payloadIndex < 0 || !argv[payloadIndex + 1]) {
    throw new Error(`expected --payload in argv: ${JSON.stringify(argv)}`);
  }
  return JSON.parse(Buffer.from(argv[payloadIndex + 1], "base64").toString("utf-8")) as {
    config: Record<string, unknown>;
    options: Record<string, unknown>;
  };
}

function decodeContainerConfig(argv: readonly string[]): Record<string, unknown> {
  return decodePayload(argv).config;
}

function decodeConfigBase64Argv(args: readonly string[]): Record<string, unknown> {
  const configIndex = args.indexOf("--config-base64");
  if (configIndex < 0 || !args[configIndex + 1]) {
    throw new Error(`expected --config-base64 in argv: ${JSON.stringify(args)}`);
  }
  return JSON.parse(Buffer.from(args[configIndex + 1], "base64").toString("utf-8")) as Record<
    string,
    unknown
  >;
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  expect(field).toEqual(expect.any(Object));
  return field as Record<string, unknown>;
}

function stringArrayField(value: Record<string, unknown>, key: string): string[] {
  const field = value[key];
  expect(field).toEqual(expect.any(Array));
  return field as string[];
}

async function withProcessEnv(
  overrides: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const original = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    original.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("createMxcSandboxBackendHandle", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    stdinEndMock.mockReset();
    execFileMock.mockImplementation(
      (
        _binaryPath: string,
        _args: readonly string[],
        _options: unknown,
        callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
      ) => {
        callback(null, Buffer.from(""), Buffer.alloc(0));
        return { stdin: { end: stdinEndMock } };
      },
    );
    mockedHomeDir.value = mkdtempSync(path.join(tmpdir(), "mxc-test-home-"));
    testDirs.push(mockedHomeDir.value);
    baseParams.workdir = mkdtempSync(path.join(tmpdir(), "mxc-test-workspace-"));
    testDirs.push(baseParams.workdir);
  });

  afterEach(() => {
    mockedHomeDir.value = undefined;
    for (const dir of testDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("buildExecSpec returns a launcher argv with abstract process containment by default", async () => {
    const handle = createMxcSandboxBackendHandle(baseParams);
    const spec = await handle.buildExecSpec({
      command: "echo hello",
      env: {},
      usePty: false,
    });

    expect(spec.argv[0]).toBe(process.execPath);
    expect(spec.argv[1]).toMatch(/mxc-spawn-launcher\.mjs$/);
    expect(spec.argv[2]).toBe("--payload-file");
    expect(spec.argv.length).toBe(4);
    expect(spec.stdinMode).toBe("pipe-closed");
    expect((spec as { requirePty?: boolean }).requirePty).toBeUndefined();

    const payload = decodePayload(spec.argv);
    const cfg = payload.config;
    const network = objectField(cfg, "network");
    const processConfig = objectField(cfg, "process");
    expect(cfg.containment).toBe("process");
    expect(cfg.processContainer).toBeUndefined();
    expect(cfg.lxc).toBeUndefined();
    expect(network.defaultPolicy).toBe("block");
    expect(network.enforcementMode).toBeUndefined();
    expect(processConfig.timeout).toBe(120_000);
    expect(payload.options).toEqual({
      debug: false,
      executablePath: "mxc-test-binary",
      usePty: false,
    });
  });

  test("buildExecSpec keeps command and env payload out of process argv", async () => {
    await withProcessEnv({ OPENCLAW_MXC_HOST_SECRET_TEST: "host-secret" }, async () => {
      const handle = createMxcSandboxBackendHandle(baseParams);
      const spec = await handle.buildExecSpec({
        command: "printf secret-command",
        env: { SECRET_TOKEN: "secret-env-value" },
        usePty: false,
      });

      const serializedArgv = JSON.stringify(spec.argv);
      expect(serializedArgv).not.toContain("secret-command");
      expect(serializedArgv).not.toContain("SECRET_TOKEN");
      expect(serializedArgv).not.toContain("secret-env-value");
      expect(spec.env.OPENCLAW_MXC_HOST_SECRET_TEST).toBeUndefined();
      expect(spec.argv[2]).toBe("--payload-file");

      const payloadFile = spec.argv[3];
      expect(readFileSync(payloadFile, "utf-8")).toContain("secret-env-value");
      if (process.platform !== "win32") {
        expect(statSync(payloadFile).mode & 0o777).toBe(0o600);
      }
      await handle.finalizeExec?.({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: spec.finalizeToken,
      });
      expect(existsSync(path.dirname(payloadFile))).toBe(false);
    });
  });

  test("Windows process containment emits ProcessContainer settings and curated env", async () => {
    await withProcessEnv(
      {
        SystemRoot: "C:\\Windows",
        SystemDrive: "C:",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        USERPROFILE: "C:\\Users\\openclaw",
        APPDATA: "C:\\Users\\openclaw\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\openclaw\\AppData\\Local",
        ProgramData: "C:\\ProgramData",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        NUMBER_OF_PROCESSORS: "8",
        OPENCLAW_MXC_SECRET_TEST: "do-not-leak",
      },
      async () => {
        const handle = createMxcSandboxBackendHandle({
          ...baseParams,
          workdir: baseParams.workdir,
          platform: "win32",
        });
        const spec = await handle.buildExecSpec({
          command: "echo hello",
          env: { CUSTOM_ENV: "caller", comspec: "C:\\Tools\\custom-cmd.exe" },
          usePty: false,
        });

        const cfg = decodeContainerConfig(spec.argv);
        const processContainer = objectField(cfg, "processContainer");
        const processConfig = objectField(cfg, "process");
        const network = objectField(cfg, "network");
        const env = stringArrayField(processConfig, "env");
        expect(cfg.containment).toBe("process");
        expect(processContainer.ui).toMatchObject({ isolation: "container" });
        expect(processContainer.leastPrivilege).toBe(true);
        expect(processContainer.capabilities).toEqual([]);
        expect(network.enforcementMode).toBe("both");
        expect(env).toContain("SystemRoot=C:\\Windows");
        expect(env).toContain("SystemDrive=C:");
        expect(env).toContain("USERPROFILE=C:\\Users\\openclaw");
        expect(env).toContain("APPDATA=C:\\Users\\openclaw\\AppData\\Roaming");
        expect(env).toContain("LOCALAPPDATA=C:\\Users\\openclaw\\AppData\\Local");
        expect(env).toContain("ProgramData=C:\\ProgramData");
        expect(env).toContain("ProgramFiles(x86)=C:\\Program Files (x86)");
        expect(env).toContain("NUMBER_OF_PROCESSORS=8");
        expect(env).toContain("CUSTOM_ENV=caller");
        expect(env).toContain("comspec=C:\\Tools\\custom-cmd.exe");
        expect(env.filter((entry) => entry.toLowerCase().startsWith("comspec="))).toHaveLength(1);
        expect(env.some((entry) => entry.startsWith("OPENCLAW_MXC_SECRET_TEST="))).toBe(false);
      },
    );
  });

  test("buildExecSpec preserves PTY mode in launcher options", async () => {
    const handle = createMxcSandboxBackendHandle(baseParams);
    const spec = await handle.buildExecSpec({
      command: "echo hello",
      env: {},
      usePty: true,
    });

    expect(decodePayload(spec.argv).options).toEqual({
      debug: false,
      executablePath: "mxc-test-binary",
    });
    await handle.finalizeExec?.({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      token: spec.finalizeToken,
    });
  });

  test("Windows process containment keeps internetClient for default network access", async () => {
    const handle = createMxcSandboxBackendHandle({
      ...baseParams,
      workdir: baseParams.workdir,
      platform: "win32",
      config: { ...baseConfig, network: "default" },
    });
    const spec = await handle.buildExecSpec({ command: "echo hello", env: {}, usePty: false });

    const cfg = decodeContainerConfig(spec.argv);
    const processContainer = objectField(cfg, "processContainer");
    const network = objectField(cfg, "network");
    expect(processContainer.capabilities).toEqual(["internetClient"]);
    expect(network.defaultPolicy).toBe("allow");
    expect(network.enforcementMode).toBe("both");
  });

  test("Windows process containment caps long AppContainer names", async () => {
    const handle = createMxcSandboxBackendHandle({
      ...baseParams,
      platform: "win32",
      runtimeId: `openclaw-mxc-${"a".repeat(80)}-12345678`,
    });
    const spec = await handle.buildExecSpec({ command: "echo hello", env: {}, usePty: false });

    const processContainer = objectField(decodeContainerConfig(spec.argv), "processContainer");
    expect(String(processContainer.name).length).toBeLessThanOrEqual(64);
  });

  test("buildExecSpec passes configured MXC binary path to the launcher options", async () => {
    const handle = createMxcSandboxBackendHandle({
      ...baseParams,
      config: { ...baseConfig, mxcBinaryPath: "/custom/mxc-exec-mac" },
    });

    const spec = await handle.buildExecSpec({ command: "echo hello", env: {}, usePty: false });

    expect(decodePayload(spec.argv).options).toEqual({
      debug: false,
      executablePath: "mxc-test-binary",
      usePty: false,
    });
  });

  test("non-Windows processcontainer is rejected before MXC can fall through to LXC", async () => {
    const handle = createMxcSandboxBackendHandle({
      ...baseParams,
      config: { ...baseConfig, containment: "processcontainer" },
    });

    await expect(
      handle.buildExecSpec({ command: "echo hello", env: {}, usePty: false }),
    ).rejects.toThrow(/processcontainer.*Windows-only/u);
  });

  test("direct experimental containments are rejected before payload creation", async () => {
    for (const containment of [
      "windows_sandbox",
      "wslc",
      "microvm",
      "seatbelt",
      "isolation_session",
    ] as const) {
      const handle = createMxcSandboxBackendHandle({
        ...baseParams,
        config: { ...baseConfig, containment },
      });

      await expect(
        handle.buildExecSpec({ command: "echo hello", env: {}, usePty: false }),
      ).rejects.toThrow(/not enabled/u);
    }
  });

  test("Windows process containment preserves caller env overrides", async () => {
    const handle = createMxcSandboxBackendHandle({
      ...baseParams,
      workdir: baseParams.workdir,
      platform: "win32",
    });
    const spec = await handle.buildExecSpec({
      command: "echo hello",
      env: { HOME: "/home/test", LANG: "en_US.UTF-8", CUSTOM_VAR: "value" },
      usePty: false,
    });

    const processConfig = objectField(decodeContainerConfig(spec.argv), "process");
    const env = stringArrayField(processConfig, "env");
    expect(env).toContain("HOME=/home/test");
    expect(env).toContain("LANG=en_US.UTF-8");
    expect(env).toContain("CUSTOM_VAR=value");
  });

  test("timeout falls back to the sandbox baseline when config uses defaults", async () => {
    const handle = createMxcSandboxBackendHandle({
      ...baseParams,
      config: resolveConfig({}),
      sandboxPolicy: sandboxPolicyOptions({
        filesystem: {},
        process: { timeoutSeconds: 45 },
      }),
    });
    const spec = await handle.buildExecSpec({ command: "echo hello", env: {}, usePty: false });

    const processConfig = objectField(decodeContainerConfig(spec.argv), "process");
    expect(processConfig.timeout).toBe(45_000);
  });

  test("rejects per-command workdirs outside the sandbox workspace", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "mxc-workspace-"));
    const outsideDir = mkdtempSync(path.join(tmpdir(), "mxc-outside-"));
    try {
      const handle = createMxcSandboxBackendHandle({
        ...baseParams,
        workdir: workspaceDir,
      });

      await expect(
        handle.buildExecSpec({
          command: "echo hello",
          env: {},
          usePty: false,
          workdir: outsideDir,
        }),
      ).rejects.toThrow(/outside the sandbox workspace/u);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("rejects not-yet-created workdirs under the sandbox workspace", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "mxc-workspace-"));
    const nestedWorkdir = path.join(workspaceDir, "new", "child");
    try {
      const handle = createMxcSandboxBackendHandle({
        ...baseParams,
        workdir: workspaceDir,
      });

      await expect(
        handle.buildExecSpec({
          command: "mkdir child",
          env: {},
          usePty: false,
          workdir: nestedWorkdir,
        }),
      ).rejects.toThrow(/MXC sandbox workdir .*new.*child.* does not exist/u);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("rejects symlinked workdirs that resolve outside the sandbox workspace", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "mxc-workspace-"));
    const outsideDir = mkdtempSync(path.join(tmpdir(), "mxc-outside-"));
    const linkPath = path.join(workspaceDir, "outside-link");
    try {
      try {
        symlinkSync(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");
      } catch {
        return;
      }
      const handle = createMxcSandboxBackendHandle({
        ...baseParams,
        workdir: workspaceDir,
      });

      await expect(
        handle.buildExecSpec({
          command: "echo hello",
          env: {},
          usePty: false,
          workdir: linkPath,
        }),
      ).rejects.toThrow(/outside the sandbox workspace/u);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("Windows process containment drops missing filesystem entries before DACL fallback", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "mxc-win-dacl-workdir-"));
    const existingPathWithSpace = mkdtempSync(path.join(workdir, "secret dir "));
    const existingFile = path.join(workdir, "secret file.txt");
    const missingPath = path.join(workdir, "missing-secret");
    writeFileSync(existingFile, "denied file contents");
    try {
      const handle = createMxcSandboxBackendHandle({
        ...baseParams,
        workdir,
        platform: "win32",
        config: {
          ...baseConfig,
          readwritePaths: [missingPath, existingPathWithSpace],
        },
        sandboxPolicy: sandboxPolicyOptions({
          filesystem: {
            additionalDeniedPaths: [missingPath, existingPathWithSpace, existingFile],
            additionalReadonlyPaths: [missingPath, existingPathWithSpace, existingFile],
          },
        }),
      });
      const spec = await handle.buildExecSpec({ command: "echo hello", env: {}, usePty: false });

      const filesystem = objectField(decodeContainerConfig(spec.argv), "filesystem");
      const readwrite = stringArrayField(filesystem, "readwritePaths");
      const readonly = stringArrayField(filesystem, "readonlyPaths");
      const denied = stringArrayField(filesystem, "deniedPaths");
      expect(readwrite).toContain(path.resolve(workdir));
      expect(readwrite).toContain(path.resolve(existingPathWithSpace));
      expect(readwrite).not.toContain(path.resolve(missingPath));
      expect(readwrite).not.toContain(missingPath);
      expect(readonly).toContain(existingPathWithSpace);
      expect(readonly).toContain(existingFile);
      expect(readonly).not.toContain(missingPath);
      expect(denied).toContain(existingPathWithSpace);
      expect(denied).toContain(existingFile);
      expect(denied).not.toContain(missingPath);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("runShellCommand propagates fs-bridge positional args on POSIX command lines", async () => {
    const handle = createMxcSandboxBackendHandle(baseParams);
    await handle.runShellCommand({
      script: 'set -eu\nprintf "%s|%s\\n" "$1" "$2"',
      args: ["/workspace/file.txt", "0"],
      stdin: "",
      allowFailure: false,
    });

    const [, args] = execFileMock.mock.calls[0] as unknown as [string, string[]];
    const processConfig = objectField(decodeConfigBase64Argv(args), "process");
    expect(processConfig.commandLine).toContain("/bin/sh -c ");
    expect(processConfig.commandLine).not.toContain("/bin/sh -lc ");
    expect(processConfig.commandLine).toContain("'openclaw-sandbox-fs'");
    expect(processConfig.commandLine).toContain("'/workspace/file.txt' '0'");
  });

  test("runShellCommand uses curated Windows env and passes stdin through unchanged", async () => {
    await withProcessEnv(
      {
        SystemRoot: "C:\\Windows",
        SystemDrive: "C:",
        USERPROFILE: "C:\\Users\\openclaw",
        OPENCLAW_MXC_SECRET_TEST: "do-not-leak",
      },
      async () => {
        let bridgeScript: string | undefined;
        execFileMock.mockImplementationOnce(
          (
            _binaryPath: string,
            args: readonly string[],
            _options: unknown,
            callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
          ) => {
            const processConfig = objectField(decodeConfigBase64Argv(args), "process");
            const commandLine = String(processConfig.commandLine);
            const commandFile = /""([^"]+\.cmd)"/u.exec(commandLine)?.[1];
            expect(commandFile).toEqual(expect.any(String));
            bridgeScript = readFileSync(commandFile ?? "", "utf-8");
            callback(null, Buffer.from(""), Buffer.alloc(0));
            return { stdin: { end: stdinEndMock } };
          },
        );
        const handle = createMxcSandboxBackendHandle({
          ...baseParams,
          workdir: baseParams.workdir,
          platform: "win32",
        });

        await handle.runShellCommand({
          script: "type con",
          args: ["C:\\workspace\\%USERPROFILE%\\file.txt", "0"],
          stdin: "shell-input",
          allowFailure: false,
        });

        const [, args] = execFileMock.mock.calls[0] as unknown as [string, string[]];
        const processConfig = objectField(decodeConfigBase64Argv(args), "process");
        const env = stringArrayField(processConfig, "env");
        const commandLine = String(processConfig.commandLine);
        expect(bridgeScript?.startsWith("@echo off\r\ntype con")).toBe(true);
        expect(commandLine).toMatch(/ \/c ""[^"]*\.openclaw-mxc-cmd-[^"]+\.cmd" /u);
        expect(commandLine).toContain(".cmd");
        expect(commandLine).toContain('"C:\\workspace\\%%USERPROFILE%%\\file.txt" "0"');
        expect(env).toContain("SystemRoot=C:\\Windows");
        expect(env).toContain("SystemDrive=C:");
        expect(env).toContain("USERPROFILE=C:\\Users\\openclaw");
        expect(env.some((entry) => entry.startsWith("OPENCLAW_MXC_SECRET_TEST="))).toBe(false);
        expect(stdinEndMock).toHaveBeenCalledWith(Buffer.from("shell-input", "utf-8"));
      },
    );
  });

  test("runShellCommand passes AbortSignal to the MXC child process", async () => {
    const handle = createMxcSandboxBackendHandle(baseParams);
    const controller = new AbortController();

    await handle.runShellCommand({
      script: "true",
      stdin: "",
      allowFailure: false,
      signal: controller.signal,
    });

    const call = execFileMock.mock.calls[0] as unknown as [
      string,
      string[],
      { signal?: AbortSignal },
    ];
    const options = call[2];
    expect(options.signal).toBe(controller.signal);
  });

  test("runShellCommand reports executor failures when allowed", async () => {
    execFileMock.mockImplementationOnce(
      (
        _binaryPath: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
      ) => {
        const error = new Error("failed") as Error & {
          stdout: Buffer;
          stderr: Buffer;
          status: number;
        };
        error.stdout = Buffer.from("out");
        error.stderr = Buffer.from("err");
        error.status = 7;
        callback(error, error.stdout, error.stderr);
        return { stdin: { end: stdinEndMock } };
      },
    );
    const handle = createMxcSandboxBackendHandle(baseParams);

    await expect(
      handle.runShellCommand({ script: "exit 7", stdin: "", allowFailure: true }),
    ).resolves.toEqual({ stdout: Buffer.from("out"), stderr: Buffer.from("err"), code: 7 });
  });
});

describe("mxcSandboxBackendManager", () => {
  test("describeRuntime returns running=true", async () => {
    const info = await mxcSandboxBackendManager.describeRuntime({
      entry: {} as never,
      config: {} as never,
    });
    expect(info.running).toBe(true);
    expect(info.configLabelMatch).toBe(true);
  });

  test("removeRuntime completes without error", async () => {
    await expect(
      mxcSandboxBackendManager.removeRuntime({
        entry: {} as never,
        config: {} as never,
      }),
    ).resolves.toBeUndefined();
  });
});
