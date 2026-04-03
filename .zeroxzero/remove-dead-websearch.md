# Remove Dead `websearch.ts` Code

## Goal
Delete the unused `websearch.ts` and `websearch.txt` files from the server package, which are dead code superseded by `search_remote.ts`.

## Requirements
1. Remove `websearch.ts` — standalone web search tool that is never imported or registered
2. Remove `websearch.txt` — description file only used by `websearch.ts`
3. Verify no breakage — confirmed zero imports of `WebSearchTool` or `websearch` module anywhere in the codebase

## Plan

### 1. Delete `packages/server/src/tool/websearch.ts`
- **Action**: Delete
- **File**: `packages/server/src/tool/websearch.ts`
- **What**: Remove the entire file (151 lines). Exports `WebSearchTool` which is never imported anywhere.
- **Why**: Dead code. `search_remote.ts` (mode="web") handles all web search functionality and is the tool registered in `ToolRegistry.all()`.
- **Tests**: Run `bun test` in server package to confirm no breakage. Run `tsgo` to confirm no type errors.

### 2. Delete `packages/server/src/tool/websearch.txt`
- **Action**: Delete
- **File**: `packages/server/src/tool/websearch.txt`
- **What**: Remove the description template file (15 lines). Only imported by `websearch.ts`.
- **Why**: Orphaned after step 1.
- **Tests**: N/A — covered by item #1.

## Verification
- `bun test` in `packages/server/` — should remain at 588 pass
- `tsgo` typecheck — should remain at 0 errors
- Grep for `websearch.ts` and `WebSearchTool` should return zero results

## Risks
- **None identified.** Zero imports, zero test references, zero registry usage. This is pure dead code removal.
