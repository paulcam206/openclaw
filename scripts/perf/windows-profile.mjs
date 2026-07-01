#!/usr/bin/env node
// Coordinates reproducible Windows-oriented performance captures for OpenClaw.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatErrorMessage } from "../lib/error-format.mjs";
import { terminateManagedChild } from "../lib/managed-child-process.mjs";
import { parseNonNegativeInt, parsePositiveInt } from "../lib/numeric-options.mjs";
import { createPnpmRunnerSpawnSpec } from "../pnpm-runner.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const defaultWprpPath = path.join(scriptDir, "openclaw-windows.wprp");
const defaultOutputRoot = path.join(repoRoot, ".artifacts", "perf", "windows");
const DEFAULT_RUNS = 3;
const DEFAULT_WARMUP = 1;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const COMMAND_TAIL_BYTES = 128 * 1024;
const DEFAULT_WPR_PROFILE = "OpenClawWindowsDeepCompat";

const PRESETS = {
  quick: ["cli-startup"],
  build: ["build", "ui-build"],
  runtime: ["onboarding", "gateway-startup", "cli-startup", "tui-gateway-pty"],
  source: ["gateway-startup", "extension-memory", "cli-startup", "sqlite-smoke"],
  full: [
    "install",
    "full-build",
    "onboarding",
    "gateway-startup",
    "cli-startup",
    "tui-gateway-pty",
    "extension-memory",
    "sqlite-smoke",
  ],
};

const SCENARIO_DESCRIPTIONS = {
  install: "Run pnpm install in the current checkout.",
  build: "Run pnpm build.",
  "ui-build": "Run pnpm ui:build.",
  "full-build": "Run pnpm build followed by pnpm ui:build.",
  onboarding: "Run non-interactive onboarding in an isolated temp home/state.",
  "gateway-startup": "Run existing gateway startup CPU scenarios.",
  "cli-startup": "Run existing CLI startup benchmark cases.",
  "tui-gateway-pty": "Run a gateway-backed TUI first-result smoke with a mocked model endpoint.",
  "tui-local-pty": "Run the local TUI PTY first-result smoke with a mocked model endpoint.",
  "extension-memory": "Run bundled plugin import memory profiling.",
  "sqlite-smoke": "Run the SQLite state perf smoke if available.",
};

const ALL_SCENARIOS = Object.keys(SCENARIO_DESCRIPTIONS);

class CliUsageError extends Error {
  name = "CliUsageError";
}

function usage() {
  return `Usage: node scripts/perf/windows-profile.mjs [options]

Runs OpenClaw performance scenarios with optional WPR/ETW capture and writes artifacts.

Options:
  --preset <name>          Scenario preset: ${Object.keys(PRESETS).join("|")} (default: quick)
  --scenario <id>          Scenario id (repeatable; use "all" for every scenario)
  --output-dir <dir>       Artifact directory (default: .artifacts/perf/windows/<timestamp>)
  --baseline-dir <dir>     Existing artifact directory used for summary comparison when supported
  --runs <n>               Measured runs for reused benchmark scripts (default: ${DEFAULT_RUNS})
  --warmup <n>             Warmup runs for reused benchmark scripts (default: ${DEFAULT_WARMUP})
  --timeout-ms <ms>        Per-command timeout (default: ${DEFAULT_TIMEOUT_MS})
  --wpr                    Capture WPR traces (scenario-scoped by default)
  --wpr-scope <scope>      WPR capture scope: scenario|run (default: scenario)
  --wprp <path>            WPR profile path (default: scripts/perf/openclaw-windows.wprp)
  --wpr-profile <name>     WPR profile name (default: ${DEFAULT_WPR_PROFILE})
  --wpr-filemode           Start WPR in file mode
  --wpr-optional           Continue if WPR cannot start or stop
  --node-prof              Request V8 CPU/heap profiles from supported Node benchmark scripts
  --dry-run                Print/write the scenario plan without executing commands
  --keep-going             Continue after a scenario failure
  --json                   Print final JSON summary
  --help                   Show this text

Scenarios:
${ALL_SCENARIOS.map((id) => `  ${id.padEnd(18)} ${SCENARIO_DESCRIPTIONS[id]}`).join("\n")}
`;
}

function readOptionValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliUsageError(`${flag} requires a value`);
  }
  return value;
}

function normalizeScenarioId(raw) {
  if (raw === "tui-first-result") {
    return "tui-local-pty";
  }
  return raw;
}

