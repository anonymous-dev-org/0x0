#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import os from "os"
import fs from "fs/promises"

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
      "Publish a Neovim plugin subdirectory to its standalone repo",
      "",
      "Usage:",
      "  ./script/publish-nvim.ts --plugin nvim-completion --version 1.2.3",
      "  ./script/publish-nvim.ts --plugin nvim --version 1.2.3",
      "",
      "Options:",
      "  --plugin <name>       Plugin directory under sdks/ (required)",
      "  --version <semver>    Release version without v prefix (reads sdks/<plugin>/version.txt if omitted)",
      "  --repo <org/repo>     Target repo (default: derived from plugin name)",
      "  --no-push             Do not push commit or tag",
      "  --help                Show this help",
      "",
      "Default repo mapping:",
      "  nvim            -> <owner>/0x0.nvim",
      "  nvim-completion -> <owner>/0x0-completion.nvim",
    ].join("\n"),
  )
  process.exit(0)
}

const plugin = read("plugin")
if (!plugin) {
  throw new Error("--plugin is required. Pass --help for usage.")
}

const noPush = flag("no-push")

const root = new URL("..", import.meta.url).pathname
const sourceDir = path.join(root, "sdks", plugin)

try {
  await fs.access(sourceDir)
} catch {
  throw new Error(`Source directory not found: ${sourceDir}`)
}

const version = read("version") ?? await (async () => {
  const versionFile = path.join(sourceDir, "version.txt")
  try {
    return (await fs.readFile(versionFile, "utf-8")).trim()
  } catch {
    throw new Error(`--version is required (no version.txt found at ${versionFile})`)
  }
})()

const currentRepo =
  process.env.GITHUB_REPOSITORY ||
  (await $`gh repo view --json nameWithOwner --jq .nameWithOwner`.nothrow().quiet().text()).trim()
const owner = currentRepo?.split("/")[0]
if (!owner) {
  throw new Error("Could not determine repo owner. Pass --repo <org/repo>.")
}

const repoMapping: Record<string, string> = {
  nvim: `${owner}/0x0.nvim`,
  "nvim-completion": `${owner}/0x0-completion.nvim`,
}

const repo = read("repo") ?? repoMapping[plugin]
if (!repo) {
  throw new Error(
    `No default repo mapping for plugin "${plugin}". Pass --repo <org/repo>.`,
  )
}

const repoUrl = `git@github.com:${repo}.git`

const dir = await $`mktemp -d ${path.join(os.tmpdir(), `0x0-nvim-${plugin}-XXXXXXXX`)}`.text()
const tmp = dir.trim()

console.log(`Cloning ${repo} into ${tmp}`)
await $`git clone ${repoUrl} ${tmp}`

// Remove all tracked files except .git/
await $`git -C ${tmp} rm -rf .`.quiet().nothrow()
await $`git -C ${tmp} checkout -- .git`.quiet().nothrow()

// Copy all files from source dir to repo root (including hidden files)
await $`bash -c ${"cp -r " + sourceDir + "/. " + tmp + "/"}`.quiet()

// Stage all changes
await $`git -C ${tmp} add -A`

// Check if anything changed
const status = await $`git -C ${tmp} status --porcelain`.text()
if (!status.trim()) {
  console.log(`No changes for ${plugin} at v${version}`)
  process.exit(0)
}

// Commit and tag
await $`git -C ${tmp} commit -m ${"v" + version}`
await $`git -C ${tmp} tag ${"v" + version}`

if (!noPush) {
  await $`git -C ${tmp} push`
  await $`git -C ${tmp} push --tags`
} else {
  console.log("Skipping push (--no-push)")
}

console.log(`Published ${plugin} to ${repo} at v${version}`)
console.log(`Temp dir: ${tmp}`)
