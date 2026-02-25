# Dead Code Cleanup Plan

## Goal
Remove all dead code from the 0x0 repo: unused source files, unused dependencies, dead test code, and dead build artifacts.

## Requirements
1. Remove dead source files that are never imported by production code
2. Remove dead test code that tests deleted source
3. Preserve live `MessageV2.fromError` tests currently in `retry.test.ts` by moving them to `message-v2.test.ts`
4. Remove unused dependencies from `packages/0x0/package.json`
5. Remove dead catalog entries from root `package.json`
6. Remove dead build script code (models-snapshot generation)
7. Clean up config references to deleted files (biome.json, .gitignore)
8. Leave `script/release-local.sh` untouched
9. Run tests to verify nothing breaks

## Plan

### 1. Delete `packages/0x0/src/util/scrap.ts`
- **Action**: Delete
- **File**: `packages/0x0/src/util/scrap.ts`
- **What**: Entire file — exports `foo`, `bar`, `dummyFunction`, `randomHelper` (dummy placeholders)
- **Why**: Zero imports anywhere in the codebase

### 2. Delete `packages/0x0/src/session/message.ts`
- **Action**: Delete
- **File**: `packages/0x0/src/session/message.ts`
- **What**: Entire file — old `Message` namespace with 14+ Zod schemas/types (ToolCall, ToolResult, Info, etc.)
- **Why**: Replaced by `MessageV2` in `message-v2.ts`. Zero imports in src/ or test/

### 3. Delete `packages/0x0/src/session/retry.ts`
- **Action**: Delete
- **File**: `packages/0x0/src/session/retry.ts`
- **What**: Entire file — `SessionRetry` namespace with `delay()`, `sleep()`, `retryable()`
- **Why**: Zero imports from production source code. Only referenced by its own test file.

### 4. Modify `packages/0x0/test/session/retry.test.ts` → move live tests, delete file
- **Action**: Modify `test/session/message-v2.test.ts`, then delete `test/session/retry.test.ts`
- **What**:
  - Move the `describe("session.message-v2.fromError", ...)` block (lines 123–187) into `message-v2.test.ts`
  - Add the `APICallError` import from `"ai"` to `message-v2.test.ts`
  - Delete `retry.test.ts` entirely
- **Why**: Lines 1–121 test dead `SessionRetry`. Lines 123–187 test live `MessageV2.fromError` and belong in the existing `message-v2.test.ts` file.

### 5. Remove models-snapshot generation from build script
- **Action**: Modify
- **File**: `packages/0x0/script/build.ts`
- **What**: Remove lines 17–26 (the `modelsUrl`, `modelsData` fetch, `Bun.write` for models-snapshot.ts, and console.log)
- **Why**: `models-snapshot.ts` is generated but its `snapshot` export is never imported anywhere. The provider registry hardcodes models in `provider.ts`.

### 6. Remove models-snapshot.ts from .gitignore
- **Action**: Modify
- **File**: `packages/0x0/.gitignore`
- **What**: Remove line `src/provider/models-snapshot.ts`
- **Why**: File no longer generated

### 7. Remove models-snapshot.ts from biome.json override
- **Action**: Modify
- **File**: `biome.json`
- **What**: Remove `"**/models-snapshot.ts"` from the `includes` array on line 44
- **Why**: File no longer exists

### 8. Remove unused dependencies from `packages/0x0/package.json`
- **Action**: Modify
- **File**: `packages/0x0/package.json`
- **Dependencies to remove** (13 items):
  - `@ai-sdk/provider` — not imported anywhere
  - `@ai-sdk/provider-utils` — not imported anywhere
  - `@gitlab/opencode-gitlab-auth` — not imported anywhere
  - `@hono/standard-validator` — not imported anywhere
  - `@hono/zod-validator` — not imported anywhere
  - `@pierre/diffs` — not imported anywhere
  - `@standard-schema/spec` (from dependencies) — not imported anywhere
  - `chokidar` — not imported anywhere (file watching uses @parcel/watcher)
  - `jsonc-parser` — not imported anywhere
  - `minimatch` — not imported anywhere
  - `opencode-antigravity-auth` — not imported anywhere
  - `partial-json` — not imported anywhere
- **DevDependencies to remove** (4 items):
  - `@babel/core` — not imported anywhere
  - `@types/babel__core` — types for dead @babel/core
  - `@standard-schema/spec` (from devDependencies) — not imported anywhere
  - `why-is-node-running` — not imported anywhere

### 9. Remove dead catalog entries from root `package.json`
- **Action**: Modify
- **File**: `package.json` (root)
- **What**: Remove from `workspaces.catalog`:
  - `@openauthjs/openauth` — not in any workspace's deps
  - `@hono/zod-validator` — only consumer (0x0) is dropping it
  - `@pierre/diffs` — only consumer (0x0) is dropping it

### 10. Run `bun install` to update lockfile
- **Why**: Dependency removals need lockfile sync

### 11. Run tests to verify
- **Command**: `cd packages/0x0 && bun test`
- **Expected**: All previously-passing tests still pass. The moved `MessageV2.fromError` tests pass in their new location.

### 12. Run typecheck to verify
- **Command**: `bun run typecheck` from root
- **Expected**: Clean pass

## Risks
- **models-snapshot removal**: If someone planned to use it in the future, they'll need to re-add the build step. But it's currently dead and gitignored — no one is using it.
- **@ai-sdk/provider removal**: Memory says "kept (used by copilot SDK)" but zero imports exist. If the copilot SDK (packages/sdk/js) needs it, it should declare its own dependency. Checked: it doesn't import it.
- **SessionRetry**: The retry logic may have been intended for future use, but it's unreferenced. If needed later, git history has it.
