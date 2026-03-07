# Remove Web Search from Builder Agent Defaults

## Goal
Remove `WebFetch` and `WebSearch` from the builder agent's default actions so the builder cannot search the web by default, while the planner retains full web search access.

## Requirements
1. **Planner agent** must keep `WebFetch: "allow"` and `WebSearch: "allow"` in its default actions (already the case — no change needed).
2. **Builder agent** must NOT have `WebFetch` or `WebSearch` in its default actions.
3. This is a soft removal (not hard deny) — users can re-enable web access for builder via their own config.
4. Existing test asserting `search_remote` is `"allow"` for builder must be updated.

## Plan

### 1. Remove WebFetch and WebSearch from builder default actions
- **Action**: Modify
- **File**: `packages/server/src/core/config/config.ts`
- **What**: Remove `WebFetch: "allow", WebSearch: "allow"` from the builder agent's `actions` object at line 108.
- **How**: Change line 108 from:
  ```ts
  WebFetch: "allow", WebSearch: "allow", Task: "allow",
  ```
  to:
  ```ts
  Task: "allow",
  ```
- **Why**: Builder should not have web search capability by default (requirement #2).
- **Tests**: Covered by item #2.

### 2. Update the `search_remote` builder test
- **Action**: Modify
- **File**: `packages/server/test/runtime/agent/agent.test.ts`
- **What**: Update the test at line 421-429 (`"search_remote is allowed by default"`) to assert `search_remote` is `"deny"` (or undefined/not-allow) for builder, since the tool is no longer in builder's actions.
- **How**: The test currently does:
  ```ts
  const build = await Agent.get("builder")
  expect(evalPerm(build, "search_remote")).toBe("allow")
  ```
  Change to either:
  - Rename the test to `"search_remote is denied for builder by default"` and assert `toBe("deny")`, OR
  - Remove the test entirely and add a new one that verifies builder does NOT have `search_remote` permission.
  
  Additionally, **add a companion test** for planner confirming `search_remote` remains `"allow"`:
  ```ts
  test("search_remote is allowed for planner by default", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const plan = await Agent.get("planner")
        expect(evalPerm(plan, "search_remote")).toBe("allow")
      },
    })
  })
  ```
- **Why**: Test must reflect the new default behavior (requirement #4).
- **Tests**: Self-verifying. Run `bun test packages/server/test/runtime/agent/agent.test.ts`.

### 3. Verify no other tests break
- **Action**: Verify (no file changes)
- **What**: Run the full server test suite to confirm no other tests depend on builder having web search.
- **How**: `cd packages/server && bun test`
- **Why**: Ensure no regressions.

## Risks
- **User configs that assume builder has web search**: Users who rely on the default builder having web access will lose it. This is intentional — they can re-add it in their config. No migration needed since we're just removing a default, not breaking a schema.
- **Subtask agents spawned from builder**: If builder spawns a subtask agent, that agent inherits permissions from the session/agent context. Removing web from builder means subtask agents won't have web either unless explicitly configured. This is the desired behavior.