export function parseArgs(argv) {
  const options = {
    baselineDir: null,
    dryRun: false,
    json: false,
    keepGoing: false,
    nodeProf: false,
    outputDir: "",
    preset: "quick",
    runs: DEFAULT_RUNS,
    scenarios: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    warmup: DEFAULT_WARMUP,
    wpr: false,
    wprFileMode: false,
    wprOptional: false,
    wprProfile: DEFAULT_WPR_PROFILE,
    wprScope: "scenario",
    wprp: defaultWprpPath,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--baseline-dir":
        options.baselineDir = path.resolve(readOptionValue(argv, index, arg));
        index += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--keep-going":
        options.keepGoing = true;
        break;
      case "--node-prof":
        options.nodeProf = true;
        break;
      case "--output-dir":
        options.outputDir = path.resolve(readOptionValue(argv, index, arg));
        index += 1;
        break;
      case "--preset":
        options.preset = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "--runs":
        options.runs = parsePositiveInt(readOptionValue(argv, index, arg), "--runs");
        index += 1;
        break;
      case "--scenario":
        options.scenarios.push(normalizeScenarioId(readOptionValue(argv, index, arg)));
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInt(readOptionValue(argv, index, arg), "--timeout-ms");
        index += 1;
        break;
      case "--warmup":
        options.warmup = parseNonNegativeInt(readOptionValue(argv, index, arg), "--warmup");
        index += 1;
        break;
      case "--wpr":
        options.wpr = true;
        break;
      case "--wpr-filemode":
        options.wprFileMode = true;
        break;
      case "--wpr-optional":
        options.wprOptional = true;
        break;
      case "--wpr-profile":
        options.wprProfile = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "--wpr-scope":
        options.wprScope = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "--wprp":
        options.wprp = path.resolve(readOptionValue(argv, index, arg));
        index += 1;
        break;
      default:
        throw new CliUsageError(`Unknown argument: ${arg}`);
    }
  }

  if (!PRESETS[options.preset]) {
    throw new CliUsageError(`Unknown --preset ${options.preset}`);
  }
  if (options.wprScope !== "scenario" && options.wprScope !== "run") {
    throw new CliUsageError(`Unknown --wpr-scope ${options.wprScope}`);
  }
  const scenarioIds = options.scenarios.length > 0 ? options.scenarios : PRESETS[options.preset];
  options.scenarios = expandScenarioIds(scenarioIds);
  if (!options.outputDir) {
    options.outputDir = path.join(
      defaultOutputRoot,
      new Date().toISOString().replace(/[:.]/g, "-"),
    );
  }
  return options;
}

function expandScenarioIds(ids) {
  const expanded = [];
  for (const id of ids) {
    if (id === "all") {
      expanded.push(...ALL_SCENARIOS);
      continue;
    }
    if (!SCENARIO_DESCRIPTIONS[id]) {
      throw new CliUsageError(`Unknown scenario: ${id}`);
    }
    expanded.push(id);
  }
  return [...new Set(expanded)];
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, value) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readPackageScripts() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).scripts ?? {};
}

