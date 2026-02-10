#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import os from "os"

const args = process.argv.slice(2)

const read = (name: string) => {
  const i = args.findIndex((x) => x === `--${name}`)
  if (i === -1) return undefined
  return args[i + 1]
}

const flag = (name: string) => args.includes(`--${name}`)

if (flag("help")) {
  console.log(
    [
      "Manual Homebrew tap publish",
      "",
      "Usage:",
      "  ./script/publish-tap.ts --version 1.2.3",
      "  ./script/publish-tap.ts --bump patch",
      "",
      "Options:",
      "  --version <semver>      Release version without v prefix",
      "  --bump <type>           Version bump: patch | minor | major",
      "  --tap <org/repo>        Tap repo (default: <repo-owner>/homebrew-tap)",
      "  --repo <org/repo>       Release repo (default: current repository)",
      "  --formula-name <name>   Formula name (default: zeroxzero)",
      "  --formula <path>        Formula path in tap (default: Formula/<formula-name>.rb)",
      "  --no-push               Do not push commit",
      "",
      "Requires: gh auth login (for release downloads)",
    ].join("\n"),
  )
  process.exit(0)
}

const currentRepo =
  process.env.GITHUB_REPOSITORY ||
  (await $`gh repo view --json nameWithOwner --jq .nameWithOwner`.nothrow().quiet().text()).trim()
const repo = read("repo") ?? currentRepo
if (!repo) {
  throw new Error("Could not determine repository. Pass --repo <org/repo>.")
}
const owner = repo.split("/")[0]
if (!owner) {
  throw new Error(`Invalid --repo value: ${repo}`)
}
const tap = read("tap") ?? `${owner}/homebrew-tap`
const versionArg = read("version")
const bump = read("bump")
const formulaName = read("formula-name") ?? "zeroxzero"
const formula = read("formula") ?? `Formula/${formulaName}.rb`
const noPush = flag("no-push")

if (versionArg && bump) {
  throw new Error("Use either --version or --bump, not both.")
}

if (bump && !["patch", "minor", "major"].includes(bump)) {
  throw new Error("--bump must be one of: patch, minor, major")
}

const klass = formulaName
  .replace(/[^a-zA-Z0-9]+/g, " ")
  .trim()
  .split(/\s+/)
  .filter(Boolean)
  .map((x) => x.charAt(0).toUpperCase() + x.slice(1))
  .join("")

const formulaClass = /^[A-Z]/.test(klass) ? klass : "Zeroxzero"

const latest = await $`gh release list --repo ${repo} --limit 1 --json tagName --jq '.[0].tagName'`
  .nothrow()
  .quiet()
  .text()
  .then((x) => x.trim())
  .then((x) => (x && x !== "null" ? x.replace(/^v/, "") : ""))

const parse = (v: string) => {
  const s = v.split("-").at(0) ?? ""
  const p = s.split(".").map((x) => Number(x))
  if (p.length !== 3 || p.some((x) => Number.isNaN(x) || x < 0)) {
    throw new Error(`Invalid semver: ${v}`)
  }
  return p as [number, number, number]
}

