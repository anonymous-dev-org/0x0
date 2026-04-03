# Cleanup Round 2: Three Fixes

## Goal
Fix the `ApplyPatch` permission mapping bug, the failing question test, and the fragile hardcoded `allPermKeys` list.

## Requirements
1. `toolToPermission("ApplyPatch")` must return `"edit"` (matching `ApplyPatchTool`'s `permission: "edit"`)
2. Question test must provide at least 2 options per `Question.Info` schema (`z.array(Option).min(2)`)
3. `allPermKeys` in the builder deny block must not be a hardcoded list that can silently go stale

## Plan

### 1. Fix `toolToPermission` for `ApplyPatch`
- **Action**: Modify
- **File**: `packages/server/src/runtime/agent/agent.ts`
- **What**: Add `case "ApplyPatch":` to the switch statement at line 106-133, before the `return "edit"` group (alongside `Edit`, `Write`, `MultiEdit`, `NotebookEdit`)
- **How**: Insert `case "ApplyPatch":` at line 113 (before `return "edit"`)
- **Why**: Without this, non-native custom agents with `ApplyPatch: "allow"` get `"applypatch"` as a derived permission key, but the tool checks `"edit"` — causing silent denials
- **Tests**: Existing `search_remote` permission tests cover the pipeline. Add a unit test: custom agent with `ApplyPatch: "allow"` should have `evalPerm(agent, "edit") === "allow"`

### 2. Fix the question test
- **Action**: Modify
- **File**: `packages/server/test/tool/question.test.ts`
- **What**: At line 57, add a second option to the `options` array
- **How**: Add `{ label: "Cat", description: "Independent and curious" }` after the existing Dog option
- **Why**: `Question.Info` schema requires `z.array(Option).min(2)`. The test currently provides only 1 option, causing Zod validation to throw
- **Tests**: This IS the test fix — the test should pass after the change

### 3. Derive `allPermKeys` dynamically
- **Action**: Modify
- **File**: `packages/server/src/runtime/agent/agent.ts`
- **What**: Replace the hardcoded `allPermKeys` array at line 327 with a dynamically derived set from `toolToPermission`
- **How**: Create a constant `ALL_PERMISSION_KEYS` by collecting all unique return values from `toolToPermission` for every known action name. The known action names are the keys of `LEGACY_TOOL_TO_ACTIONS` (line 53-63) mapped through `toolToPermission`, plus any actions from the config that map to known tool names. Simpler approach: define a `const ALL_KNOWN_ACTIONS` array at module level containing every action name the system recognizes (`Bash`, `Read`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Glob`, `Grep`, `Task`, `WebFetch`, `WebSearch`, `TodoWrite`, `AskUserQuestion`, `Plan`, `ApplyPatch`, `Docs`, `Lsp`), then derive `allPermKeys` as `new Set(ALL_KNOWN_ACTIONS.map(toolToPermission))`. Use this in the builder block instead of the hardcoded array.
- **Why**: Prevents silent staleness when new tools/actions are added
- **Tests**: Existing builder `search_remote` deny test covers the pipeline. The dynamic derivation just ensures completeness.

## Risks
- The `ALL_KNOWN_ACTIONS` constant needs to stay in sync with new tool additions. This is still a manual list, but it's a single source of truth rather than duplicated in two places (actions + allPermKeys). If a new tool is added and not listed here, the worst case is the same as today — its permission won't be explicitly denied for builder, but builder's `"*": "allow"` base covers it anyway.
