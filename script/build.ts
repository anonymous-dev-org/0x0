#!/usr/bin/env bun

import path from "path"
import fs from "fs/promises"
import { $ } from "bun"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const pkg = await Bun.file("package.json").json()

const singleFlag = process.argv.includes("--single")
const archiveFlag = process.argv.includes("--archive")
const osFlag = argValue("--os")
const archFlag = argValue("--arch")
const version = process.env.ZEROXZERO_VERSION || pkg.version || "local"
const channel = process.env.ZEROXZERO_CHANNEL || "local"

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag)
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined
}

interface Target {
  os: string
  arch: "arm64" | "x64"
}

const allTargets: Target[] = [
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "win32", arch: "x64" },
]

const targetOs = osFlag || process.platform
const targetArch = archFlag || process.arch

const targets = singleFlag
  ? allTargets.filter((item) => item.os === targetOs && item.arch === targetArch)
  : allTargets

if (targets.length === 0) {
  console.error(`No matching target for ${targetOs}/${targetArch}`)
  process.exit(1)
}

function artifactName(t: Target): string {
  const osName = t.os === "win32" ? "windows" : t.os
  return `0x0-${osName}-${t.arch}`
}

function bunTarget(t: Target): string {
  const osName = t.os === "win32" ? "windows" : t.os
  return `bun-${osName}-${t.arch}`
}

console.log(`0x0 build v${version} (${channel})`)
console.log(`Targets: ${targets.map(artifactName).join(", ")}`)
console.log()

await $`rm -rf dist`

const checksums: Array<{ file: string; sha256: string }> = []

for (const item of targets) {
  const name = artifactName(item)
  const binDir = `dist/${name}/bin`
  const binName = item.os === "win32" ? "0x0.exe" : "0x0"
  const outfile = `${binDir}/${binName}`

  console.log(`building ${name}`)
  await fs.mkdir(binDir, { recursive: true })

  await Bun.build({
    tsconfig: "./tsconfig.json",
    sourcemap: "external",
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      // @ts-ignore — cross-compile target string
      target: bunTarget(item),
      outfile,
      execArgv: [`--user-agent=zeroxzero/${version}`, "--use-system-ca", "--"],
    },
    entrypoints: ["./src/index.ts"],
    define: {
      ZEROXZERO_VERSION: `'${version}'`,
      ZEROXZERO_CHANNEL: `'${channel}'`,
    },
  })

  // Package metadata
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name: `@anonymous-dev/${name}`,
        version,
        os: [item.os],
        cpu: [item.arch],
      },
      null,
      2,
    ),
  )

  // Create archive
  if (archiveFlag) {
    await $`tar -czf dist/${name}.tar.gz -C ${binDir} ${binName}`.quiet()
    checksums.push(await checksum(`dist/${name}.tar.gz`))
  }
}

// Write checksums manifest
if (archiveFlag && checksums.length > 0) {
  const manifest = checksums.map(c => `${c.sha256}  ${c.file}`).join("\n") + "\n"
  await Bun.write("dist/SHA256SUMS", manifest)
  console.log()
  console.log("SHA256SUMS:")
  console.log(manifest)
}

console.log("Build complete")

async function checksum(filepath: string): Promise<{ file: string; sha256: string }> {
  const data = await Bun.file(filepath).arrayBuffer()
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(new Uint8Array(data))
  const sha256 = hasher.digest("hex")
  return { file: path.basename(filepath), sha256 }
}
