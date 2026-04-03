import z from "zod"

export const StreamEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("init"),
    session_id: z.string().optional(),
  }),
  z.object({
    type: z.literal("text_delta"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool_use"),
    name: z.string(),
    id: z.string().optional(),
    input: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("tool_result"),
    tool_use_id: z.string().optional(),
    content: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("ask_user_question"),
    question: z.string(),
    options: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("exit_plan_mode"),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal("agent_event"),
    name: z.string(),
    data: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("result"),
    session_id: z.string().optional(),
    result: z.string().optional(),
    cost_usd: z.number().optional(),
    duration_ms: z.number().optional(),
    is_error: z.boolean().optional(),
    input_tokens: z.number().optional(),
    context_window: z.number().optional(),
  }),
  z.object({
    type: z.literal("error"),
    error: z.string(),
  }),
  z.object({
    type: z.literal("done"),
  }),
  z.object({
    type: z.literal("raw"),
    data: z.unknown(),
  }),
])
export type StreamEvent = z.infer<typeof StreamEvent>

export interface SpawnInput {
  prompt: string
  sessionId?: string
  model?: string
  effort?: string
  modelReasoningEffort?: string
  systemPrompt?: string
  appendSystemPrompt?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  permissionMode?: string
  sandbox?: string
  maxTurns?: number
  cwd?: string
  abort?: AbortSignal
}

export type InputSchemaProperty = {
  type: "string" | "boolean" | "integer" | "array"
  description: string
  enum?: string[]
  items?: {
    type: "string"
  }
  default?: unknown
}

export interface ProviderInputSchema {
  type: "object"
  required: string[]
  additionalProperties: boolean
  properties: Record<string, InputSchemaProperty>
}

export const CommonInputSchemaProperties = {
  prompt: {
    type: "string",
    description: "User prompt to send to the provider.",
  },
  session_id: {
    type: "string",
    description: "Existing 0x0 session UUID to continue.",
  },
  model: {
    type: "string",
    description: "Provider model override.",
  },
  cwd: {
    type: "string",
    description: "Working directory for the agent process.",
  },
  stream: {
    type: "boolean",
    description: "Whether to stream server-sent events.",
    default: true,
  },
} satisfies Record<string, InputSchemaProperty>

export const CommonMessageOptionKeys = [
  "prompt",
  "session_id",
  "model",
  "cwd",
  "stream",
] as const

export function createProviderInputSchema(
  properties: Record<string, InputSchemaProperty>,
): ProviderInputSchema {
  return {
    type: "object",
    required: ["prompt"],
    additionalProperties: false,
    properties: {
      ...CommonInputSchemaProperties,
      ...properties,
    },
  }
}

export interface AgentProvider {
  readonly id: string
  readonly name: string
  readonly supportedMessageOptions: readonly string[]
  readonly inputSchema: ProviderInputSchema
  spawn(input: SpawnInput): AsyncGenerator<StreamEvent>
  isAvailable(): Promise<boolean>
}
