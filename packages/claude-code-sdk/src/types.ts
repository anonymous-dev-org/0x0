// ─── Content blocks ──────────────────────────────────────────────────────────

export interface CacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
  scope?: "global";
}

export interface TextBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: CacheControl;
  caller?: { type: string };
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
  cache_control?: CacheControl;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export type AssistantContentBlock = TextBlock | ToolUseBlock | ThinkingBlock;
export type UserContentBlock = TextBlock | ToolResultBlock;

export interface UserMessage {
  role: "user";
  content: string | UserContentBlock[];
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContentBlock[];
}

export type ConversationMessage = UserMessage | AssistantMessage;

// ─── Tool definition ─────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
    [key: string]: unknown;
  };
}

// ─── Inference request/response ──────────────────────────────────────────────

export interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation?: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
}

/** Events emitted by session.send() as the turn streams */
export type TurnEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_use_start"; toolUseId: string; toolName: string }
  | { type: "tool_use_input_delta"; toolUseId: string; partialJson: string }
  | {
      type: "tool_use_done";
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      toolUseId: string;
      toolName: string;
      result: string;
      isError: boolean;
    }
  | { type: "done"; stopReason: string; usage: UsageInfo };

/**
 * Called by the SDK when a tool_use block is complete.
 * Must return the string output of the tool (or throw on error).
 */
export type ToolExecutor = (
  toolName: string,
  input: Record<string, unknown>
) => Promise<string>;

// ─── API endpoint response shapes ────────────────────────────────────────────

export interface FeatureFlag {
  value: unknown;
  on: boolean;
  off: boolean;
  source: string;
  experiment: unknown;
  ruleId: string | null;
}

export type FeatureFlags = Record<string, FeatureFlag>;

export interface GroveStatus {
  grove_enabled: boolean;
  domain_excluded: boolean;
  notice_is_grace_period: boolean;
  notice_reminder_frequency: number;
}

export interface PenguinModeStatus {
  enabled: boolean;
  disabled_reason: string | null;
}

export interface McpServer {
  type: "mcp_server";
  id: string;
  display_name: string;
  url: string;
  created_at: string;
}

export interface StartupContext {
  featureFlags: FeatureFlags;
  grove: GroveStatus;
  penguinMode: PenguinModeStatus;
  mcpServers: McpServer[];
  accountSettings: Record<string, unknown>;
  clientData: Record<string, unknown>;
  /** false if the quota probe got a non-200 or rate-limited */
  quotaOk: boolean;
}

// ─── Client / Session options ─────────────────────────────────────────────────

export interface ClaudeCodeClientOptions {
  /**
   * OAuth bearer token (sk-ant-oat01-...).
   * Injected as `Authorization: Bearer <token>`.
   */
  oauthToken: string;
  /** Defaults to https://api.anthropic.com */
  baseUrl?: string;
  /** Defaults to https://mcp-proxy.anthropic.com */
  mcpProxyBaseUrl?: string;
}

export interface SessionOptions {
  /**
   * Optional system prompt. Injected as a cached system block.
   * If you pass raw `systemBlocks`, this is ignored.
   */
  systemPrompt?: string;
  /**
   * Low-level override: pass the full array of system blocks.
   * The billing header block is always prepended by the SDK.
   */
  systemBlocks?: TextBlock[];
  /** Tool definitions. The SDK passes these on every inference call. */
  tools?: ToolDefinition[];
  /** Defaults to claude-opus-4-6 */
  model?: string;
  /** Defaults to 32000 */
  maxTokens?: number;
  /**
   * Unique stable device ID (SHA-256 hex). Used in metadata.user_id.
   * Defaults to a random 64-char hex string per session.
   */
  deviceId?: string;
  /**
   * Account UUID. Used in metadata.user_id.
   * Defaults to a random UUID per session.
   */
  accountId?: string;
  /**
   * Set to true to disable adaptive thinking (e.g. for cheap one-shot
   * completions). Defaults to false (thinking enabled).
   */
  disableThinking?: boolean;
}
