// Set env vars BEFORE any imports from src/ directory
// xdg-basedir reads env vars at import time

import { afterAll } from "bun:test"
import fsSync from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"

const dir = path.join(os.tmpdir(), "zeroxzero-test-data-" + process.pid)
await fs.mkdir(dir, { recursive: true })
afterAll(() => {
  fsSync.rmSync(dir, { recursive: true, force: true })
})

const testHome = path.join(dir, "home")
await fs.mkdir(testHome, { recursive: true })
process.env["ZEROXZERO_TEST_HOME"] = testHome

const testManagedConfigDir = path.join(dir, "managed")
process.env["ZEROXZERO_TEST_MANAGED_CONFIG_DIR"] = testManagedConfigDir

process.env["XDG_DATA_HOME"] = path.join(dir, "share")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")

const configDir = path.join(dir, "config", "0x0")
await fs.mkdir(configDir, { recursive: true })
await fs.writeFile(path.join(configDir, "config.json"), "{}")

const cacheDir = path.join(dir, "cache", "zeroxzero")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "21")

// Clear provider env vars
delete process.env["ANTHROPIC_API_KEY"]
delete process.env["OPENAI_API_KEY"]

const { Log } = await import("../src/util/log")

Log.init({
  print: false,
  dev: true,
  level: "DEBUG",
})
