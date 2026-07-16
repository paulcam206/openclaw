// Verifies createOpenClawTools reuses expensive media factories across stable session turns.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => {
  const makeTool = (name: string) => ({
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(async () => ({ content: [] })),
  });
  return {
    createImageTool: vi.fn(() => makeTool("image")),
    createImageGenerateTool: vi.fn(() => makeTool("image_generate")),
    createVideoGenerateTool: vi.fn(() => makeTool("video_generate")),
    createMusicGenerateTool: vi.fn(() => makeTool("music_generate")),
    createPdfTool: vi.fn(() => makeTool("pdf")),
    resolveImageToolFactoryAvailable: vi.fn(() => true),
    resolveOptionalMediaToolFactoryPlan: vi.fn(() => ({
      imageGenerate: true,
      videoGenerate: true,
      musicGenerate: true,
      pdf: true,
    })),
  };
});

vi.mock("./openclaw-tools.media-factory-plan.js", () => ({
  isToolExplicitlyAllowedByFactoryPolicy: () => false,
  mergeFactoryPolicyList: (...lists: Array<readonly string[] | undefined>) =>
    lists.reduce<string[]>((merged, list) => {
      if (list) {
        merged.push(...list);
      }
      return merged;
    }, []),
  resolveImageToolFactoryAvailable: mocks.resolveImageToolFactoryAvailable,
  resolveOptionalMediaToolFactoryPlan: mocks.resolveOptionalMediaToolFactoryPlan,
}));

vi.mock("./tools/image-tool.js", () => ({
  createImageTool: mocks.createImageTool,
}));

vi.mock("./tools/image-generate-tool.js", () => ({
  createImageGenerateTool: mocks.createImageGenerateTool,
}));

vi.mock("./tools/video-generate-tool.js", () => ({
  createVideoGenerateTool: mocks.createVideoGenerateTool,
}));

vi.mock("./tools/music-generate-tool.js", () => ({
  createMusicGenerateTool: mocks.createMusicGenerateTool,
}));

vi.mock("./tools/pdf-tool.js", () => ({
  createPdfTool: mocks.createPdfTool,
}));

import { createOpenClawTools } from "./openclaw-tools.js";
import { clearMediaToolBundleCache } from "./openclaw-tools.media-cache.js";

const TEST_CONFIG = {
  session: {
    mainKey: "main",
  },
} satisfies OpenClawConfig;

type OpenClawToolsOptions = NonNullable<Parameters<typeof createOpenClawTools>[0]>;

function buildOptions(overrides?: Partial<OpenClawToolsOptions>): OpenClawToolsOptions {
  return {
    agentSessionKey: "agent:main:discord:channel:123",
    agentDir: "agent-dir",
    workspaceDir: "workspace-dir",
    modelHasVision: true,
    config: TEST_CONFIG,
    disableMessageTool: true,
    disablePluginTools: true,
    wrapBeforeToolCallHook: false,
    ...overrides,
  };
}

function expectStaticMediaFactoriesCalled(times: number): void {
  expect(mocks.createImageTool).toHaveBeenCalledTimes(times);
  expect(mocks.createPdfTool).toHaveBeenCalledTimes(times);
}

function expectGeneratedMediaFactoriesCalled(times: number): void {
  expect(mocks.createImageGenerateTool).toHaveBeenCalledTimes(times);
  expect(mocks.createVideoGenerateTool).toHaveBeenCalledTimes(times);
  expect(mocks.createMusicGenerateTool).toHaveBeenCalledTimes(times);
}

describe("createOpenClawTools media-tool bundle cache", () => {
  beforeEach(() => {
    clearMediaToolBundleCache();
    mocks.createImageTool.mockClear();
    mocks.createImageGenerateTool.mockClear();
    mocks.createVideoGenerateTool.mockClear();
    mocks.createMusicGenerateTool.mockClear();
    mocks.createPdfTool.mockClear();
    mocks.resolveImageToolFactoryAvailable.mockClear();
    mocks.resolveOptionalMediaToolFactoryPlan.mockClear();
  });

  it("reuses media factories for stable session tool construction", () => {
    createOpenClawTools(buildOptions());
    createOpenClawTools(buildOptions());
    createOpenClawTools(buildOptions());

    expectStaticMediaFactoriesCalled(1);
    expectGeneratedMediaFactoriesCalled(3);
  });

  it("reuses callback-independent media factories when onYield changes per turn", () => {
    createOpenClawTools(buildOptions({ onYield: () => {} }));
    createOpenClawTools(buildOptions({ onYield: () => {} }));

    expectStaticMediaFactoriesCalled(1);
    expectGeneratedMediaFactoriesCalled(2);
  });

  it("rebuilds media tools when factory inputs change", () => {
    createOpenClawTools(buildOptions({ currentChannelId: "first-channel" }));
    createOpenClawTools(buildOptions({ currentChannelId: "second-channel" }));

    expectStaticMediaFactoriesCalled(2);
    expectGeneratedMediaFactoriesCalled(2);
  });

  it("keeps per-call media factory behavior when no session key is available", () => {
    const firstOptions = buildOptions();
    const secondOptions = buildOptions();
    delete firstOptions.agentSessionKey;
    delete secondOptions.agentSessionKey;

    createOpenClawTools(firstOptions);
    createOpenClawTools(secondOptions);

    expectStaticMediaFactoriesCalled(2);
    expectGeneratedMediaFactoriesCalled(2);
  });
});
