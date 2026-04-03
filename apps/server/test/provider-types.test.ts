import { describe, it, expect } from "bun:test"
import {
  StreamEvent,
  CommonInputSchemaProperties,
  CommonMessageOptionKeys,
  createProviderInputSchema,
} from "@/provider/types"

describe("StreamEvent schema", () => {
  it("validates init event", () => {
    const result = StreamEvent.safeParse({ type: "init", session_id: "abc" })
    expect(result.success).toBe(true)
  })

  it("validates init without session_id", () => {
    const result = StreamEvent.safeParse({ type: "init" })
    expect(result.success).toBe(true)
  })

  it("validates text_delta event", () => {
    const result = StreamEvent.safeParse({ type: "text_delta", text: "hello" })
    expect(result.success).toBe(true)
  })

  it("rejects text_delta without text", () => {
    const result = StreamEvent.safeParse({ type: "text_delta" })
    expect(result.success).toBe(false)
  })

  it("validates tool_use event", () => {
    const result = StreamEvent.safeParse({ type: "tool_use", name: "Read", id: "t1" })
    expect(result.success).toBe(true)
  })

  it("validates tool_result event", () => {
    const result = StreamEvent.safeParse({ type: "tool_result", tool_use_id: "t1", content: "data" })
    expect(result.success).toBe(true)
  })

  it("validates ask_user_question event", () => {
    const result = StreamEvent.safeParse({
      type: "ask_user_question",
      question: "Which path should I use?",
      options: ["A", "B"],
    })
    expect(result.success).toBe(true)
  })

  it("validates exit_plan_mode event", () => {
    const result = StreamEvent.safeParse({ type: "exit_plan_mode", reason: "Need to execute" })
    expect(result.success).toBe(true)
  })

  it("validates agent_event event", () => {
    const result = StreamEvent.safeParse({ type: "agent_event", name: "thinking", data: { step: 1 } })
    expect(result.success).toBe(true)
  })

  it("validates result event", () => {
    const result = StreamEvent.safeParse({
      type: "result",
      session_id: "s1",
      result: "done",
      cost_usd: 0.01,
      duration_ms: 1000,
      is_error: false,
    })
    expect(result.success).toBe(true)
  })

  it("validates error event", () => {
    const result = StreamEvent.safeParse({ type: "error", error: "something broke" })
    expect(result.success).toBe(true)
  })

  it("rejects error without message", () => {
    const result = StreamEvent.safeParse({ type: "error" })
    expect(result.success).toBe(false)
  })

  it("validates done event", () => {
    const result = StreamEvent.safeParse({ type: "done" })
    expect(result.success).toBe(true)
  })

  it("validates raw event", () => {
    const result = StreamEvent.safeParse({ type: "raw", data: { anything: true } })
    expect(result.success).toBe(true)
  })

  it("rejects unknown event type", () => {
    const result = StreamEvent.safeParse({ type: "unknown_type" })
    expect(result.success).toBe(false)
  })
})

describe("CommonInputSchemaProperties", () => {
  it("defines prompt property", () => {
    expect(CommonInputSchemaProperties.prompt.type).toBe("string")
  })

  it("defines session_id property", () => {
    expect(CommonInputSchemaProperties.session_id.type).toBe("string")
  })

  it("defines model property", () => {
    expect(CommonInputSchemaProperties.model.type).toBe("string")
  })

  it("defines cwd property", () => {
    expect(CommonInputSchemaProperties.cwd.type).toBe("string")
  })

  it("defines stream property with default true", () => {
    expect(CommonInputSchemaProperties.stream.type).toBe("boolean")
    expect(CommonInputSchemaProperties.stream.default).toBe(true)
  })
})

describe("CommonMessageOptionKeys", () => {
  it("includes all expected keys", () => {
    expect(CommonMessageOptionKeys).toContain("prompt")
    expect(CommonMessageOptionKeys).toContain("session_id")
    expect(CommonMessageOptionKeys).toContain("model")
    expect(CommonMessageOptionKeys).toContain("cwd")
    expect(CommonMessageOptionKeys).toContain("stream")
    expect(CommonMessageOptionKeys.length).toBe(5)
  })
})

describe("createProviderInputSchema", () => {
  it("creates schema with common + custom properties", () => {
    const schema = createProviderInputSchema({
      custom_field: { type: "string", description: "A custom field" },
    })

    expect(schema.type).toBe("object")
    expect(schema.required).toEqual(["prompt"])
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties).toHaveProperty("prompt")
    expect(schema.properties).toHaveProperty("session_id")
    expect(schema.properties).toHaveProperty("custom_field")
  })

  it("creates schema with no custom properties", () => {
    const schema = createProviderInputSchema({})
    expect(Object.keys(schema.properties).length).toBe(Object.keys(CommonInputSchemaProperties).length)
  })

  it("custom properties override common ones", () => {
    const schema = createProviderInputSchema({
      prompt: { type: "string", description: "Overridden prompt" },
    })
    expect(schema.properties.prompt!.description).toBe("Overridden prompt")
  })
})
