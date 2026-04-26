import { z } from "zod"

export const ProviderIdSchema = z.enum(["codex", "claude"])
export type ProviderId = z.infer<typeof ProviderIdSchema>

export const ChatRoleSchema = z.enum(["user", "assistant"])
export type ChatRole = z.infer<typeof ChatRoleSchema>

export const ChatMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.string().min(1),
})
export type ChatMessage = z.infer<typeof ChatMessageSchema>

export const ChatRequestSchema = z.object({
  provider: ProviderIdSchema,
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  systemPrompt: z.string().min(1).optional(),
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
  stream: z.boolean().default(true),
})
export type ChatRequest = z.infer<typeof ChatRequestSchema>

export const CompletionRequestSchema = z.object({
  prefix: z.string(),
  suffix: z.string(),
  language: z.string().min(1),
  filepath: z.string(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  provider: ProviderIdSchema.optional(),
  model: z.string().min(1).optional(),
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
  stream: z.boolean().default(true),
})
export type CompletionRequest = z.infer<typeof CompletionRequestSchema>

export const RangeSchema = z.object({
  startLine: z.number().int().positive(),
  startColumn: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
})
export type Range = z.infer<typeof RangeSchema>

export const InlineEditRequestSchema = z.object({
  repoRoot: z.string().min(1).optional(),
  file: z.string().min(1),
  range: RangeSchema,
  prompt: z.string().min(1),
  text: z.string(),
  provider: ProviderIdSchema.optional(),
  model: z.string().min(1).optional(),
})
export type InlineEditRequest = z.infer<typeof InlineEditRequestSchema>

export const InlineEditResponseSchema = z.object({
  replacementText: z.string(),
})
export type InlineEditResponse = z.infer<typeof InlineEditResponseSchema>

export const SessionSchema = z.object({
  id: z.string().min(1),
  repoRoot: z.string().min(1),
  provider: ProviderIdSchema,
  model: z.string().min(1),
  createdAt: z.string().min(1),
  messages: z.array(ChatMessageSchema).default([]),
})
export type Session = z.infer<typeof SessionSchema>

export const SessionsResponseSchema = z.object({
  sessions: z.array(SessionSchema),
})
export type SessionsResponse = z.infer<typeof SessionsResponseSchema>

export const ChangedFileSchema = z.object({
  path: z.string().min(1),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
})
export type ChangedFile = z.infer<typeof ChangedFileSchema>

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
})
export type Usage = z.infer<typeof UsageSchema>

export const ProviderInfoSchema = z.object({
  id: ProviderIdSchema,
  label: z.string().min(1),
  defaultModel: z.string().min(1),
  models: z.array(z.string().min(1)).min(1),
  configured: z.boolean(),
})
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>

export const ProvidersResponseSchema = z.object({
  providers: z.array(ProviderInfoSchema),
})
export type ProvidersResponse = z.infer<typeof ProvidersResponseSchema>

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
})
export type HealthResponse = z.infer<typeof HealthResponseSchema>

export const ChatResponseSchema = z.object({
  provider: ProviderIdSchema,
  model: z.string().min(1),
  text: z.string(),
  usage: UsageSchema.optional(),
})
export type ChatResponse = z.infer<typeof ChatResponseSchema>

export const CompletionResponseSchema = ChatResponseSchema
export type CompletionResponse = z.infer<typeof CompletionResponseSchema>

export const ChatStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    provider: ProviderIdSchema,
    model: z.string().min(1),
  }),
  z.object({
    type: z.literal("text_delta"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("done"),
    provider: ProviderIdSchema,
    model: z.string().min(1),
    text: z.string(),
    usage: UsageSchema.optional(),
  }),
  z.object({
    type: z.literal("error"),
    error: z.string().min(1),
  }),
])
export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>

export const WebSocketRequestIdSchema = z.string().min(1)
export type WebSocketRequestId = z.infer<typeof WebSocketRequestIdSchema>