function runSyncText(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    error: result.error ? formatErrorMessage(result.error) : null,
    status: result.status ?? (result.error ? 1 : 0),
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function collectMetadata(options) {
  const gitHead = runSyncText("git", ["rev-parse", "HEAD"]).stdout.trim();
  const gitBranch = runSyncText("git", ["branch", "--show-current"]).stdout.trim();
  const pnpmVersion = runSyncText("pnpm", ["--version"]).stdout.trim();
  return {
    capturedAt: new Date().toISOString(),
    command: process.argv.slice(2),
    cwd: repoRoot,
    env: {
      OPENCLAW_HOME: process.env.OPENCLAW_HOME ?? null,
      OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR ?? null,
      OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH ?? null,
      PNPM_HOME: process.env.PNPM_HOME ?? null,
      PNPM_STORE_DIR: process.env.PNPM_STORE_DIR ?? null,
    },
    git: {
      branch: gitBranch || null,
      head: gitHead || null,
    },
    node: process.version,
    options,
    os: {
      arch: os.arch(),
      cpus: os.cpus().length,
      freemem: os.freemem(),
      platform: os.platform(),
      release: os.release(),
      totalmem: os.totalmem(),
      type: os.type(),
      version: typeof os.version === "function" ? os.version() : null,
    },
    pnpm: pnpmVersion || null,
  };
}

function appendTail(current, chunk) {
  const next = current + String(chunk);
  return next.length > COMMAND_TAIL_BYTES ? next.slice(next.length - COMMAND_TAIL_BYTES) : next;
}

function quoteCommand(command, args) {
  return [command, ...args]
    .map((part) => (/[\s"`]/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

async function runSpawnStep(ctx, step) {
  if (ctx.options.dryRun) {
    return {
      command: quoteCommand(step.command, step.args),
      dryRun: true,
      id: step.id,
      label: step.label,
      status: 0,
    };
  }

  mkdirp(ctx.logDir);
  const stdoutPath = path.join(ctx.logDir, `${step.id}.stdout.log`);
  const stderrPath = path.join(ctx.logDir, `${step.id}.stderr.log`);
  const stdout = fs.createWriteStream(stdoutPath, { flags: "a" });
  const stderr = fs.createWriteStream(stderrPath, { flags: "a" });
  let outputTail = "";
  let timedOut = false;
  const startedAt = performance.now();
  const child = spawn(step.command, step.args, {
    cwd: step.cwd ?? repoRoot,
    env: step.env ?? process.env,
    shell: step.shell ?? false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: step.windowsVerbatimArguments,
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    terminateManagedChild(child, "SIGTERM");
  }, step.timeoutMs ?? ctx.options.timeoutMs);
  timeout.unref?.();

  child.stdout.on("data", (chunk) => {
    outputTail = appendTail(outputTail, chunk);
    stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    outputTail = appendTail(outputTail, chunk);
    stderr.write(chunk);
  });

  const close = await new Promise((resolve) => {
    child.once("error", (error) => {
      resolve({ error: formatErrorMessage(error), signal: null, status: 1 });
    });
    child.once("close", (status, signal) => {
      resolve({ error: null, signal, status: status ?? (signal ? 1 : 0) });
    });
  });
  clearTimeout(timeout);
  await Promise.all([
    new Promise((resolve) => {
      stdout.end(() => {
        resolve();
      });
    }),
    new Promise((resolve) => {
      stderr.end(() => {
        resolve();
      });
    }),
  ]);
  const endedAt = performance.now();
  return {
    command: quoteCommand(step.command, step.args),
    durationMs: endedAt - startedAt,
    error: close.error,
    id: step.id,
    label: step.label,
    outputTail,
    pid: child.pid ?? null,
    signal: close.signal,
    status: timedOut ? 124 : close.status,
    stderrPath: path.relative(ctx.outputDir, stderrPath),
    stdoutPath: path.relative(ctx.outputDir, stdoutPath),
    timedOut,
  };
}

async function runStep(ctx, step) {
  console.error(`[windows-perf] start ${step.label}`);
  const result = await runSpawnStep(ctx, step);
  const ok = result.status === 0;
  console.error(
    `[windows-perf] ${ok ? "pass" : "fail"} ${step.label}${
      result.durationMs === undefined ? "" : ` (${Math.round(result.durationMs)}ms)`
    }`,
  );
  return result;
}

function waitForCondition(params) {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const value = await params.read();
        if (value) {
          resolve(value);
          return;
        }
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (performance.now() - startedAt >= params.timeoutMs) {
        const timeoutError = params.onTimeout();
        reject(timeoutError instanceof Error ? timeoutError : new Error(String(timeoutError)));
        return;
      }
      setTimeout(tick, 25);
    };
    void tick();
  });
}

async function startPtyProcess(command, args, options) {
  const nodePty = await import("@lydell/node-pty");
  const spawnPty = nodePty.spawn ?? nodePty.default?.spawn;
  if (typeof spawnPty !== "function") {
    throw new Error("@lydell/node-pty spawn export is unavailable");
  }
  let output = "";
  let exitEvent = null;
  const pty = spawnPty(command, args, {
    cols: 100,
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      TERM: "xterm-256color",
    },
    name: "xterm-256color",
    rows: 30,
  });
  pty.onData((data) => {
    output += data;
    if (options.mirrorPath) {
      fs.appendFileSync(options.mirrorPath, data, "utf8");
    }
  });
  pty.onExit((event) => {
    exitEvent = event;
  });
  return {
    dispose: () => {
      try {
        pty.kill();
      } catch {
        // PTY may already be closed.
      }
    },
    output: () => output,
    waitForExit: (timeoutMs = 10_000) =>
      waitForCondition({
        timeoutMs,
        read: () => exitEvent,
        onTimeout: () => new Error(`PTY did not exit within ${timeoutMs}ms\n${output}`),
      }),
    waitForOutput: (needle, timeoutMs) =>
      waitForCondition({
        timeoutMs,
        read: () => (output.includes(needle) ? output : null),
        onTimeout: () =>
          new Error(`PTY output did not include ${JSON.stringify(needle)}\n${output}`),
      }),
    write: (data) => {
      pty.write(data);
    },
  };
}

function pnpmStep(id, label, pnpmArgs, ctx, overrides = {}) {
  const spec = createPnpmRunnerSpawnSpec({
    cwd: repoRoot,
    env: overrides.env ?? ctx.env,
    pnpmArgs,
    stdio: "pipe",
  });
  return {
    args: spec.args,
    command: spec.command,
    cwd: repoRoot,
    env: spec.options.env,
    id,
    label,
    shell: spec.options.shell,
    timeoutMs: overrides.timeoutMs,
    windowsVerbatimArguments: spec.options.windowsVerbatimArguments,
  };
}

function nodeStep(id, label, args, ctx, overrides = {}) {
  return {
    args,
    command: process.execPath,
    cwd: repoRoot,
    env: overrides.env ?? ctx.env,
    id,
    label,
    timeoutMs: overrides.timeoutMs,
  };
}

function createScenarioEnv(extra = {}) {
  return {
    ...process.env,
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: process.env.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN ?? "false",
    OPENCLAW_TEST_DISABLE_UPDATE_CHECK: process.env.OPENCLAW_TEST_DISABLE_UPDATE_CHECK ?? "1",
    ...extra,
  };
}

function createIsolatedOpenClawEnv(ctx, scenarioId) {
  const root = path.join(ctx.outputDir, "state", scenarioId);
  const home = path.join(root, "home");
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const workspace = path.join(root, "workspace");
  mkdirp(stateDir);
  mkdirp(home);
  mkdirp(workspace);
  return {
    env: createScenarioEnv({
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
    }),
    paths: { configPath, home, root, stateDir, workspace },
  };
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJsonResponse(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
    "content-type": "application/json; charset=utf-8",
  });
  res.end(text);
}

