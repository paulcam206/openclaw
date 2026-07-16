// Per-session cache for callback-independent media tool factories (image, PDF).
// Generated-media tools (image/video/music) depend on per-turn onYield callbacks,
// so they are intentionally excluded and rebuilt each turn; see createOpenClawTools.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerSecretsRuntimeStateClearHook } from "../secrets/runtime-state.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { resolveOptionalMediaToolFactoryPlan } from "./openclaw-tools.media-factory-plan.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

export type MediaToolBundle = {
  imageTool: AnyAgentTool | null;
  pdfTool: AnyAgentTool | null;
};

type MediaToolBundleCacheEntry = {
  key: string;
  bundle: MediaToolBundle;
};

const MEDIA_TOOL_BUNDLE_CACHE_MAX_ENTRIES = 64;
const mediaToolBundleCache = new Map<string, MediaToolBundleCacheEntry>();
let nextMediaToolObjectToken = 1;
const mediaToolObjectTokens = new WeakMap<object, number>();

function mediaToolObjectToken(value: unknown): number | null {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return null;
  }
  const existing = mediaToolObjectTokens.get(value);
  if (existing !== undefined) {
    return existing;
  }
  const next = nextMediaToolObjectToken;
  nextMediaToolObjectToken += 1;
  mediaToolObjectTokens.set(value, next);
  return next;
}

function sortedListKey(values?: readonly string[]): string {
  return values
    ? [...values].toSorted((left, right) => left.localeCompare(right)).join("\u0000")
    : "";
}

export function buildMediaToolBundleCacheKey(params: {
  imageToolAvailable: boolean;
  optionalMediaTools: ReturnType<typeof resolveOptionalMediaToolFactoryPlan>;
  config?: OpenClawConfig;
  availabilityConfig?: OpenClawConfig;
  authProfileStore?: AuthProfileStore;
  fsPolicy?: ToolFsPolicy;
  sandboxFsBridge?: SandboxFsBridge;
  agentDir?: string;
  workspaceDir?: string;
  sandboxRoot?: string;
  sandboxContainerWorkdir?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  currentChannelId?: string;
  modelHasVision?: boolean;
  pluginToolAllowlist?: string[];
  pluginToolDenylist?: string[];
}): string {
  return JSON.stringify({
    image: params.imageToolAvailable,
    pdf: params.optionalMediaTools.pdf,
    config: mediaToolObjectToken(params.config),
    availabilityConfig: mediaToolObjectToken(params.availabilityConfig),
    authProfileStore: mediaToolObjectToken(params.authProfileStore),
    fsPolicy: mediaToolObjectToken(params.fsPolicy),
    sandboxFsBridge: mediaToolObjectToken(params.sandboxFsBridge),
    agentDir: params.agentDir ?? null,
    workspaceDir: params.workspaceDir ?? null,
    sandboxRoot: params.sandboxRoot ?? null,
    sandboxContainerWorkdir: params.sandboxContainerWorkdir ?? null,
    agentChannel: params.agentChannel ?? null,
    agentAccountId: params.agentAccountId ?? null,
    currentChannelId: params.currentChannelId ?? null,
    modelHasVision: params.modelHasVision === true,
    pluginToolAllowlist: sortedListKey(params.pluginToolAllowlist),
    pluginToolDenylist: sortedListKey(params.pluginToolDenylist),
    fsPolicyWorkspaceOnly: params.fsPolicy?.workspaceOnly === true,
  });
}

export function readMediaToolBundleCache(
  sessionKey: string,
  key: string,
): MediaToolBundle | undefined {
  const entry = mediaToolBundleCache.get(sessionKey);
  if (!entry || entry.key !== key) {
    return undefined;
  }
  mediaToolBundleCache.delete(sessionKey);
  mediaToolBundleCache.set(sessionKey, entry);
  return entry.bundle;
}

export function writeMediaToolBundleCache(
  sessionKey: string,
  key: string,
  bundle: MediaToolBundle,
): void {
  mediaToolBundleCache.delete(sessionKey);
  mediaToolBundleCache.set(sessionKey, { key, bundle });
  while (mediaToolBundleCache.size > MEDIA_TOOL_BUNDLE_CACHE_MAX_ENTRIES) {
    const oldest = mediaToolBundleCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    mediaToolBundleCache.delete(oldest);
  }
}

export function clearMediaToolBundleCache(): void {
  mediaToolBundleCache.clear();
}

registerSecretsRuntimeStateClearHook(clearMediaToolBundleCache);