export const WebSocketClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.create"),
    id: WebSocketRequestIdSchema,
  repoRoot: z.string().min(1),
  model: z.string().min(1).optional(),
  provider: ProviderIdSchema.optional(),
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
}),
  z.object({
    type: z.literal("session.open"),
    id: WebSocketRequestIdSchema,
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("chat.turn"),
    id: WebSocketRequestIdSchema,
    sessionId: z.string().min(1),
    prompt: z.string().min(1),
  }),
  z.object({
    type: z.literal("inline.edit"),
    id: WebSocketRequestIdSchema,
    repoRoot: z.string().min(1),
    file: z.string().min(1),
    range: RangeSchema,
    prompt: z.string().min(1),
    text: z.string(),
    provider: ProviderIdSchema.optional(),
    model: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("run.cancel"),
    id: WebSocketRequestIdSchema,
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("changes.status"),
    id: WebSocketRequestIdSchema,
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("changes.accept_all"),
    id: WebSocketRequestIdSchema,
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("changes.discard_all"),
    id: WebSocketRequestIdSchema,
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("changes.accept_file"),
    id: WebSocketRequestIdSchema,
    sessionId: z.string().min(1),
    path: z.string().min(1),
  }),
  z.object({
    type: z.literal("changes.discard_file"),
    id: WebSocketRequestIdSchema,
    sessionId: z.string().min(1),
    path: z.string().min(1),
  }),
  z.object({
    type: z.literal("chat"),
    id: WebSocketRequestIdSchema,
    request: ChatRequestSchema,
  }),
  z.object({
    type: z.literal("completion"),
    id: WebSocketRequestIdSchema,
    request: CompletionRequestSchema,
  }),
  z.object({
    type: z.literal("cancel"),
    id: WebSocketRequestIdSchema,
  }),
  z.object({
    type: z.literal("ping"),
    id: WebSocketRequestIdSchema.optional(),
  }),
])
export type WebSocketClientMessage = z.infer<typeof WebSocketClientMessageSchema>

export const WebSocketServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    protocolVersion: z.literal(1),
  }),
  z.object({
    type: z.literal("session.created"),
    id: WebSocketRequestIdSchema,
    session: SessionSchema,
  }),
  z.object({
    type: z.literal("assistant.delta"),
    id: WebSocketRequestIdSchema,
    sessionId: z.string().min(1),
    text: z.string(),
  }),
  z.object({
    type: z.literal("assistant.done"),
    id: WebSocketRequestIdSchema,
    sessionId: z.string().min(1),
    summary: z.string().optional(),
    messages: z.array(ChatMessageSchema).optional(),
  }),
  z.object({
    type: z.literal("user.queued"),
    id: WebSocketRequestIdSchema,
    sessionId: z.string().min(1),
    messages: z.array(ChatMessageSchema),
  }),
  z.object({
    type: z.literal("inline.result"),
    id: WebSocketRequestIdSchema,
    replacementText: z.string(),
  }),
  z.object({
    type: z.literal("changes.updated"),
    id: WebSocketRequestIdSchema,
    sessionId: z.string().min(1),
    files: z.array(ChangedFileSchema),
    baseRef: z.string().min(1),
    agentRef: z.string().min(1),
  }),
  z.object({
    type: z.literal("run.status"),
    id: WebSocketRequestIdSchema,
    sessionId: z.string().min(1),
    status: z.enum(["syncing", "running", "checking", "checkpointing", "done"]),
  }),
  z.object({
    type: z.literal("chat_event"),
    id: WebSocketRequestIdSchema,
    event: ChatStreamEventSchema,
  }),
  z.object({
    type: z.literal("cancelled"),
    id: WebSocketRequestIdSchema,
  }),
  z.object({
    type: z.literal("pong"),
    id: WebSocketRequestIdSchema.optional(),
  }),
  z.object({
    type: z.literal("error"),
    id: WebSocketRequestIdSchema.optional(),
    error: z.string().min(1),
  }),
])
export type WebSocketServerMessage = z.infer<typeof WebSocketServerMessageSchema>
