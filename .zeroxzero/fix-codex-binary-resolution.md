# Fix Codex CLI Binary Resolution

## Goal
Fix the "Unable to locate Codex CLI binaries" / "Cannot find package" error when using OpenAI models (gpt-5-codex, o3, o4-mini) by ensuring the codex CLI binary is properly installed and resolvable in both development and compiled binary scenarios.

## Requirements
1. OpenAI models (gpt-5-codex, o3, o4-mini) must work when the codex CLI binary is available
2. `ProviderAuth.isAvailable("codex")` must accurately reflect whether the codex provider can actually function
3. The fix must work in both development (running from source) and production (compiled Bun binary)
4. Clear error messaging when the codex binary is genuinely unavailable

## Root Cause
- `@openai/codex-sdk` spawns the `codex` CLI binary as a child process (not an in-process API)
- The binary comes from `@openai/codex` → platform-specific optional deps (e.g., `@openai/codex-darwin-arm64`)
- `@openai/codex` is only a transitive dependency (via `@openai/codex-sdk`) and is NOT installed in node_modules — Bun is failing to resolve it
- The SDK's `findCodexPath()` uses `createRequire(import.meta.url)` which won't work in compiled Bun binaries
- `ProviderAuth.isAvailable("codex")` checks `Bun.which("codex")` (system PATH) which is misaligned with the SDK's resolution strategy
- `codexAppServerStream` creates `new Codex()` without `codexPathOverride`, letting the SDK's broken resolution fail

## Plan

### 1. Add `@openai/codex` as direct dependency
- **Action**: Modify
- **File**: `packages/server/package.json`
- **What**: Add `"@openai/codex": "0.106.0"` to `dependencies` (same version as `@openai/codex-sdk`)
- **How**: Add the entry alongside the existing `@openai/codex-sdk` dependency. This forces Bun to install the package directly (not just as a transitive dep), which ensures the platform-specific optional dependencies are also resolved.
- **Why**: `@openai/codex` is currently only a transitive dep via `@openai/codex-sdk` and Bun is not installing it. Making it direct ensures the binary packages are available.
- **Tests**: After `bun install`, verify `packages/server/node_modules/@openai/codex/package.json` exists and the platform-specific vendor binary is present.

### 2. Create codex binary resolution utility
- **Action**: Create
- **File**: `packages/server/src/provider/sdk/codex-app-server/resolve-binary.ts`
- **What**: Export `resolveCodexBinaryPath(): string | null`
- **How**:
  ```ts
  import { createRequire } from "module"
  import path from "path"

  export function resolveCodexBinaryPath(): string | null {
    // Strategy 1: Try resolving from node_modules (works in dev)
    const fromNodeModules = resolveFromNodeModules()
    if (fromNodeModules) return fromNodeModules

    // Strategy 2: System PATH (works for compiled binary + globally installed codex)
    const fromPath = typeof Bun !== "undefined" ? Bun.which("codex") : null
    if (fromPath) return fromPath

    return null
  }

  function resolveFromNodeModules(): string | null {
    const { platform, arch } = process
    const PLATFORM_PACKAGE: Record<string, string> = {
      "darwin-arm64": "@openai/codex-darwin-arm64",
      "darwin-x64": "@openai/codex-darwin-x64",
      "linux-arm64": "@openai/codex-linux-arm64",
      "linux-x64": "@openai/codex-linux-x64",
      "win32-arm64": "@openai/codex-win32-arm64",
      "win32-x64": "@openai/codex-win32-x64",
    }
    const TARGET_TRIPLE: Record<string, string> = {
      "darwin-arm64": "aarch64-apple-darwin",
      "darwin-x64": "x86_64-apple-darwin",
      "linux-arm64": "aarch64-unknown-linux-musl",
      "linux-x64": "x86_64-unknown-linux-musl",
      "win32-arm64": "aarch64-pc-windows-msvc",
      "win32-x64": "x86_64-pc-windows-msvc",
    }
    const key = `${platform}-${arch}`
    const platformPackage = PLATFORM_PACKAGE[key]
    const targetTriple = TARGET_TRIPLE[key]
    if (!platformPackage || !targetTriple) return null

    try {
      const moduleRequire = createRequire(import.meta.url)
      const codexPkgPath = moduleRequire.resolve("@openai/codex/package.json")
      const codexRequire = createRequire(codexPkgPath)
      const platformPkgPath = codexRequire.resolve(`${platformPackage}/package.json`)
      const vendorRoot = path.join(path.dirname(platformPkgPath), "vendor")
      const binaryName = platform === "win32" ? "codex.exe" : "codex"
      const binaryPath = path.join(vendorRoot, targetTriple, "codex", binaryName)
      // Verify the file actually exists
      try { require("fs").accessSync(binaryPath, require("fs").constants.X_OK); return binaryPath } catch { return null }
    } catch {
      return null
    }
  }
  ```
