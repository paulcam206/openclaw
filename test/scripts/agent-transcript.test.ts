import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const scriptPath = path.join(repoRoot, ".agents/skills/agent-transcript/scripts/agent-transcript");
const { createTempDir } = createScriptTestHarness();

type TranscriptEvent = Record<string, unknown>;

function writeJsonl(file: string, events: TranscriptEvent[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

function runTranscript(
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
  } = {},
): string {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...options.env,
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return result.stdout;
}

function copilotEvents(messages: TranscriptEvent[]): TranscriptEvent[] {
  return [
    {
      type: "session.start",
      data: {
        sessionId: "copilot-session",
        producer: "copilot-agent",
      },
    },
    ...messages,
  ];
}

describe("agent transcript helper", () => {
  it("discovers Copilot sessions from the default local session-state root", () => {
    const home = createTempDir("agent-transcript-home-");
    const sessionFile = path.join(
      home,
      ".copilot",
      "session-state",
      "copilot-session",
      "events.jsonl",
    );
    writeJsonl(
      sessionFile,
      copilotEvents([
        {
          type: "user.message",
          data: {
            content: "Implement portable-copilot-marker in C:\\repo\\openclaw.",
          },
        },
      ]),
    );

    const output = runTranscript(
      ["find", "--query", "portable-copilot-marker", "--cwd", "C:\\repo\\openclaw"],
      {
        env: {
          HOME: home,
          USERPROFILE: home,
        },
      },
    );
    const results = JSON.parse(output) as Array<{
      agent: string;
      file: string;
    }>;

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      agent: "copilot",
      file: sessionFile,
    });
  });

  it("renders visible Copilot dialogue and drops private event data", () => {
    const tempDir = createTempDir("agent-transcript-copilot-");
    const sessionFile = path.join(
      tempDir,
      ".copilot",
      "session-state",
      "copilot-session",
      "events.jsonl",
    );
    writeJsonl(
      sessionFile,
      copilotEvents([
        {
          type: "system.message",
          data: {
            role: "system",
            content: "PRIVATE_SYSTEM_PROMPT",
          },
        },
        {
          type: "user.message",
          data: {
            content: "Please update C:\\Users\\alice\\repo\\src\\index.ts.",
            transformedContent: "PRIVATE_TRANSFORMED_PROMPT",
          },
        },
        {
          type: "assistant.message",
          data: {
            content: "Updated E:/repo/openclaw/src/index.ts.",
            reasoningOpaque: "PRIVATE_REASONING",
            encryptedContent: "PRIVATE_ENCRYPTED_CONTENT",
          },
        },
        {
          type: "tool.execution_start",
          data: {
            toolCallId: "tool-1",
            toolName: "view",
            arguments: {
              path: "C:\\Users\\alice\\repo\\src\\index.ts",
            },
          },
        },
        {
          type: "tool.execution_complete",
          data: {
            toolCallId: "tool-1",
            success: true,
            result: "PRIVATE_TOOL_OUTPUT",
          },
        },
        {
          type: "external_tool.requested",
          data: {
            requestId: "tool-2",
            toolName: "powershell",
            arguments: {
              command: "Get-ChildItem",
            },
          },
        },
        {
          type: "external_tool.completed",
          data: {
            requestId: "tool-2",
          },
        },
      ]),
    );

    const output = runTranscript(["render", "--session", sessionFile]);

    expect(output).toContain("<summary>Redacted copilot session transcript</summary>");
    expect(output).toContain("[user]\nPlease update [LOCAL_PATH].");
    expect(output).toContain("[assistant]\nUpdated [LOCAL_PATH].");
    expect(output).toContain("1 read, 1 execute; raw tool outputs dropped: 2");
    expect(output).not.toContain("PRIVATE_SYSTEM_PROMPT");
    expect(output).not.toContain("PRIVATE_TRANSFORMED_PROMPT");
    expect(output).not.toContain("PRIVATE_REASONING");
    expect(output).not.toContain("PRIVATE_ENCRYPTED_CONTENT");
    expect(output).not.toContain("PRIVATE_TOOL_OUTPUT");
  });

  it("redacts Windows home, drive-qualified, and UNC paths", () => {
    const tempDir = createTempDir("agent-transcript-paths-");
    const sessionFile = path.join(tempDir, "session.jsonl");
    const fakeHome = "C:\\Users\\alice";
    let deeplyNestedPrivateUrl = "http://localhost:3000/admin";
    for (let depth = 0; depth < 5; depth += 1) {
      deeplyNestedPrivateUrl = `https://example.com/callback?next=${encodeURIComponent(deeplyNestedPrivateUrl)}`;
    }
    writeJsonl(sessionFile, [
      {
        type: "user",
        content: [
          `${fakeHome}\\repo\\src\\index.ts`,
          "C:/Users/alice/docs/notes.md",
          "~\\Documents\\secret.txt",
          "~/Documents/secret.txt",
          "C:\\Users\\alice-backup\\private\\notes.txt",
          "C:/Users/alice-backup/private/notes.txt",
          "C:\\Program Files\\OpenClaw\\config.json",
          "D:/tmp/my notes.txt",
          "/home/bob/My Docs",
          "/workspaces/openclaw/src/index.ts",
          "/tmp/my notes.txt",
          "/dev/shm/secret.txt",
          "/proc/self/environ",
          "/run/user/1000/keyring/file.txt",
          "/Library/Application Support/App/config.json",
          "path:/workspaces/openclaw/src/labelled.ts",
          "cwd:/tmp/secret folder/file.txt",
          "//server/share/private.txt",
          "https://example.com/path",
          "https://fcc.gov/",
          "https://fda.gov/",
          "https://[2606:4700:4700::1111]/",
          "http://localhost:3000/app",
          "https://corp-internal-host.local/admin",
          "http://127.0.0.1:18789/status",
          "http://10.0.0.4/admin",
          "http://[::1]:3000/status",
          "http://[fc00::1]:3000/status",
          "https://intranet/dashboard",
          "https://example.com/callback?next=http://localhost:3000/admin",
          "https://example.com/callback?next=https%3A%2F%2F10.0.0.5%2Fadmin",
          deeplyNestedPrivateUrl,
          "file:///tmp/secret.txt",
          "relative/path.txt",
          "foo//bar",
          "Check /api/v1/auth/login and https://example.com/api/v1/auth/login",
          "Keep https://example.com/callback?next=https%3A%2F%2Fdocs.openclaw.ai%2Ftools%2Fskills",
          "Keep this comment with API route: // /api/v1/auth/login",
          "D:/repo/openclaw/src/index.ts",
          "\\\\server\\share\\private\\notes.txt",
        ].join("\n"),
      },
    ]);

    const output = runTranscript(["render", "--session", sessionFile], {
      env: {
        HOME: fakeHome,
        USERPROFILE: fakeHome,
      },
    });

    expect(output).not.toContain(fakeHome);
    expect(output).not.toContain("~\\Documents");
    expect(output).not.toContain("~/Documents");
    expect(output).not.toContain("alice-backup");
    expect(output).not.toContain("repo\\src");
    expect(output).not.toContain("repo/src");
    expect(output).not.toContain("docs/notes");
    expect(output).not.toContain("C:\\Program Files");
    expect(output).not.toContain("my notes.txt");
    expect(output).not.toContain("My Docs");
    expect(output).not.toContain("/workspaces/openclaw");
    expect(output).not.toContain("/tmp/");
    expect(output).not.toContain("/dev/");
    expect(output).not.toContain("/proc/");
    expect(output).not.toContain("/run/");
    expect(output).not.toContain("/Library/");
    expect(output).not.toContain("labelled.ts");
    expect(output).not.toContain("secret folder");
    expect(output).not.toContain("//server/share");
    expect(output).not.toContain("localhost:3000");
    expect(output).not.toContain("corp-internal-host.local");
    expect(output).not.toContain("127.0.0.1");
    expect(output).not.toContain("10.0.0.4");
    expect(output).not.toContain("[::1]");
    expect(output).not.toContain("[fc00::1]");
    expect(output).not.toContain("intranet/dashboard");
    expect(output).not.toContain("next=http://localhost");
    expect(output).not.toContain("10.0.0.5");
    expect(output).not.toContain(
      encodeURIComponent(encodeURIComponent("http://localhost:3000/admin")),
    );
    expect(output).not.toContain("file:///tmp");
    expect(output).not.toContain("D:/repo");
    expect(output).not.toContain("\\\\server\\share");
    expect(output).toContain("https://example.com/path");
    expect(output).toContain("https://fcc.gov/");
    expect(output).toContain("https://fda.gov/");
    expect(output).toContain("https://[2606:4700:4700::1111]/");
    expect(output).toContain("file:[LOCAL_PATH]");
    expect(output).toContain("relative/path.txt");
    expect(output).toContain("foo//bar");
    expect(output).toContain("/api/v1/auth/login");
    expect(output).toContain("https://example.com/api/v1/auth/login");
    expect(output).toContain(
      "https://example.com/callback?next=https%3A%2F%2Fdocs.openclaw.ai%2Ftools%2Fskills",
    );
    expect(output).toContain("// /api/v1/auth/login");
    expect(output.match(/\[HOME_PATH\]/g)).toHaveLength(4);
    expect(output.match(/\[LOCAL_PATH\]/g)).toHaveLength(17);
    expect(output.match(/\[PRIVATE_URL\]/g)).toHaveLength(10);
  });

  it("preserves existing Codex event dialogue and tool summaries", () => {
    const tempDir = createTempDir("agent-transcript-codex-");
    const sessionFile = path.join(tempDir, "session.jsonl");
    writeJsonl(sessionFile, [
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Existing user message",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Existing assistant message",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "apply_patch",
          arguments: "{}",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          output: "PRIVATE_EXISTING_TOOL_OUTPUT",
        },
      },
    ]);

    const output = runTranscript(["render", "--session", sessionFile]);

    expect(output).toContain("<summary>Redacted codex session transcript</summary>");
    expect(output).toContain("[user]\nExisting user message");
    expect(output).toContain("[assistant]\nExisting assistant message");
    expect(output).toContain("1 write; raw tool outputs dropped: 1");
    expect(output).not.toContain("PRIVATE_EXISTING_TOOL_OUTPUT");
  });
});
