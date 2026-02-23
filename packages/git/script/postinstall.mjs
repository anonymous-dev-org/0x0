#!/usr/bin/env node

import fs from "fs"
import path from "path"
import os from "os"
import { fileURLToPath } from "url"
import { createRequire } from "module"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const useColor = !process.env.NO_COLOR && process.stdout.isTTY
const bold = (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s)
const green = (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s)
const yellow = (s) => (useColor ? `\x1b[33m${s}\x1b[0m` : s)

function detectPlatformAndArch() {
  let platform
  switch (os.platform()) {
    case "darwin":
      platform = "darwin"
      break
    case "linux":
      platform = "linux"
      break
    case "win32":
      platform = "windows"
      break
    default:
      platform = os.platform()
      break
  }

  let arch
  switch (os.arch()) {
    case "x64":
      arch = "x64"
      break
    case "arm64":
      arch = "arm64"
      break
    case "arm":
      arch = "arm"
      break
    default:
      arch = os.arch()
      break
  }

  return { platform, arch }
}

function findBinary() {
  const { platform, arch } = detectPlatformAndArch()
  const binaryName = platform === "windows" ? "0x0-git.exe" : "0x0-git"
  const scope = process.env.ZEROXZERO_NPM_SCOPE || "@anonymous-dev"
  const names = [`${scope}/0x0-git-${platform}-${arch}`, `0x0-git-${platform}-${arch}`]

  for (const packageName of names) {
    try {
      const packageJsonPath = require.resolve(`${packageName}/package.json`)
      const packageDir = path.dirname(packageJsonPath)
      const binaryPath = path.join(packageDir, "bin", binaryName)
      if (!fs.existsSync(binaryPath)) {
        continue
      }
      return { binaryPath, binaryName }
    } catch {
      continue
    }
  }

  throw new Error(`Could not find platform package for 0x0-git-${platform}-${arch}`)
}

function getVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"))
    return pkg.version || "unknown"
  } catch {
    return "unknown"
  }
}

function checkServer() {
  const scope = process.env.ZEROXZERO_NPM_SCOPE || "@anonymous-dev"
  try {
    const pkgPath = require.resolve(`${scope}/0x0/package.json`)
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
    return { found: true, version: pkg.version, scope }
  } catch {
    return { found: false, scope }
  }
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

function printBox(lines) {
  const maxVisual = Math.max(...lines.map((l) => stripAnsi(l).length))
  const width = maxVisual + 4
  const top = `  ┌${"─".repeat(width)}┐`
  const bot = `  └${"─".repeat(width)}┘`
  const empty = `  │${" ".repeat(width)}│`

  console.log("")
  console.log(top)
  console.log(empty)
  for (const line of lines) {
    const pad = width - 2 - stripAnsi(line).length
    console.log(`  │  ${line}${" ".repeat(Math.max(0, pad))}│`)
  }
  console.log(empty)
  console.log(bot)
  console.log("")
}

async function main() {
  try {
    if (os.platform() === "win32") {
      console.log("Windows detected: binary setup not needed (using packaged .exe)")
      return
    }

    const { binaryPath } = findBinary()
    const { platform, arch } = detectPlatformAndArch()
    const version = getVersion()

    const lines = [bold(`0x0-git v${version}`), ""]
    lines.push(`${green("✓")} Platform: ${platform}-${arch}`)
    lines.push(`${green("✓")} Binary verified`)

    const server = checkServer()
    if (server.found) {
      lines.push(`${green("✓")} Server: ${server.scope}/0x0 v${server.version}`)
    } else {
      lines.push(`${yellow("!")} Server: ${server.scope}/0x0 not found`)
      lines.push(`  Install: npm install -g ${server.scope}/0x0`)
    }

    lines.push("")
    lines.push(`Run: ${bold("0x0-git --help")}`)

    printBox(lines)
  } catch (error) {
    console.error("Failed to setup 0x0-git binary:", error.message)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error("Postinstall script error:", error.message)
  process.exit(0)
})