- **Why**: Centralizes binary resolution with multiple fallback strategies — node_modules first (for dev), system PATH second (for compiled binary). Mirrors the SDK's own `findCodexPath()` logic but with graceful fallbacks instead of throwing.
- **Tests**: Unit test with mocked `Bun.which` and file system checks (item #5)

### 3. Update ProviderAuth to use binary resolution
- **Action**: Modify
- **File**: `packages/server/src/provider/auth.ts`
- **What**: Change `isAvailable("codex")` to use `resolveCodexBinaryPath()` instead of `Bun.which("codex")`
- **How**:
  ```ts
  import { resolveCodexBinaryPath } from "./sdk/codex-app-server/resolve-binary"

  export namespace ProviderAuth {
    export function isAvailable(providerID: string, envPath?: string): Promise<boolean> {
      const opts = envPath !== undefined ? { PATH: envPath } : undefined
      if (providerID === "claude-code") {
        return Promise.resolve(Bun.which("claude", opts) !== null)
      }
      if (providerID === "codex") {
        // When envPath is provided (tests), fall back to Bun.which for backward compat
        if (envPath !== undefined) {
          return Promise.resolve(Bun.which("codex", opts) !== null)
        }
        return Promise.resolve(resolveCodexBinaryPath() !== null)
      }
      return Promise.resolve(false)
    }
  }
  ```
- **Why**: Ensures `isAvailable()` accurately reflects whether the codex provider can actually run, not just whether a binary named `codex` is on system PATH.
- **Tests**: Existing auth behavior preserved for claude-code; codex check now properly detects node_modules binary.

### 4. Pass codexPathOverride to SDK
- **Action**: Modify
- **File**: `packages/server/src/provider/sdk/codex-app-server/index.ts`
- **What**: Resolve codex binary path before creating `new Codex()` and pass it as `codexPathOverride`
- **How**: In `codexAppServerStream()`, before the `try` block at line 161:
  ```ts
  import { resolveCodexBinaryPath } from "./resolve-binary"
  
  // ... inside codexAppServerStream, before `const codex = new Codex(...)`:
  const codexPath = resolveCodexBinaryPath()
  if (!codexPath) {
    yield { type: "error", message: "Codex CLI binary not found. Install @openai/codex or add codex to PATH." }
    return
  }
  
  const codex = new Codex({
    codexPathOverride: codexPath,
    config: { ... },  // existing config
  })
  ```
- **Why**: Bypasses the SDK's `findCodexPath()` which uses `createRequire(import.meta.url)` — this doesn't work in compiled Bun binaries. By resolving the path ourselves and passing it, we control the resolution strategy.
- **Tests**: Covered by existing `codex-app-server.test.ts` + new unit test for resolve-binary.

### 5. Add unit tests for binary resolution
- **Action**: Create
- **File**: `packages/server/test/provider/codex-resolve-binary.test.ts`
- **What**: Tests for `resolveCodexBinaryPath()`
- **How**:
  - Test that `resolveCodexBinaryPath()` returns a non-null string when the codex package is properly installed
  - Test that it returns a string ending in `/codex` (or `\codex.exe` on Windows)
  - Test that when `@openai/codex` isn't resolvable, it falls back to `Bun.which("codex")`
- **Why**: Ensure the resolution utility works correctly across strategies.
- **Tests**: Self-contained test file.

## Risks

1. **Bun optional dependency installation**: Adding `@openai/codex` as a direct dependency SHOULD cause Bun to install its platform-specific optional deps, but Bun has had bugs with optional deps using npm aliases (`npm:@openai/codex@0.106.0-darwin-arm64`). If this doesn't work, we may need to add the platform-specific packages directly to `package.json` (e.g., `"@openai/codex-darwin-arm64": "npm:@openai/codex@0.106.0-darwin-arm64"` in `optionalDependencies`).

2. **Build size**: The `@openai/codex` platform binaries are Rust-compiled executables (~50-100MB). They won't be embedded in the compiled Bun binary (since Bun.build doesn't bundle native binaries), so compiled binary users MUST have codex installed globally. This is the expected behavior.

3. **`createRequire` in compiled binary**: `createRequire(import.meta.url)` in `resolve-binary.ts` will fail inside a compiled Bun binary (no node_modules). This is expected — the function gracefully falls back to `Bun.which("codex")`. The try/catch handles this.

4. **Version coupling**: `@openai/codex` is pinned to the same version as `@openai/codex-sdk` (0.106.0). When updating `codex-sdk`, the `codex` dependency must also be updated. Consider adding a comment in `package.json` noting this coupling.
