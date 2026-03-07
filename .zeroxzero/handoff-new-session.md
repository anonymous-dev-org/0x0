# Plan: Handoff Creates New Session + TUI Navigation

## Goal
When the planner agent uses the Task tool with `mode="handoff"` (compact + handoff), create a new child session for the target agent (builder) with a reference to the plan file path and description, start the builder's prompt loop asynchronously, and navigate the TUI to the new session — replacing the planner session in the UI.

## Requirements
1. **New child session on handoff**: Instead of creating a synthetic user message in the same session, create a new child session (parentID = current session).
2. **Plan file reference**: Find the Plan tool's output in the current session's messages to extract the plan file path. Include it in the handoff user message so the builder knows what to execute.
3. **Description passthrough**: Include the handoff description (e.g., "Execute the plan: [goal]") in the new session's user message.
4. **Todo transfer**: Copy the todo list from the parent session to the child session so the builder has the task checklist.
5. **Async prompt start**: Fire-and-forget `SessionPrompt.prompt()` on the new child session so the builder starts processing immediately without blocking the parent's prompt loop exit.
6. **TUI navigation**: Publish `TuiEvent.SessionSelect` to navigate the TUI to the new child session, replacing the planner view.
7. **Parent session clean exit**: The parent session's prompt loop should terminate normally after the Task tool returns (planner ends its turn).
8. **Backward compatibility**: The handoff tool result metadata should still include `handoff.switched: true`, `sourceAgent`, `targetAgent`, and now also `sessionId` pointing to the new child session.

## Plan

### 1. Modify Task tool handoff mode to create child session
- **Action**: Modify
- **File**: `packages/server/src/tool/task.ts`
- **What**: Rewrite the `if (params.mode === "handoff")` block (lines 75–141)
- **How**:
  1. Keep permission check (lines 76–87) as-is.
  2. Keep compaction logic (lines 94–105) as-is — it compacts the PARENT session before handoff.
  3. **Remove** the synthetic user message creation in the same session (lines 107–125).
  4. **Add**: Find the plan file path by scanning `ctx.messages` for the last completed Plan tool part with `metadata.filepath`.
  5. **Add**: Create a new child session via `Session.create({ parentID: ctx.sessionID, title: params.description + " (@" + agent.name + " agent)" })`.
  6. **Add**: Copy todos from parent to child: `const todos = await Todo.get(ctx.sessionID); if (todos.length) await Todo.update({ sessionID: childSession.id, todos })`.
  7. **Add**: Build the handoff prompt text:
     ```
     Handoff from @{sourceAgent} to @{targetAgent}.
     Objective: {description}
     
     Plan file: {planFilePath}
     
     Read the plan file above and execute it. Update the todo checklist as you complete each task.
     ```
     If no plan file found, omit the "Plan file:" line.
  8. **Add**: Fire-and-forget `SessionPrompt.prompt()` on the child session:
     ```typescript
     const model = agent.model ?? { modelID: msg.info.modelID, providerID: msg.info.providerID }
     SessionPrompt.prompt({
       sessionID: childSession.id,
       agent: agent.name,
       model,
       parts: [{ type: "text", text: handoffPromptText }],
     }).catch((e) => {
       log.error("handoff prompt error", { sessionID: childSession.id, error: e })
       Bus.publish(Session.Event.Error, {
         sessionID: childSession.id,
         error: new NamedError.Unknown({ message: e instanceof Error ? e.message : String(e) }).toObject(),
       })
     })
     ```
  9. **Add**: Publish `TuiEvent.SessionSelect` to navigate TUI:
     ```typescript
     Bus.publish(TuiEvent.SessionSelect, { sessionID: childSession.id })
     ```
  10. **Return**: Updated metadata with `sessionId: childSession.id`:
      ```typescript
      return {
        title: `Handoff to ${agent.name}`,
        metadata: {
          sessionId: childSession.id,
          model,
          handoff: {
            switched: true,
            sourceAgent: ctx.agent,
            targetAgent: agent.name,
            reason: params.description,
          },
        },
        output: ["<handoff_result>", `Handed off to @${agent.name}`, `New session: ${childSession.id}`, "</handoff_result>"].join("\n"),
      }
      ```
