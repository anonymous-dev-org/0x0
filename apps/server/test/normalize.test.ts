import { describe, it, expect } from "bun:test"
import {
  createClaudeStreamState,
  normalizeClaudeEvent,
} from "@/provider/claude"
import { normalizeCodexEvent } from "@/provider/codex"
import type { StreamEvent } from "@/provider/types"

function collect(gen: Generator<StreamEvent>): StreamEvent[] {
  return Array.from(gen)
}

describe("normalizeClaudeEvent", () => {
  it("normalizes system init event", () => {
    const events = collect(normalizeClaudeEvent({
      type: "system",
      subtype: "init",
      session_id: "abc-123",
    }))
    expect(events).toEqual([{ type: "init", session_id: "abc-123" }])
  })

  it("normalizes text_delta stream event", () => {
    const events = collect(normalizeClaudeEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hello" },
      },
    }))
    expect(events).toEqual([{ type: "text_delta", text: "hello" }])
  })

  it("assembles normal tool use input from input_json_delta", () => {
    const state = createClaudeStreamState()

    collect(normalizeClaudeEvent({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", name: "Bash", id: "tool-1" },
      },
    }, state))

    collect(normalizeClaudeEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{\"command\":\"pwd\"}" },
      },
    }, state))

    const events = collect(normalizeClaudeEvent({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    }, state))

    expect(events).toEqual([{
      type: "tool_use",
      name: "Bash",
      id: "tool-1",
      input: { command: "pwd" },
    }])
  })

  it("normalizes ask user question from AskUserQuestion tool use", () => {
    const state = createClaudeStreamState()

    collect(normalizeClaudeEvent({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", name: "AskUserQuestion", id: "tool-1" },
      },
    }, state))

    collect(normalizeClaudeEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json:
            "{\"questions\":[{\"question\":\"Pick one\",\"options\":[{\"label\":\"A\"},{\"label\":\"B\"}]}]}",
        },
      },
    }, state))

    const events = collect(normalizeClaudeEvent({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    }, state))

    expect(events).toEqual([{
      type: "ask_user_question",
      question: "Pick one",
      options: ["A", "B"],
    }])
  })

  it("normalizes exit plan mode from ExitPlanMode tool use", () => {
    const state = createClaudeStreamState()

    collect(normalizeClaudeEvent({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", name: "ExitPlanMode", id: "tool-1" },
      },
    }, state))

    collect(normalizeClaudeEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: "{\"reason\":\"Need to run commands\"}",
        },
      },
    }, state))

    const events = collect(normalizeClaudeEvent({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    }, state))

    expect(events).toEqual([{
      type: "exit_plan_mode",
      reason: "Need to run commands",
    }])
  })

  it("normalizes top-level user tool_result messages", () => {
    const events = collect(normalizeClaudeEvent({
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "output",
        }],
      },
      tool_use_result: {
        stdout: "output",
        stderr: "",
        interrupted: false,
      },
    }))

    expect(events).toEqual([{
      type: "tool_result",
      tool_use_id: "tool-1",
      content: {
        stdout: "output",
        stderr: "",
        interrupted: false,
      },
    }])
  })

  it("keeps lifecycle-only stream events as raw", () => {
    const events = collect(normalizeClaudeEvent({
      type: "stream_event",
      event: { type: "message_stop" },
    }))
    expect(events).toEqual([{ type: "raw", data: { type: "message_stop" } }])
  })
})

describe("normalizeCodexEvent", () => {
  it("normalizes item.started command execution to tool_use", () => {
    const events = collect(normalizeCodexEvent({
      type: "item.started",
      item: {
        id: "item_0",
        type: "command_execution",
        command: "/bin/zsh -lc pwd",
      },
    }))

    expect(events).toEqual([{
      type: "tool_use",
      name: "command_execution",
      id: "item_0",
      input: { command: "/bin/zsh -lc pwd" },
    }])
  })

  it("normalizes item.completed command execution to tool_result", () => {
    const events = collect(normalizeCodexEvent({
      type: "item.completed",
      item: {
        id: "item_0",
        type: "command_execution",
        command: "/bin/zsh -lc pwd",
        aggregated_output: "/tmp\n",
        exit_code: 0,
        status: "completed",
      },
    }))

    expect(events).toEqual([{
      type: "tool_result",
      tool_use_id: "item_0",
      content: {
        command: "/bin/zsh -lc pwd",
        aggregated_output: "/tmp\n",
        exit_code: 0,
        status: "completed",
      },
    }])
  })

  it("normalizes completed agent messages to text_delta", () => {
    const events = collect(normalizeCodexEvent({
      type: "item.completed",
      item: {
        id: "item_1",
        type: "agent_message",
        text: "hello from codex",
      },
    }))
    expect(events).toEqual([{ type: "text_delta", text: "hello from codex" }])
  })

  it("normalizes top-level error messages", () => {
    const events = collect(normalizeCodexEvent({
      type: "error",
      message: "Reconnecting...",
    }))
    expect(events).toEqual([{ type: "error", error: "Reconnecting..." }])
  })

  it("keeps unknown item types as raw", () => {
    const events = collect(normalizeCodexEvent({
      type: "item.completed",
      item: {
        id: "item_2",
        type: "approval_request",
      },
    }))
    expect(events).toEqual([{
      type: "raw",
      data: {
        type: "item.completed",
        item: {
          id: "item_2",
          type: "approval_request",
        },
      },
    }])
  })
})
