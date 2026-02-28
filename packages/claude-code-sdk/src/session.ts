import { createHash, randomBytes } from "node:crypto";
import { ClaudeCodeClient } from "./client.js";
import type {
  AssistantContentBlock,
  CacheControl,
  ConversationMessage,
  SessionOptions,
  TextBlock,
  ToolDefinition,
  ToolExecutor,
  ToolResultBlock,
  ToolUseBlock,
  TurnEvent,
  UsageInfo,
} from "./types.js";

// ─── SSE parser ──────────────────────────────────────────────────────────────

interface SseEvent {
  event: string;
  data: string;
}

async function* parseSse(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let pendingEvent = "message";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          pendingEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data !== "[DONE]") {
            yield { event: pendingEvent, data };
          }
          pendingEvent = "message";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── Billing header block ─────────────────────────────────────────────────────

function makeBillingBlock(): TextBlock {
  const cch = randomBytes(3).toString("hex").slice(0, 5);
  return {
    type: "text",
    text: `x-anthropic-billing-header: cc_version=sdk; cc_entrypoint=sdk; cch=${cch};`,
  };
}

// ─── Session ─────────────────────────────────────────────────────────────────

export class ClaudeCodeSession {
  private readonly client: ClaudeCodeClient;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly tools: ToolDefinition[];
  private readonly systemBlocks: TextBlock[];
  private readonly userId: string;
  private readonly thinkingDisabled: boolean;
  private readonly skipBillingHeader: boolean;
  readonly sessionId: string;
  private history: ConversationMessage[] = [];

  constructor(client: ClaudeCodeClient, opts: SessionOptions = {}) {
    this.client = client;
    this.model = opts.model ?? "claude-opus-4-6";
    this.maxTokens = opts.maxTokens ?? 32000;
    this.tools = opts.tools ?? [];
    this.thinkingDisabled = opts.disableThinking ?? false;
    this.skipBillingHeader = opts.skipBillingHeader ?? false;

    if (opts.systemBlocks) {
      this.systemBlocks = opts.systemBlocks;
    } else if (opts.systemPrompt) {
      this.systemBlocks = [
        {
          type: "text",
          text: opts.systemPrompt,
          cache_control: { type: "ephemeral", ttl: "1h", scope: "global" },
        },
      ];
    } else {
      this.systemBlocks = [];
    }

    const deviceId =
      opts.deviceId ??
      createHash("sha256").update(randomBytes(32)).digest("hex");
    const accountId = opts.accountId ?? crypto.randomUUID();
    this.sessionId = crypto.randomUUID();
    this.userId = `user_${deviceId}_account_${accountId}_session_${this.sessionId}`;
  }

  get messageCount(): number {
    return this.history.length;
  }

  clearHistory(): void {
    this.history = [];
  }

  /**
   * Send `userMessage` and run the full agentic loop, yielding TurnEvents.
   * If `abort` is provided, the underlying fetch is cancelled on signal.
   */
  async *send(
    userMessage: string,
    executor?: ToolExecutor,
    abort?: AbortSignal
  ): AsyncGenerator<TurnEvent> {
    this.history.push({
      role: "user",
      content: [
        {
          type: "text",
          text: userMessage,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
    });

    yield* this.runAgentLoop(executor, abort);
  }

  /**
   * Resume the loop after manually handling tool results.
   */
  async *sendToolResults(
    results: Array<{ toolUseId: string; content: string; isError?: boolean }>,
    executor?: ToolExecutor,
    abort?: AbortSignal
  ): AsyncGenerator<TurnEvent> {
    const toolResults: ToolResultBlock[] = results.map((r) => ({
      type: "tool_result",
      tool_use_id: r.toolUseId,
      content: r.content,
      is_error: r.isError ?? false,
      cache_control: { type: "ephemeral", ttl: "1h" },
    }));
    this.history.push({ role: "user", content: toolResults });
    yield* this.runAgentLoop(executor, abort);
  }

  // ─── Core agentic loop ────────────────────────────────────────────────────

  private async *runAgentLoop(
    executor?: ToolExecutor,
    abort?: AbortSignal
  ): AsyncGenerator<TurnEvent> {
    while (true) {
      if (abort?.aborted) return;

      const { contentBlocks, stopReason, usage } =
        yield* this.streamOneTurn(abort);

      // Append assistant turn to history (strip thinking blocks)
      const historyBlocks = contentBlocks.filter(
        (b): b is ToolUseBlock | (TextBlock & { type: "text" }) =>
          b.type !== "thinking"
      ) as AssistantContentBlock[];
      this.history.push({ role: "assistant", content: historyBlocks });

      const toolUseBlocks = contentBlocks.filter(
        (b): b is ToolUseBlock => b.type === "tool_use"
      );

      if (toolUseBlocks.length === 0 || !executor) {
        yield { type: "done", stopReason, usage };
        return;
      }

      const toolResults: ToolResultBlock[] = [];
      for (const block of toolUseBlocks) {
        if (abort?.aborted) return;

        let content: string;
        let isError = false;
        try {
          content = await executor(block.name, block.input);
        } catch (err) {
          content = err instanceof Error ? err.message : String(err);
          isError = true;
        }
        yield {
          type: "tool_result",
          toolUseId: block.id,
          toolName: block.name,
          result: content,
          isError,
        };
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content,
          is_error: isError,
          cache_control: { type: "ephemeral", ttl: "1h" } satisfies CacheControl,
        });
      }

      this.history.push({ role: "user", content: toolResults });
    }
  }

