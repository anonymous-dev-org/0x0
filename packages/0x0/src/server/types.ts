// Domain types re-exported with SDK-compatible names.
// Single source of truth — no code generation needed.

export type { Event } from "@/bus/bus-event"

import type { Session as SessionMod } from "@/session"
import type { MessageV2 } from "@/session/message-v2"
import type { Config as ConfigMod } from "@/config/config"
import type { Provider as ProviderMod } from "@/provider/provider"
import type { Agent as AgentMod } from "@/agent/agent"
import type { Command as CommandMod } from "@/command"
import type { Todo as TodoMod } from "@/session/todo"
import type { SessionStatus as SessionStatusMod } from "@/session/status"
import type { PermissionNext } from "@/permission/next"
import type { Question } from "@/question"
import type { Vcs } from "@/project/vcs"
import type { LSP } from "@/lsp"
import type { MCP } from "@/mcp"
import type { Format } from "@/format"
import type { Snapshot } from "@/snapshot"

// Session
export type Session = SessionMod.Info

// Messages
export type UserMessage = MessageV2.User
export type AssistantMessage = MessageV2.Assistant
export type Message = MessageV2.Info

// Parts
export type Part = MessageV2.Part
export type TextPart = MessageV2.TextPart
export type ToolPart = MessageV2.ToolPart
export type FilePart = MessageV2.FilePart
export type AgentPart = MessageV2.AgentPart
export type ReasoningPart = MessageV2.ReasoningPart
export type SubtaskPart = MessageV2.SubtaskPart
export type SnapshotPart = MessageV2.SnapshotPart
export type PatchPart = MessageV2.PatchPart
export type RetryPart = MessageV2.RetryPart
export type CompactionPart = MessageV2.CompactionPart
export type StepStartPart = MessageV2.StepStartPart
export type StepFinishPart = MessageV2.StepFinishPart

// Config — keybinds fields are made optional to match SDK codegen output.
// Zod v4 applies defaults at runtime, but the SDK generates optional fields.
type RawKeybinds = NonNullable<ConfigMod.Info["keybinds"]>
export type KeybindsConfig = { [K in keyof RawKeybinds]?: RawKeybinds[K] }
export type Config = Omit<ConfigMod.Info, "keybinds"> & { keybinds?: KeybindsConfig }

// Provider
export type Provider = ProviderMod.Info
export type Model = ProviderMod.Model

// Agent
export type Agent = AgentMod.Info

// Command
export type Command = CommandMod.Info

// Todo
export type Todo = TodoMod.Info

// Session status
export type SessionStatus = SessionStatusMod.Info

// Permission
export type PermissionRequest = PermissionNext.Request

// Question
export type QuestionRequest = Question.Request
export type QuestionAnswer = Question.Answer

// VCS
export type VcsInfo = Vcs.Info

// LSP
export type LspStatus = LSP.Status

// MCP
export type McpStatus = MCP.Status
export type McpResource = MCP.Resource

// Formatter
export type FormatterStatus = Format.Status

// Snapshot
export type FileDiff = Snapshot.FileDiff

// Path (defined inline in app route — no domain module)
export type Path = {
  home: string
  state: string
  config: string
  worktree: string
  directory: string
}

// Session message response
export type SessionMessageResponse = {
  info: Message
  parts: Part[]
}