const next = (v: string, t: string) => {
  const [major, minor, patch] = parse(v)
  if (t === "major") return `${major + 1}.0.0`
  if (t === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

const versionRaw =
  versionArg ??
  (bump
    ? next(latest || "0.0.0", bump)
    : await $`gh release list --repo ${repo} --limit 1 --json tagName --jq '.[0].tagName'`
        .nothrow()
        .quiet()
        .text()
        .then((x) => x.trim())
        .then((x) => {
          if (x && x !== "null") return x.replace(/^v/, "")
          throw new Error(`No latest release found for ${repo}. Pass --version <semver> or --bump <type>.`)
        }))
if (!versionRaw) {
  throw new Error("Could not resolve release version")
}
const version = versionRaw

const files = ["0x0-darwin-arm64.zip", "0x0-darwin-x64.zip", "0x0-linux-arm64.tar.gz", "0x0-linux-x64.tar.gz"]

const releaseCheck = await $`gh release view v${version} --repo ${repo} --json tagName`.nothrow().quiet()
if (releaseCheck.exitCode !== 0) {
  if (bump) {
    throw new Error(
      `Computed v${version} from --bump ${bump}, but release v${version} does not exist in ${repo}. Create and upload release assets first.`,
    )
  }
  throw new Error(`Release v${version} was not found in ${repo}.`)
}

const hash = async (file: string) => {
  const data = await Bun.file(file).arrayBuffer()
  const digest = await crypto.subtle.digest("SHA-256", data)
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("")
}

const root = new URL("..", import.meta.url).pathname
process.chdir(root)

const dir = await $`mktemp -d ${path.join(os.tmpdir(), "0x0-tap-XXXXXXXX")}`.text()
const tmp = dir.trim()
const assetsDir = path.join(tmp, "assets")
const tapDir = path.join(tmp, "tap")

await $`mkdir -p ${assetsDir}`

for (const file of files) {
  console.log("download", file)
  const result = await $`gh release download v${version} --repo ${repo} --pattern ${file} --dir ${assetsDir} --clobber`
    .nothrow()
    .quiet()
  if (result.exitCode !== 0) {
    throw new Error(`Release v${version} is missing required asset: ${file}`)
  }
}

const macArm64Sha = await hash(path.join(assetsDir, "0x0-darwin-arm64.zip"))
const macX64Sha = await hash(path.join(assetsDir, "0x0-darwin-x64.zip"))
const linuxArm64Sha = await hash(path.join(assetsDir, "0x0-linux-arm64.tar.gz"))
const linuxX64Sha = await hash(path.join(assetsDir, "0x0-linux-x64.tar.gz"))

const formulaText = [
  "# typed: false",
  "# frozen_string_literal: true",
  "",
  `class ${formulaClass} < Formula`,
  '  desc "The AI coding agent built for the terminal."',
  `  homepage "https://github.com/${repo}"`,
  `  version "${version.split("-")[0]}"`,
  "",
  '  depends_on "ripgrep"',
  "",
  "  on_macos do",
  "    if Hardware::CPU.intel?",
  `      url "https://github.com/${repo}/releases/download/v${version}/0x0-darwin-x64.zip"`,
  `      sha256 "${macX64Sha}"`,
  "",
  "      def install",
  '        bin.install "zeroxzero" => "0x0"',
  "      end",
  "    end",
  "    if Hardware::CPU.arm?",
  `      url "https://github.com/${repo}/releases/download/v${version}/0x0-darwin-arm64.zip"`,
  `      sha256 "${macArm64Sha}"`,
  "",
  "      def install",
  '        bin.install "zeroxzero" => "0x0"',
  "      end",
  "    end",
  "  end",
  "",
  "  on_linux do",
  "    if Hardware::CPU.intel? and Hardware::CPU.is_64_bit?",
  `      url "https://github.com/${repo}/releases/download/v${version}/0x0-linux-x64.tar.gz"`,
  `      sha256 "${linuxX64Sha}"`,
  "      def install",
  '        bin.install "zeroxzero" => "0x0"',
  "      end",
  "    end",
  "    if Hardware::CPU.arm? and Hardware::CPU.is_64_bit?",
  `      url "https://github.com/${repo}/releases/download/v${version}/0x0-linux-arm64.tar.gz"`,
  `      sha256 "${linuxArm64Sha}"`,
  "      def install",
  '        bin.install "zeroxzero" => "0x0"',
  "      end",
  "    end",
  "  end",
  "end",
  "",
].join("\n")

const tapUrl = `git@github.com:${tap}.git`

await $`git clone ${tapUrl} ${tapDir}`

const formulaPath = path.join(tapDir, formula)
await Bun.write(formulaPath, formulaText)

const aliasPath = path.join(tapDir, "Aliases", "0x0")
await $`mkdir -p ${path.dirname(aliasPath)}`
if (formulaName !== "0x0") {
  await $`ln -sf ../${formula} ${aliasPath}`
}

await $`git -C ${tapDir} add ${formula} ${aliasPath}`
const status = await $`git -C ${tapDir} status --porcelain`.text()
if (!status.trim()) {
  console.log(`No changes for ${formula} at v${version}`)
  process.exit(0)
}

await $`git -C ${tapDir} commit -m "${formulaName}: update to v${version}"`

if (!noPush) {
  await $`git -C ${tapDir} push`
}

console.log(`Published ${formula} to ${tap} at v${version}`)
console.log(`Temp dir: ${tmp}`)
