# Update Codex Models & Enhance Error Context

## Goal
Update the Codex provider model registry to match the current official Codex models page (as of March 7, 2026) and enhance error messages in the Codex binary resolution and SDK initialization paths with diagnostic context (platform triple, codexPath, import.meta.url).

## Requirements
1. Replace outdated `o3` and `o4-mini` models with current recommended Codex models: `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`
2. Keep `gpt-5-codex` as a legacy option
3. Update `SORT_PRIORITY` to reflect new model hierarchy
4. Update all tests referencing old model IDs
5. Update `packages/git/src/config.ts` default codex model from `o4-mini`
6. Enhance error messages in codex-app-server stream with platform triple, resolved codexPath, and import.meta.url
7. No new dependencies, no architectural changes

## Plan

### 1. Update `CODEX_MODELS` in `packages/server/src/provider/provider.ts`
- **Action**: Modify
- **File**: `packages/server/src/provider/provider.ts`
- **What**: Replace `CODEX_MODELS` record (lines 93-106). Remove `o3` and `o4-mini`. Add `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`. Keep `gpt-5-codex`.
- **How**:
  ```ts
  const CODEX_MODELS: Record<string, Model> = {
    "gpt-5.4": makeModel("codex", "gpt-5.4", "GPT-5.4", {
      reasoning: true,
      limit: { context: 1_000_000, output: 128_000 },
    }),
    "gpt-5.3-codex": makeModel("codex", "gpt-5.3-codex", "GPT-5.3 Codex", {
      reasoning: true,
      limit: { context: 400_000, input: 272_000, output: 128_000 },
    }),
    "gpt-5.3-codex-spark": makeModel("codex", "gpt-5.3-codex-spark", "GPT-5.3 Codex Spark", {
      reasoning: true,
      limit: { context: 400_000, input: 272_000, output: 128_000 },
    }),
    "gpt-5-codex": makeModel("codex", "gpt-5-codex", "GPT-5 Codex", {
      reasoning: true,
      limit: { context: 400_000, input: 272_000, output: 128_000 },
    }),
  }
  ```
  Context limits sourced from official Codex models page: gpt-5.4 supports up to 1M tokens context.
- **Why**: Models `o3` and `o4-mini` are succeeded. `gpt-5.4` is the new recommended default (released March 5, 2026).
- **Tests**: Covered by item #4.

### 2. Update `SORT_PRIORITY` in `packages/server/src/provider/provider.ts`
- **Action**: Modify
- **File**: `packages/server/src/provider/provider.ts`
- **What**: Replace `SORT_PRIORITY` array (line 207).
- **How**:
  ```ts
  const SORT_PRIORITY = ["sonnet", "gpt-5.4", "gpt-5.3-codex-spark", "gpt-5.3-codex", "gpt-5-codex", "opus", "haiku"]
  ```
  `gpt-5.4` sorts first among Codex models (recommended default), then spark (fast iteration), then 5.3-codex, then legacy 5-codex.
- **Why**: Sort order must reflect the updated model set so the UI/default model picker works correctly.
- **Tests**: Covered by item #4.

### 3. Update `packages/git/src/config.ts` default model
- **Action**: Modify
- **File**: `packages/git/src/config.ts`
- **What**: Change line 13 from `codex: "o4-mini"` to `codex: "gpt-5.4"`
- **How**: Direct string replacement in `DEFAULT_MODELS`.
- **Why**: `o4-mini` no longer exists in the registry; `gpt-5.4` is the new recommended default.
- **Tests**: N/A — config resolution, no model-specific test for this.

### 4. Update tests in `packages/server/test/provider/cli-detection.test.ts`
- **Action**: Modify
- **File**: `packages/server/test/provider/cli-detection.test.ts`
- **What**: Update lines 93-95 (model existence checks) and lines 138-141 (sort test).
- **How**:
  - Lines 93-95: Replace `expect(codex!.models["o3"]).toBeDefined()` / `expect(codex!.models["o4-mini"]).toBeDefined()` with checks for `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`.
  - Lines 138-141: Replace sort test to verify `gpt-5.4` sorts before `gpt-5.3-codex` and `gpt-5-codex`:
    ```ts
    test("gpt-5.4 sorts before gpt-5.3-codex and gpt-5-codex", () => {
      const sorted = Provider.sort([make("gpt-5-codex"), make("gpt-5.3-codex"), make("gpt-5.4")])
      expect(sorted[0]!.id).toBe("gpt-5.4")
    })
    ```
- **Why**: Tests must match the new model registry.
- **Tests**: This IS the test update.

### 5. Enhance error messages in `packages/server/src/provider/sdk/codex-app-server/index.ts`
- **Action**: Modify
- **File**: `packages/server/src/provider/sdk/codex-app-server/index.ts`
- **What**: Add diagnostic context to the 3 error yield points (lines 156, 167, 193) and the final catch (line 324).
- **How**:
  - At the top of `codexAppServerStream()`, after `resolveCodexBinary()` call, build a diagnostics object:
    ```ts
    const diagnostics = {
      codexPath,
      platform: `${process.platform}/${process.arch}`,
      importMetaUrl: import.meta.url,
      modelId: input.modelId,
    }
    ```
  - Binary not found error (line 156): append `JSON.stringify(diagnostics)` to message.
  - SDK import error (line 167): append diagnostics to message.
  - Constructor error (line 193): append diagnostics to message.
  - Final catch (line 324): log diagnostics via `log.error()` before yielding the error event.
- **Why**: The "Unable to locate Codex CLI binaries" error gives zero context about what was tried. With diagnostics, the user (or developer) can see the resolved path, platform, and import.meta.url in a single error message, making root cause obvious.
- **Tests**: N/A — error path logging, verified manually.

### 6. Update MEMORY.md models list
- **Action**: Modify
- **File**: (project memory, not a code file — informational only)
- **What**: Update the "Models" section from `gpt-5-codex, o3, o4-mini` to `gpt-5.4 (default), gpt-5.3-codex, gpt-5.3-codex-spark, gpt-5-codex`
- **Why**: Keep project memory accurate for future sessions.
- **Tests**: N/A.

## Risks
1. **`gpt-5.4` context/output limits are approximate** — The official Codex models page says "up to 1 million tokens of context" for gpt-5.4 but doesn't specify exact input/output split. I used 1M context / 128K output based on available documentation. If these are wrong, they only affect the `limit` field in the Model schema which is informational.
2. **`gpt-5.3-codex-spark` is Pro-only** — Listed as "Available to ChatGPT Pro subscribers." Users without Pro will get an API error from OpenAI, not from our code. This is acceptable — the model is in the registry but will fail at the provider level with a clear OpenAI error.
3. **`packages/git` package references** — The `config.ts` in `packages/git` has its own default model. Changing it to `gpt-5.4` is correct but if that package has its own tests, they may need updating. No test file was found referencing `o4-mini` in the git package.