function writeResponsesSse(res, text) {
  const id = "msg_windows_perf_tui";
  const events = [
    {
      type: "response.output_item.added",
      item: { type: "message", id, role: "assistant", content: [], status: "in_progress" },
    },
    {
      type: "response.output_text.delta",
      item_id: id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: id,
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        id,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_windows_perf_tui",
        status: "completed",
        output: [
          {
            type: "message",
            id,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  res.writeHead(200, {
    "cache-control": "no-store",
    connection: "keep-alive",
    "content-length": Buffer.byteLength(body),
    "content-type": "text/event-stream",
  });
  res.end(body);
}

async function startMockModelServer(replyText) {
  const requests = [];
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
          writeJsonResponse(res, 200, { ok: true });
          return;
        }
        if (req.method === "GET" && url.pathname === "/v1/models") {
          writeJsonResponse(res, 200, { data: [{ id: "gpt-5.5", object: "model" }] });
          return;
        }
        if (req.method === "POST") {
          const raw = await readRequestBody(req);
          const body = raw ? JSON.parse(raw) : {};
          requests.push({ body, method: req.method, path: url.pathname });
          if (url.pathname === "/v1/responses" || url.pathname === "/responses") {
            writeResponsesSse(res, replyText);
            return;
          }
        }
        writeJsonResponse(res, 404, { error: "not found" });
      } catch (error) {
        writeJsonResponse(res, 500, { error: formatErrorMessage(error) });
      }
    })();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock model server did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests: () => requests,
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          resolve();
        });
      }),
  };
}

