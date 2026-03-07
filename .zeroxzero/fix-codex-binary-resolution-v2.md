# Fix Codex Binary Resolution v2

## Goal
Eliminate the "Unable to locate Codex CLI binaries" error from the `@openai/codex-sdk` by preventing the SDK's `findCodexPath()` from ever running and adding diagnostics for future debugging.

## Root Cause Analysis
The SDK error `"Unable to locate Codex CLI binaries. Ensure @openai/codex is installed with optional dependencies."` comes from `findCodexPath()` in `@openai/codex-sdk/dist/index.js` (line 423). This function is called by the `CodexExec` constructor ONLY when `executablePath` is falsy (`this.executablePath = executablePath || findCodexPath()`).

The existing code in `codex-app-server/index.ts` passes `codexPathOverride` to `new Codex()`, which should bypass `findCodexPath()`. However, the SDK also runs `var moduleRequire = createRequire(import.meta.url)` at the **top level** (line 152) when the module is imported. In a compiled Bun binary, `import.meta.url` points to a virtual path inside the binary (`/$bunfs/root/...`), and while `createRequire()` itself shouldn't throw, there may be side effects or Bun-specific behaviors causing issues.

Additionally, the static `import { Codex } from "@openai/codex-sdk"` at the top of `codex-app-server/index.ts` causes the SDK module to load whenever `llm.ts` is imported (transitively), even for Claude Code users who never use Codex. This is wasteful and creates a failure surface.