  // ─── One inference turn with SSE streaming ────────────────────────────────

  private async *streamOneTurn(abort?: AbortSignal): AsyncGenerator<
    TurnEvent,
    { contentBlocks: AssistantContentBlock[]; stopReason: string; usage: UsageInfo }
  > {
    const response = await this.client.postMessagesStream(
      this.buildRequestBody(),
      abort,
    );
    if (!response.body) throw new Error("Empty response body from /v1/messages");

    const contentBlocks: AssistantContentBlock[] = [];
    const textAccum: Map<number, string> = new Map();
    const thinkingAccum: Map<number, string> = new Map();

    let currentIndex = -1;
    let currentType: string | null = null;
    let currentToolUseId: string | null = null;
    let currentToolName: string | null = null;
    let inputJsonBuffer = "";

    let stopReason = "end_turn";
    let usage: UsageInfo = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };

    for await (const { data } of parseSse(response.body)) {
      if (abort?.aborted) break;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }

      const type = parsed["type"] as string;

      switch (type) {
        case "content_block_start": {
          currentIndex = parsed["index"] as number;
          const block = parsed["content_block"] as Record<string, unknown>;
          currentType = block["type"] as string;

          if (currentType === "text") {
            textAccum.set(currentIndex, "");
          } else if (currentType === "thinking") {
            thinkingAccum.set(currentIndex, "");
          } else if (currentType === "tool_use") {
            currentToolUseId = block["id"] as string;
            currentToolName = block["name"] as string;
            inputJsonBuffer = "";
            yield {
              type: "tool_use_start",
              toolUseId: currentToolUseId,
              toolName: currentToolName,
            };
          }
          break;
        }

        case "content_block_delta": {
          const delta = parsed["delta"] as Record<string, unknown>;
          const deltaType = delta["type"] as string;

          if (deltaType === "text_delta") {
            const text = delta["text"] as string;
            textAccum.set(currentIndex, (textAccum.get(currentIndex) ?? "") + text);
            yield { type: "text_delta", delta: text };
          } else if (deltaType === "thinking_delta") {
            const thinking = delta["thinking"] as string;
            thinkingAccum.set(
              currentIndex,
              (thinkingAccum.get(currentIndex) ?? "") + thinking
            );
            yield { type: "thinking_delta", delta: thinking };
          } else if (deltaType === "input_json_delta") {
            const partial = delta["partial_json"] as string;
            inputJsonBuffer += partial;
            if (currentToolUseId) {
              yield {
                type: "tool_use_input_delta",
                toolUseId: currentToolUseId,
                partialJson: partial,
              };
            }
          }
          break;
        }

        case "content_block_stop": {
          if (currentType === "text") {
            contentBlocks[currentIndex] = {
              type: "text",
              text: textAccum.get(currentIndex) ?? "",
            };
          } else if (currentType === "thinking") {
            contentBlocks[currentIndex] = {
              type: "thinking",
              thinking: thinkingAccum.get(currentIndex) ?? "",
            };
          } else if (
            currentType === "tool_use" &&
            currentToolUseId &&
            currentToolName
          ) {
            let input: Record<string, unknown>;
            try {
              input = JSON.parse(inputJsonBuffer || "{}") as Record<string, unknown>;
            } catch {
              input = {};
            }
            const toolBlock: ToolUseBlock = {
              type: "tool_use",
              id: currentToolUseId,
              name: currentToolName,
              input,
              cache_control: { type: "ephemeral", ttl: "1h" },
            };
            contentBlocks[currentIndex] = toolBlock;
            yield {
              type: "tool_use_done",
              toolUseId: currentToolUseId,
              toolName: currentToolName,
              input,
            };
          }

          currentToolUseId = null;
          currentToolName = null;
          inputJsonBuffer = "";
          break;
        }

        case "message_delta": {
          const delta = parsed["delta"] as Record<string, unknown>;
          stopReason = (delta["stop_reason"] as string) ?? "end_turn";
          const u = parsed["usage"] as Record<string, unknown> | undefined;
          if (u) {
            usage = {
              input_tokens: (u["input_tokens"] as number) ?? 0,
              output_tokens: (u["output_tokens"] as number) ?? 0,
              cache_creation_input_tokens:
                (u["cache_creation_input_tokens"] as number) ?? 0,
              cache_read_input_tokens:
                (u["cache_read_input_tokens"] as number) ?? 0,
            };
          }
          break;
        }
      }
    }

    return {
      contentBlocks: contentBlocks.filter(Boolean),
      stopReason,
      usage,
    };
  }

  // ─── Request body ──────────────────────────────────────────────────────────

  private buildRequestBody(): Record<string, unknown> {
    const thinking = this.thinkingDisabled
      ? { type: "disabled" }
      : { type: "adaptive" };

    return {
      model: this.model,
      max_tokens: this.maxTokens,
      stream: true,
      thinking,
      // context_management only needed when thinking is active (strips thinking
      // blocks between turns to prevent context bloat)
      ...(this.thinkingDisabled
        ? {}
        : { context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] } }),
      system: this.skipBillingHeader
        ? this.systemBlocks.length > 0 ? this.systemBlocks : undefined
        : [makeBillingBlock(), ...this.systemBlocks],
      tools: this.tools.length > 0 ? this.tools : undefined,
      messages: this.history,
      metadata: { user_id: this.userId },
    };
  }
}
