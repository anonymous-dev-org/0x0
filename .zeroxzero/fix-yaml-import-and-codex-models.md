# Fix YAML Import and Update Codex Models

## Goal
Fix the TS2304 typecheck error for missing `YAML` import in `mcp.ts` and update the Codex provider model list to include all current recommended OpenAI Codex models.

## Requirements
1. Fix `Cannot find name 'YAML'` typecheck error in `packages/server/src/cli/cmd/mcp.ts` (lines 387, 398)
2. Add all recommended Codex models from OpenAI's official models page (as of March 2026) to the provider registry
3. Update `SORT_PRIORITY` to reflect the new model hierarchy
4. Update `defaultModel()` to prefer `gpt-5.4` when codex provider is available

## Plan

### 1. Fix YAML import in mcp.ts
- **Action**: Modify
- **File**: `packages/server/src/cli/cmd/mcp.ts`
- **What**: Add `import YAML from "yaml"` to the imports at the top of the file
- **How**: Insert `import YAML from "yaml"` after the existing import block (e.g., after line 15 `import { Global } from "@/core/global"`). The `yaml` package (v2.8.2) is already in `packages/server/package.json` dependencies and exports a default `YAML` object with `.parse()` and `.stringify()` methods.
- **Why**: Lines 387 and 398 use `YAML.parse()` and `YAML.stringify()` but the import is missing, causing TS2304 in both server and TUI typechecks
- **Tests**: Run `bun run typecheck` in both `packages/server` and `packages/tui` — should produce 0 errors related to YAML

### 2. Add all recommended Codex models to CODEX_MODELS
- **Action**: Modify
- **File**: `packages/server/src/provider/provider.ts`
- **What**: Replace the `CODEX_MODELS` record (lines 93–106) with a comprehensive list of all current Codex-compatible models
- **How**: Add the following models to the `CODEX_MODELS` record, using `makeModel("codex", ...)`:

```typescript
const CODEX_MODELS: Record<string, Model> = {
  "gpt-5.4": makeModel("codex", "gpt-5.4", "GPT-5.4", {
    reasoning: true,
    limit: { context: 1_050_000, input: 272_000, output: 128_000 },
  }),
  "gpt-5.3-codex": makeModel("codex", "gpt-5.3-codex", "GPT-5.3 Codex", {
    reasoning: true,
    limit: { context: 400_000, input: 272_000, output: 128_000 },
  }),
  "gpt-5.3-codex-spark": makeModel("codex", "gpt-5.3-codex-spark", "GPT-5.3 Codex Spark", {
    reasoning: true,
    limit: { context: 128_000, output: 64_000 },
  }),
  "gpt-5.2-codex": makeModel("codex", "gpt-5.2-codex", "GPT-5.2 Codex", {
    reasoning: true,
    limit: { context: 400_000, input: 272_000, output: 128_000 },
  }),
  "gpt-5.1-codex-max": makeModel("codex", "gpt-5.1-codex-max", "GPT-5.1 Codex Max", {
    reasoning: true,
    limit: { context: 400_000, input: 272_000, output: 128_000 },
  }),
  "gpt-5.1-codex": makeModel("codex", "gpt-5.1-codex", "GPT-5.1 Codex", {
    reasoning: true,
    limit: { context: 400_000, input: 272_000, output: 128_000 },
  }),
  "gpt-5.1-codex-mini": makeModel("codex", "gpt-5.1-codex-mini", "GPT-5.1 Codex Mini", {
    reasoning: true,
    limit: { context: 400_000, input: 272_000, output: 128_000 },
  }),
  "gpt-5-codex": makeModel("codex", "gpt-5-codex", "GPT-5 Codex", {
    reasoning: true,
    limit: { context: 400_000, input: 272_000, output: 128_000 },
  }),
  "gpt-5-codex-mini": makeModel("codex", "gpt-5-codex-mini", "GPT-5 Codex Mini", {
    reasoning: true,
    limit: { context: 400_000, input: 272_000, output: 128_000 },
  }),
  o3: makeModel("codex", "o3", "o3", {
    reasoning: true,
    limit: { context: 200_000, output: 32_000 },
  }),
  "o4-mini": makeModel("codex", "o4-mini", "o4-mini", {
    reasoning: true,
    limit: { context: 200_000, output: 32_000 },
  }),
}
```

- **Why**: The current list only has 3 models (gpt-5-codex, o3, o4-mini). OpenAI's Codex models page (https://developers.openai.com/codex/models/) lists gpt-5.4 as the recommended default, plus gpt-5.3-codex, gpt-5.3-codex-spark, gpt-5.2-codex, gpt-5.1-codex-max, gpt-5.1-codex, gpt-5.1-codex-mini, gpt-5-codex, gpt-5-codex-mini, o3, and o4-mini.
- **Tests**: N/A — covered by typecheck + item #5

### 3. Update SORT_PRIORITY
- **Action**: Modify
- **File**: `packages/server/src/provider/provider.ts`
- **What**: Update the `SORT_PRIORITY` array (line 207) to reflect the new model hierarchy
- **How**: Change to:
```typescript
const SORT_PRIORITY = ["sonnet", "gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.1-codex", "gpt-5-codex", "opus", "o3", "o4-mini", "haiku"]
```
This ensures the model picker sorts newer/better models first. Note: `SORT_PRIORITY` uses `model.id.includes(filter)` matching, so `"gpt-5.3-codex"` will also match `"gpt-5.3-codex-spark"`. The order ensures spark sorts after the base model.
- **Why**: Without updating sort priority, gpt-5.4 and the newer codex models would sort to the end of the list
- **Tests**: N/A — covered by item #5

### 4. Update defaultModel() for codex provider
- **Action**: Modify
- **File**: `packages/server/src/provider/provider.ts`
- **What**: In `defaultModel()` (line 223), the current logic prefers `claude-code/claude-sonnet-4-6`. No change needed for the claude-code default. But when only codex is available, `sort()` will now correctly pick `gpt-5.4` first due to the updated SORT_PRIORITY. No code change needed here — the sort update in item #3 handles this.
- **Why**: Confirming no additional code change is needed — the sort-based fallback already handles this correctly
- **Tests**: N/A

### 5. Verify typecheck passes
- **Action**: Verify
- **File**: N/A
- **What**: Run typecheck for both packages
- **How**: Run `cd packages/server && bun run typecheck` and `cd packages/tui && bun run typecheck`
- **Why**: Ensure both the YAML fix and model additions compile cleanly
- **Tests**: Both commands should exit with 0 errors

## Risks
1. **Context window / output limit accuracy**: The exact context windows for some models (gpt-5.3-codex, gpt-5.2-codex, etc.) are not fully documented on the pricing page. I used 400K context / 272K input / 128K output based on the gpt-5-codex pattern and pricing breakpoints. If exact limits differ, the costs are zero-placeholder anyway and limits only affect UI display. These can be refined later when OpenAI publishes detailed model cards.
2. **gpt-5.3-codex-spark availability**: This model is in research preview for ChatGPT Pro users only. Users without Pro access will see it listed but may get auth errors when trying to use it. This matches how the existing codebase handles models — availability is checked at the provider level, not per-model.
3. **No existing tests for model list**: The provider model list is hardcoded and not tested. Changes are verified by typecheck only.
