#!/usr/bin/env bun
/**
 * Build script for the 0x0 server.
 *
 * Usage:
 *   bun run script/build.ts [--single] [--archive] [--os <os>] [--arch <arch>]
 *
 * Flags:
 *   --single   Compile to a standalone single-file executable (bun build --compile)
 *   --archive  Create a .tar.gz (linux) or .zip (darwin/win) archive of the binary
 *   --os       Target OS: linux, darwin, win32 (default: current platform)
 *   --arch     Target arch: x64, arm64 (default: current arch)
 */

import { mkdirSync, existsSync, unlinkSync } from "node:fs"
import { join, resolve } from "node:path"

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const opt = (name: string) => {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 ? args[idx + 1] : undefined
}

const single = flag("single")
const archive = flag("archive")
const targetOs = opt("os") ?? process.platform
const targetArch = opt("arch") ?? process.arch

const version =
  process.env.ZEROXZERO_VERSION ??
  (await Bun.file(join(import.meta.dir, "../package.json")).json()).version
const channel = process.env.ZEROXZERO_CHANNEL ?? "local"

const distDir = resolve(import.meta.dir, "../dist")
mkdirSync(distDir, { recursive: true })

const entrypoint = resolve(import.meta.dir, "../src/index.ts")

// Binary naming
const ext = targetOs === "win32" ? ".exe" : ""
const binaryName = `0x0-server${ext}`
const archiveName = `0x0-server-${targetOs}-${targetArch}`

console.log(`Building 0x0-server v${version} (${channel})`)
console.log(`  target: ${targetOs}-${targetArch}`)
console.log(`  single: ${single}`)
console.log(`  archive: ${archive}`)

if (single) {
  // Bun compile target mapping
  const bunTarget = (() => {
    const os = targetOs === "win32" ? "windows" : targetOs
    return `bun-${os}-${targetArch}`
  })()

  const outPath = join(distDir, binaryName)

  // Clean previous build
  if (existsSync(outPath)) unlinkSync(outPath)

  const result = Bun.spawnSync([
    "bun",
    "build",
    "--compile",
    "--minify",
    `--target=${bunTarget}`,
    `--outfile=${outPath}`,
    `--define=ZEROXZERO_VERSION="${version}"`,
    `--define=ZEROXZERO_CHANNEL="${channel}"`,
    entrypoint,
  ])

  if (result.exitCode !== 0) {
    console.error("Build failed:", result.stderr.toString())
    process.exit(1)
  }

  console.log(`  output: ${outPath}`)

  if (archive) {
    const checksumLines: string[] = []

    if (targetOs === "linux") {
      const tarName = `${archiveName}.tar.gz`
      const tarPath = join(distDir, tarName)
      Bun.spawnSync(["tar", "-czf", tarPath, "-C", distDir, binaryName])
      console.log(`  archive: ${tarPath}`)
      const hash = await sha256File(tarPath)
      checksumLines.push(`${hash}  ${tarName}`)
    } else {
      const zipName = `${archiveName}.zip`
      const zipPath = join(distDir, zipName)
      Bun.spawnSync(["zip", "-j", zipPath, outPath])
      console.log(`  archive: ${zipPath}`)
      const hash = await sha256File(zipPath)
      checksumLines.push(`${hash}  ${zipName}`)
    }

    // Write checksums
    const sumsPath = join(distDir, "SHA256SUMS")
    await Bun.write(sumsPath, checksumLines.join("\n") + "\n")
    console.log(`  checksums: ${sumsPath}`)
  }
} else {
  console.log("Non-single build: nothing to do (use bun run dev for development)")
}

async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  const file = Bun.file(path)
  hasher.update(await file.arrayBuffer())
  return hasher.digest("hex")
}