function buildTuiGatewayConfig(params) {
  return {
    plugins: {
      enabled: false,
      slots: {
        memory: "none",
      },
    },
    agents: {
      defaults: {
        workspace: params.workspaceDir,
        model: { primary: "tui-pty-mock/gpt-5.5" },
        models: {
          "tui-pty-mock/gpt-5.5": { agentRuntime: { id: "openclaw" } },
        },
        skills: [],
        skipBootstrap: true,
      },
      list: [
        {
          id: "main",
          default: true,
          skills: [],
          model: { primary: "tui-pty-mock/gpt-5.5" },
        },
      ],
    },
    tools: {
      profile: "minimal",
    },
    models: {
      mode: "replace",
      providers: {
        "tui-pty-mock": {
          baseUrl: `${params.providerBaseUrl}/v1`,
          apiKey: "test",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "gpt-5.5",
              name: "gpt-5.5",
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
    gateway: {
      mode: "local",
      port: params.gatewayPort,
      bind: "loopback",
      auth: { mode: "token", token: params.gatewayToken },
      controlUi: { enabled: false },
      tailscale: { mode: "off" },
    },
    browser: { enabled: false },
    discovery: { mdns: { mode: "off" } },
  };
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function runCommandSequenceScenario(ctx, scenarioId, steps) {
  const stepResults = [];
  for (const step of steps) {
    const result = await runStep(ctx, step);
    stepResults.push(result);
    if (result.status !== 0) {
      break;
    }
  }
  return {
    id: scenarioId,
    status: stepResults.every((step) => step.status === 0) ? "passed" : "failed",
    steps: stepResults,
  };
}

async function runInstall(ctx) {
  return await runCommandSequenceScenario(ctx, "install", [
    pnpmStep("install", "pnpm install", ["install"], ctx),
  ]);
}

async function runBuild(ctx) {
  return await runCommandSequenceScenario(ctx, "build", [
    pnpmStep("build", "pnpm build", ["build"], ctx),
  ]);
}

async function runUiBuild(ctx) {
  return await runCommandSequenceScenario(ctx, "ui-build", [
    pnpmStep("ui-build", "pnpm ui:build", ["ui:build"], ctx),
  ]);
}

async function runFullBuild(ctx) {
  return await runCommandSequenceScenario(ctx, "full-build", [
    pnpmStep("full-build-build", "pnpm build", ["build"], ctx),
    pnpmStep("full-build-ui", "pnpm ui:build", ["ui:build"], ctx),
  ]);
}

async function runOnboarding(ctx) {
  const isolated = createIsolatedOpenClawEnv(ctx, "onboarding");
  const port = await reservePort();
  const args = [
    "openclaw",
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--mode",
    "local",
    "--auth-choice",
    "skip",
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(port),
    "--gateway-auth",
    "token",
    "--gateway-token",
    "openclaw-perf-token",
    "--skip-daemon",
    "--skip-health",
    "--skip-channels",
    "--skip-skills",
    "--skip-bootstrap",
    "--skip-search",
    "--skip-ui",
    "--skip-hooks",
    "--workspace",
    isolated.paths.workspace,
    "--json",
  ];
  return await runCommandSequenceScenario(ctx, "onboarding", [
    pnpmStep("onboarding", "pnpm openclaw onboard --non-interactive", args, ctx, {
      env: isolated.env,
    }),
  ]);
}

async function runGatewayStartup(ctx) {
  const outputDir = path.join(ctx.sourceDir, "gateway-cpu");
  const args = [
    "test:gateway:cpu-scenarios",
    "--",
    "--output-dir",
    outputDir,
    "--runs",
    String(ctx.options.runs),
    "--warmup",
    String(ctx.options.warmup),
    "--startup-timeout-ms",
    String(Math.min(ctx.options.timeoutMs, 120_000)),
    "--skip-qa",
    "--startup-case",
    "default",
    "--startup-case",
    "skipChannels",
    "--startup-case",
    "oneInternalHook",
    "--startup-case",
    "allInternalHooks",
    "--startup-case",
    "fiftyPlugins",
    "--startup-case",
    "fiftyStartupLazyPlugins",
  ];
  return await runCommandSequenceScenario(ctx, "gateway-startup", [
    pnpmStep("gateway-startup", "pnpm test:gateway:cpu-scenarios", args, ctx, {
      env: { ...ctx.env, OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1" },
    }),
  ]);
}

async function runCliStartup(ctx) {
  const args = [
    "--import",
    "tsx",
    "scripts/bench-cli-startup.ts",
    "--preset",
    "startup",
    "--runs",
    String(ctx.options.runs),
    "--warmup",
    String(ctx.options.warmup),
    "--timeout-ms",
    String(Math.min(ctx.options.timeoutMs, 120_000)),
    "--output",
    path.join(ctx.sourceDir, "cli-startup.json"),
    "--json",
  ];
  if (ctx.options.nodeProf) {
    const cpuProfDir = path.join(ctx.outputDir, "node-prof", "cpu");
    const heapProfDir = path.join(ctx.outputDir, "node-prof", "heap");
    mkdirp(cpuProfDir);
    mkdirp(heapProfDir);
    args.push("--cpu-prof-dir", cpuProfDir);
    args.push("--heap-prof-dir", heapProfDir);
  }
  return await runCommandSequenceScenario(ctx, "cli-startup", [
    nodeStep(
      "cli-startup-ensure-build",
      "node scripts/ensure-cli-startup-build.mjs",
      ["scripts/ensure-cli-startup-build.mjs"],
      ctx,
    ),
    nodeStep("cli-startup", "node scripts/bench-cli-startup.ts", args, ctx),
  ]);
}

async function runTuiGatewayPty(ctx) {
  const scenarioId = "tui-gateway-pty";
  const isolated = createIsolatedOpenClawEnv(ctx, scenarioId);
  const gatewayPort = await reservePort();
  const gatewayToken = "openclaw-perf-token";
  const replyText = "WINDOWS_PERF_TUI_GATEWAY_RESPONSE";
  const mockModel = await startMockModelServer(replyText);
  const config = buildTuiGatewayConfig({
    gatewayPort,
    gatewayToken,
    providerBaseUrl: mockModel.baseUrl,
    workspaceDir: isolated.paths.workspace,
  });
  writeJson(isolated.paths.configPath, config);

  const env = createScenarioEnv({
    ...isolated.env,
    OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
    OPENCLAW_GATEWAY_PORT: String(gatewayPort),
  });
  const gatewayLog = path.join(ctx.logDir, `${scenarioId}.gateway.log`);
  const tuiMirrorPath = path.join(ctx.outputDir, `${scenarioId}.ansi`);
  mkdirp(ctx.logDir);
  const gatewayOutput = fs.createWriteStream(gatewayLog, { flags: "a" });
  const gateway = spawn(
    process.execPath,
    [
      "scripts/run-node.mjs",
      "gateway",
      "run",
      "--bind",
      "loopback",
      "--port",
      String(gatewayPort),
      "--auth",
      "token",
      "--token",
      gatewayToken,
      "--allow-unconfigured",
      "--force",
    ],
    {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  gateway.stdout.pipe(gatewayOutput);
  gateway.stderr.pipe(gatewayOutput);
  const startedAt = performance.now();
  let pty = null;
  try {
    await waitForCondition({
      timeoutMs: Math.min(ctx.options.timeoutMs, 120_000),
      read: async () => {
        if (gateway.exitCode !== null) {
          throw new Error(`gateway exited before readiness; see ${gatewayLog}`);
        }
        try {
          const response = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`);
          return response.ok ? true : null;
        } catch {
          return null;
        }
      },
      onTimeout: () => new Error(`gateway did not become healthy; see ${gatewayLog}`),
    });
    pty = await startPtyProcess(
      process.execPath,
      [
        "scripts/run-node.mjs",
        "tui",
        "--url",
        `ws://127.0.0.1:${gatewayPort}`,
        "--token",
        gatewayToken,
        "--message",
        "send the Windows perf gateway response",
        "--timeout-ms",
        "60000",
      ],
      {
        cwd: repoRoot,
        env,
        mirrorPath: tuiMirrorPath,
      },
    );
    await pty.waitForOutput("gateway connected", Math.min(ctx.options.timeoutMs, 120_000));
    await waitForCondition({
      timeoutMs: Math.min(ctx.options.timeoutMs, 120_000),
      read: () => (mockModel.requests().length > 0 ? true : null),
      onTimeout: () =>
        new Error(
          `mock model server did not receive a TUI request\nrequests=${JSON.stringify(
            mockModel.requests(),
            null,
            2,
          )}\n${pty.output()}`,
        ),
    });
    await pty.waitForOutput(replyText, Math.min(ctx.options.timeoutMs, 120_000));
    pty.write("/exit\r");
    const exit = await pty.waitForExit(10_000);
    const durationMs = performance.now() - startedAt;
    return {
      id: scenarioId,
      status: exit.exitCode === 0 ? "passed" : "failed",
      steps: [
        {
          durationMs,
          gatewayLog: path.relative(ctx.outputDir, gatewayLog),
          id: scenarioId,
          label: "gateway-backed TUI first-result PTY smoke",
          mockRequests: mockModel.requests().length,
          status: exit.exitCode === 0 ? 0 : exit.exitCode,
          tuiMirrorPath: path.relative(ctx.outputDir, tuiMirrorPath),
        },
      ],
    };
  } catch (error) {
    return {
      id: scenarioId,
      status: "failed",
      steps: [
        {
          durationMs: performance.now() - startedAt,
          error: formatErrorMessage(error),
          gatewayLog: path.relative(ctx.outputDir, gatewayLog),
          id: scenarioId,
          label: "gateway-backed TUI first-result PTY smoke",
          mockRequests: mockModel.requests().length,
          status: 1,
          tuiMirrorPath: path.relative(ctx.outputDir, tuiMirrorPath),
        },
      ],
    };
  } finally {
    pty?.dispose();
    terminateManagedChild(gateway, "SIGTERM");
    gateway.stdout?.unpipe(gatewayOutput);
    gateway.stderr?.unpipe(gatewayOutput);
    gatewayOutput.end();
    await mockModel.stop();
  }
}

async function runTuiLocalPty(ctx) {
  const mirrorPath = path.join(ctx.outputDir, "tui-local-pty.ansi");
  const env = createScenarioEnv({
    OPENCLAW_TUI_PTY_INCLUDE_LOCAL: "1",
    OPENCLAW_TUI_PTY_MIRROR_PATH: mirrorPath,
    OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
  });
  return await runCommandSequenceScenario(ctx, "tui-local-pty", [
    nodeStep(
      "tui-local-pty",
      "node scripts/run-vitest.mjs tui local PTY first-result smoke",
      [
        "scripts/run-vitest.mjs",
        "run",
        "--config",
        "test/vitest/vitest.tui-pty.config.ts",
        "src/tui/tui-pty-local.e2e.test.ts",
      ],
      ctx,
      { env, timeoutMs: Math.max(ctx.options.timeoutMs, 180_000) },
    ),
  ]);
}

async function runExtensionMemory(ctx) {
  return await runCommandSequenceScenario(ctx, "extension-memory", [
    pnpmStep(
      "extension-memory",
      "pnpm test:extensions:memory",
      ["test:extensions:memory", "--", "--json", path.join(ctx.sourceDir, "extension-memory.json")],
      ctx,
    ),
  ]);
}

async function runSqliteSmoke(ctx) {
  const scripts = readPackageScripts();
  if (!scripts["test:sqlite:perf:smoke"]) {
    return {
      id: "sqlite-smoke",
      skipped: true,
      status: "skipped",
      steps: [],
    };
  }
  const result = await runCommandSequenceScenario(ctx, "sqlite-smoke", [
    pnpmStep("sqlite-smoke", "pnpm test:sqlite:perf:smoke", ["test:sqlite:perf:smoke"], ctx),
  ]);
  const source = path.join(repoRoot, ".artifacts", "sqlite-perf", "smoke.json");
  const target = path.join(ctx.sourceDir, "sqlite-perf-smoke.json");
  if (fs.existsSync(source)) {
    mkdirp(path.dirname(target));
    fs.copyFileSync(source, target);
  }
  return result;
}

const SCENARIO_RUNNERS = {
  install: runInstall,
  build: runBuild,
  "ui-build": runUiBuild,
  "full-build": runFullBuild,
  onboarding: runOnboarding,
  "gateway-startup": runGatewayStartup,
  "cli-startup": runCliStartup,
  "tui-gateway-pty": runTuiGatewayPty,
  "tui-local-pty": runTuiLocalPty,
  "extension-memory": runExtensionMemory,
  "sqlite-smoke": runSqliteSmoke,
};

function runWpr(command, args) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function startWpr(ctx, etlPath) {
  if (!ctx.options.wpr) {
    return null;
  }
  mkdirp(path.dirname(etlPath));
  const profileSpec = `${path.resolve(ctx.options.wprp)}!${ctx.options.wprProfile}`;
  const args = ["-start", profileSpec];
  if (ctx.options.wprFileMode) {
    args.push("-filemode");
  }
  const result = runWpr("wpr", args);
  if (result.status !== 0 || result.error) {
    const detail = result.error ? formatErrorMessage(result.error) : result.stderr || result.stdout;
    if (ctx.options.wprOptional) {
      console.error(`[windows-perf] warning: WPR start failed: ${detail.trim()}`);
      return { started: false, startError: detail };
    }
    throw new Error(`WPR start failed: ${detail.trim()}`);
  }
  return {
    etlPath,
    profile: ctx.options.wprProfile,
    profileSpec,
    started: true,
  };
}

function stopWpr(ctx, capture) {
  if (!capture?.started) {
    return capture;
  }
  const result = runWpr("wpr", ["-stop", capture.etlPath]);
  if (result.status !== 0 || result.error) {
    const detail = result.error ? formatErrorMessage(result.error) : result.stderr || result.stdout;
    if (ctx.options.wprOptional) {
      return { ...capture, stopError: detail, stopped: false };
    }
    throw new Error(`WPR stop failed: ${detail.trim()}`);
  }
  return { ...capture, stopped: true };
}

function scenarioTracePath(ctx, scenarioId) {
  return path.join(ctx.outputDir, "traces", `${scenarioId}.etl`);
}

async function runScenarioWithOptionalWpr(ctx, scenarioId) {
  let wprCapture = null;
  let wprStopped = false;
  try {
    if (ctx.options.wpr && ctx.options.wprScope === "scenario") {
      wprCapture = startWpr(ctx, scenarioTracePath(ctx, scenarioId));
    }
    const scenarioResult = await SCENARIO_RUNNERS[scenarioId](ctx);
    if (ctx.options.wpr && ctx.options.wprScope === "scenario") {
      wprCapture = stopWpr(ctx, wprCapture);
      wprStopped = true;
      return { ...scenarioResult, wpr: wprCapture };
    }
    return scenarioResult;
  } catch (error) {
    if (ctx.options.wpr && ctx.options.wprScope === "scenario" && !wprStopped) {
      stopWpr(ctx, wprCapture);
    }
    throw error;
  }
}

function writeScenarioPlan(ctx) {
  const plan = {
    dryRun: ctx.options.dryRun,
    outputDir: ctx.outputDir,
    scenarios: ctx.options.scenarios.map((id) => ({
      description: SCENARIO_DESCRIPTIONS[id],
      id,
    })),
    wpr: ctx.options.wpr
      ? {
          fileMode: ctx.options.wprFileMode,
          profile: ctx.options.wprProfile,
          scope: ctx.options.wprScope,
          wprp: path.resolve(ctx.options.wprp),
        }
      : null,
  };
  writeJson(path.join(ctx.outputDir, "plan.json"), plan);
  return plan;
}

function maybeGenerateSourceSummary(ctx) {
  const summaryPath = path.join(ctx.sourceDir, "index.md");
  const gatewaySummary = path.join(ctx.sourceDir, "gateway-cpu", "summary.json");
  const required = [
    path.join(ctx.sourceDir, "gateway-cpu", "gateway-startup-bench.json"),
    path.join(ctx.sourceDir, "cli-startup.json"),
    path.join(ctx.sourceDir, "extension-memory.json"),
    gatewaySummary,
  ];
  if (!required.every((filePath) => fs.existsSync(filePath))) {
    return null;
  }
  const args = [
    "scripts/openclaw-performance-source-summary.mjs",
    "--source-dir",
    ctx.sourceDir,
    "--output",
    summaryPath,
  ];
  if (ctx.options.baselineDir) {
    args.push("--baseline-source-dir", ctx.options.baselineDir);
  }
  try {
    const result = spawnSync(process.execPath, args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      status: result.status ?? (result.error ? 1 : 0),
      stderr: result.stderr,
      stdout: result.stdout,
      summaryPath: fs.existsSync(summaryPath) ? path.relative(ctx.outputDir, summaryPath) : null,
    };
  } catch (error) {
    return {
      error: formatErrorMessage(error),
      status: 1,
      summaryPath: null,
    };
  }
}

export async function runWindowsProfile(options) {
  mkdirp(options.outputDir);
  const outputDir = options.outputDir;
  const ctx = {
    env: createScenarioEnv(),
    logDir: path.join(outputDir, "logs"),
    options,
    outputDir,
    sourceDir: path.join(outputDir, "source"),
  };
  mkdirp(ctx.sourceDir);
  writeJson(path.join(outputDir, "metadata.json"), collectMetadata(options));
  const plan = writeScenarioPlan(ctx);
  if (options.dryRun) {
    return { metadataPath: path.join(outputDir, "metadata.json"), plan, results: [] };
  }

  let runWprCapture;
  const startedAt = performance.now();
  const results = [];
  let sourceSummary;
  try {
    if (options.wpr && options.wprScope === "run") {
      runWprCapture = startWpr(ctx, path.join(ctx.outputDir, "openclaw-windows.etl"));
    }
    for (const scenarioId of options.scenarios) {
      const scenarioResult = await runScenarioWithOptionalWpr(ctx, scenarioId);
      results.push(scenarioResult);
      writeJson(path.join(outputDir, "timings.json"), results);
      if (scenarioResult.status === "failed" && !options.keepGoing) {
        break;
      }
    }
  } finally {
    if (options.wpr && options.wprScope === "run") {
      runWprCapture = stopWpr(ctx, runWprCapture);
    }
    sourceSummary = maybeGenerateSourceSummary(ctx);
  }
  const finishedAt = performance.now();
  const summary = {
    durationMs: finishedAt - startedAt,
    outputDir,
    results,
    sourceSummary,
    status: results.every((result) => result.status === "passed" || result.status === "skipped")
      ? "passed"
      : "failed",
    wpr: options.wpr
      ? {
          scope: options.wprScope,
          ...(options.wprScope === "run" ? { run: runWprCapture } : {}),
          ...(options.wprScope === "scenario"
            ? { traces: results.map((result) => ({ id: result.id, wpr: result.wpr ?? null })) }
            : {}),
        }
      : null,
  };
  writeJson(path.join(outputDir, "summary.json"), summary);
  return summary;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const summary = await runWindowsProfile(options);
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[windows-perf] output: ${summary.outputDir ?? options.outputDir}`);
    if (summary.status) {
      console.log(`[windows-perf] status: ${summary.status}`);
    }
  }
  if (summary.status === "failed") {
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(
    /** @param {unknown} error */
    (error) => {
      if (error instanceof CliUsageError) {
        console.error(error.message);
        console.error("");
        console.error(usage());
        process.exitCode = 2;
        return;
      }
      console.error(formatErrorMessage(error));
      process.exitCode = 1;
    },
  );
}