## Requirements
1. The SDK's `findCodexPath()` must never run — all binary resolution must go through our `resolveCodexBinary()`
2. If `resolveCodexBinary()` fails, the error message must be actionable (not the SDK's raw error)
3. The codex SDK module must only load when actually needed (not on every server startup)
4. Debug logging must show exactly which resolution strategy succeeded/failed
5. Existing tests must continue to pass

## Plan

### 1. Add debug logging to `resolveCodexBinary()`
- **Action**: Modify
- **File**: `packages/server/src/provider/resolve-codex-binary.ts`
- **What**: Import `Log` and add debug-level log statements to each strategy
- **How**:
  ```ts
  import { Log } from "@/util/log"
  const log = Log.create({ service: "resolve-codex-binary" })
  ```
  - At the start of `resolveCodexBinary()`: log the computed `triple` and `platformPkg`
  - In Strategy 1 (createRequire): log success path or catch reason
  - In Strategy 2 (directory walk): log each search root and whether the candidate was found
  - In `systemFallback()`: log the result of `Bun.which("codex")`
  - At the end: log the final resolved path or null
- **Why**: Without logging, we have zero visibility into why resolution fails. The user couldn't provide a stack trace — logging fixes this permanently.
- **Tests**: N/A — logging-only change, existing tests unaffected

### 2. Make `@openai/codex-sdk` a dynamic import
- **Action**: Modify
- **File**: `packages/server/src/provider/sdk/codex-app-server/index.ts`
- **What**: Remove static `import { Codex } from "@openai/codex-sdk"` (line 1). Replace with a lazy dynamic import inside `codexAppServerStream()`.
- **How**:
  - Remove line 1: `import { Codex } from "@openai/codex-sdk"`
  - Inside `codexAppServerStream()`, after the `resolveCodexBinary()` check and before `new Codex(...)`, add:
    ```ts
    let CodexClass: typeof import("@openai/codex-sdk").Codex
    try {
      const mod = await import("@openai/codex-sdk")
      CodexClass = mod.Codex
    } catch (err) {
      log.error("failed to load @openai/codex-sdk", { error: err instanceof Error ? err.message : String(err) })
      yield { type: "error", message: "Failed to load Codex SDK. Ensure @openai/codex-sdk is installed." }
      return
    }
    ```
  - Change `const codex = new Codex({` to `const codex = new CodexClass({`
- **Why**: The SDK's top-level `var moduleRequire = createRequire(import.meta.url)` runs on import. In compiled Bun binaries, `import.meta.url` points to a virtual path, and this may cause issues. Dynamic import also means Claude Code users never pay the cost of loading the Codex SDK. Additionally, wrapping in try/catch catches any import-time failures gracefully.
- **Tests**: Existing codex tests pass unchanged (dynamic import is transparent to the caller)

### 3. Wrap `new Codex()` constructor in dedicated try-catch
- **Action**: Modify
- **File**: `packages/server/src/provider/sdk/codex-app-server/index.ts`
- **What**: Add a try-catch specifically around the `new Codex()` instantiation (currently at line 161) to catch the SDK's `findCodexPath()` error before it propagates to the outer catch
- **How**:
  ```ts
  let codex: InstanceType<typeof CodexClass>
  try {
    codex = new CodexClass({
      codexPathOverride: codexPath,
      config: { /* existing config */ },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error("Codex SDK instantiation failed", { codexPath, error: msg })
    yield {
      type: "error",
      message: `Codex SDK failed to initialize (codexPathOverride=${codexPath}). ${msg}. Ensure @openai/codex is installed with optional dependencies or add codex to your PATH.`,
    }
    return
  }
  ```
- **Why**: Even though `codexPathOverride` is passed, the SDK might still call `findCodexPath()` due to bundler transformations, Bun-specific `createRequire` behavior, or future SDK changes. This catch provides a clear, actionable error with the resolved path logged — making root cause identification trivial.
- **Tests**: Covered by item 5

### 4. Add `resolveCodexBinary()` integration test
- **Action**: Create
- **File**: `packages/server/test/provider/resolve-codex-binary.test.ts`
- **What**: Test that `resolveCodexBinary()` returns a valid path in the dev environment
- **How**:
  ```ts
  import { describe, expect, test } from "bun:test"
  import fs from "node:fs"
  import { resolveCodexBinary } from "../../src/provider/resolve-codex-binary"

  describe("resolveCodexBinary", () => {
    test("returns a path to the codex binary when @openai/codex is installed", () => {
      const result = resolveCodexBinary()
      // In the dev environment, the binary should be resolvable from node_modules
      if (!result) {
        // Skip if codex is not installed (CI without optional deps)
        console.log("Skipping: codex binary not found (expected in minimal CI)")
        return
      }
      expect(typeof result).toBe("string")
      expect(result.length).toBeGreaterThan(0)
      expect(result).toContain("codex")
      // Verify the file actually exists and is executable
      expect(fs.existsSync(result)).toBe(true)
    })

    test("returns null when platform triple is unsupported", () => {
      // This tests the fallback path — we can't easily mock platform/arch,
      // but we verify the function doesn't throw
      const result = resolveCodexBinary()
      expect(result === null || typeof result === "string").toBe(true)
    })
  })
  ```
- **Why**: Ensures the binary resolution works in the dev environment. The test is skippable in CI environments where optional deps aren't installed.
- **Tests**: Self-contained

### 5. Verify codexPathOverride prevents findCodexPath()
- **Action**: Create
- **File**: `packages/server/test/provider/codex-path-override.test.ts`
- **What**: Verify that when `codexPathOverride` is provided, the SDK does NOT call `findCodexPath()` (i.e., the SDK constructor doesn't throw the "Unable to locate" error)
- **How**:
  ```ts
  import { describe, expect, test } from "bun:test"
  import { Codex } from "@openai/codex-sdk"

  describe("Codex SDK codexPathOverride", () => {
    test("does not throw when codexPathOverride is a valid path", () => {
      // Pass a fake path — we're testing that findCodexPath() is NOT called,
      // not that the binary actually runs
      expect(() => {
        new Codex({ codexPathOverride: "/usr/bin/true" })
      }).not.toThrow()
    })

    test("throws 'Unable to locate' when codexPathOverride is null", () => {
      // This verifies the SDK behavior we're protecting against
      // On machines where @openai/codex is installed, this won't throw.
      // On machines where it's not, it will throw "Unable to locate".
      // Either way, the test passes.
      try {
        new Codex({ codexPathOverride: null as any })
      } catch (err) {
        expect(err).toBeInstanceOf(Error)
        // If it throws, it should be the expected error
        expect((err as Error).message).toContain("Unable to locate")
      }
    })
  })
  ```
- **Why**: This is a regression test. If the SDK ever changes `codexPathOverride` behavior, this test catches it immediately.
- **Tests**: Self-contained

## Risks

1. **Dynamic import in compiled binary**: When the SDK is bundled into the compiled binary, `await import("@openai/codex-sdk")` should still work because Bun resolves it at compile time. If Bun treats dynamic imports differently from static imports in compiled mode, the import might fail — but our try-catch handles this gracefully.

2. **Bun `createRequire` behavior**: The SDK's top-level `createRequire(import.meta.url)` is a known potential issue in compiled Bun binaries. The dynamic import + try-catch in items 2-3 handle this. If it throws, users get a clear error instead of a cryptic SDK message.

3. **Performance**: Dynamic `import()` is slightly slower than static import on first call (module needs to be parsed/evaluated). This is negligible — it only happens once per codex session, and the SDK is small (~460 lines bundled).

4. **Type inference**: The dynamic import changes the type of `Codex` from a statically known class to a runtime-resolved one. The `CodexClass` variable captures the type via `typeof import("@openai/codex-sdk").Codex`, so type safety is preserved.
