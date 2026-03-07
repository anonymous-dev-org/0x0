import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { Log } from "@/util/log"

const log = Log.create({ service: "resolve-codex-binary" })

const CODEX_NPM_NAME = "@openai/codex"

const PLATFORM_PACKAGE: Record<string, string> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
}

function targetTriple(): string | undefined {
  const platform = process.platform
  const arch = process.arch
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-musl"
  if (platform === "linux" && arch === "arm64") return "aarch64-unknown-linux-musl"
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin"
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin"
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc"
  if (platform === "win32" && arch === "arm64") return "aarch64-pc-windows-msvc"
  return undefined
}

/**
 * Resolve the path to the `codex` CLI binary.
 *
 * Strategy (in order):
 * 1. Resolve from node_modules via `createRequire` (same as SDK's findCodexPath)
 * 2. Look for the binary relative to this file's directory (handles workspace hoisting)
 * 3. Fall back to `Bun.which("codex")` / system PATH
 *
 * Returns `null` if the binary cannot be found anywhere.
 */
export function resolveCodexBinary(): string | null {
  const triple = targetTriple()
  if (!triple) return systemFallback()

  const platformPkg = PLATFORM_PACKAGE[triple]
  if (!platformPkg) return systemFallback()

  const binaryName = process.platform === "win32" ? "codex.exe" : "codex"

  // Strategy 1: createRequire from import.meta.url (works in dev, may fail in compiled binary)
  try {
    const req = createRequire(import.meta.url)
    const codexPkgJson = req.resolve(`${CODEX_NPM_NAME}/package.json`)
    const codexReq = createRequire(codexPkgJson)
    const platformPkgJson = codexReq.resolve(`${platformPkg}/package.json`)
    const vendorRoot = path.join(path.dirname(platformPkgJson), "vendor")
    const binaryPath = path.join(vendorRoot, triple, "codex", binaryName)
    if (fs.existsSync(binaryPath)) {
      log.info("strategy 1: found via createRequire", { binaryPath })
      return binaryPath
    }
    log.info("strategy 1: path resolved but binary missing", { binaryPath })
  } catch (err) {
    log.info("strategy 1: createRequire failed", { error: err instanceof Error ? err.message : String(err) })
  }

  // Strategy 2: Walk up from this file looking for node_modules
  try {
    const searchRoots = [
      // From this file's location
      path.dirname(new URL(import.meta.url).pathname),
      // From cwd (handles monorepo root)
      process.cwd(),
    ]

    for (const root of searchRoots) {
      let dir = root
      for (let i = 0; i < 10; i++) {
        const candidate = path.join(dir, "node_modules", platformPkg, "vendor", triple, "codex", binaryName)
        if (fs.existsSync(candidate)) {
          log.info("strategy 2: found via directory walk", { candidate, root })
          return candidate
        }
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }
    log.info("strategy 2: not found via directory walk", { searchRoots })
  } catch (err) {
    log.info("strategy 2: directory walk failed", { error: err instanceof Error ? err.message : String(err) })
  }

  const fallbackResult = systemFallback()
  log.info(fallbackResult ? "strategy 3: found on PATH" : "strategy 3: not found on PATH", { path: fallbackResult })
  return fallbackResult
}

function systemFallback(): string | null {
  return Bun.which("codex") ?? null
}