- **Why**: Implements requirements 1–8. Creates a clean separation between planner and builder sessions.
- **Tests**: Verify handoff creates child session, copies todos, starts prompt loop, publishes SessionSelect event. The existing handoff tests need updating.

### 2. Add imports for new dependencies in task.ts
- **Action**: Modify
- **File**: `packages/server/src/tool/task.ts`
- **What**: Add imports for `Todo`, `TuiEvent`, `Bus`, `NamedError` at the top of the file.
- **How**:
  ```typescript
  import { Todo } from "../session/todo"
  import { TuiEvent } from "@/core/bus/tui-event"
  import { Bus } from "@/core/bus"
  import { NamedError } from "@/util/error"
  ```
  Note: `Bus` is not currently imported. `Log` is already imported. `Session` and `SessionPrompt` are already imported.
- **Why**: Required for todo transfer, TUI navigation event, and error handling in the fire-and-forget prompt.
- **Tests**: N/A — covered by item #1.

### 3. Verify TUI already handles SessionSelect for new child sessions
- **Action**: No code change needed
- **File**: `packages/tui/src/tui/app/use-app-event-handlers.ts` (lines 107–112)
- **What**: The existing `TuiEvent.SessionSelect` handler already calls `route.navigate({ type: "session", sessionID })`, and the Session component in `packages/tui/src/tui/routes/session/index.tsx` already calls `sync.session.sync(sessionID)` when the route changes (line 125–148). This will fetch the new session's data and render it.
- **Why**: Confirms no TUI changes are needed — the existing event infrastructure handles navigation to new sessions.
- **Tests**: N/A — existing behavior.

### 4. Verify the prompt loop exits cleanly after handoff
- **Action**: No code change needed
- **File**: `packages/server/src/session/prompt.ts`
- **What**: After the Task tool returns with the handoff result, the Claude SDK (planner) will produce an "end-turn" finish. The prompt loop at line 329–336 checks `if (lastAssistant?.finish && !["tool-calls", "unknown"].includes(lastAssistant.finish) && lastUser.id < lastAssistant.id)` — since we no longer create a synthetic user message in the parent session, `lastUser.id < lastAssistant.id` will be true, and the loop exits cleanly.
- **Why**: Confirms the parent session terminates without producing orphan builder messages.
- **Tests**: N/A — verified by reading the loop logic.

## Risks

1. **Race condition on TUI navigation**: The `TuiEvent.SessionSelect` is published before `SessionPrompt.prompt()` starts processing. The TUI will navigate to the child session which has no messages yet. The Session component handles this gracefully (shows empty state with logo, then messages appear via SSE events as they're created). **Mitigation**: This is acceptable UX — the TUI shows the new session immediately and content streams in.

2. **Plan file not found**: If the planner didn't use the Plan tool (or it failed), `planFilePath` will be undefined. **Mitigation**: The handoff prompt omits the "Plan file:" reference and just includes the description/objective. The builder can still operate on the description alone.

3. **Compaction runs on parent session**: The `compact` parameter compacts the parent session before handoff. Since we're creating a new child session, this compaction is wasted (the child starts fresh). **Mitigation**: The compaction still serves a purpose — it creates a clean summary in the parent session for future reference. Keep as-is.

4. **Todo storage is session-scoped**: Todos are stored per session ID. Copying them to the child means the builder sees and can update them independently. The TUI sidebar shows todos for the current session. **Mitigation**: This is the desired behavior.

5. **CLI session ID not carried over**: The child session starts fresh without `cliSessionId`/`codexThreadId` from the parent. The builder agent will start a fresh Claude/Codex session. **Mitigation**: This is correct behavior — the builder should have its own context, not inherit the planner's conversation history with the LLM provider.
