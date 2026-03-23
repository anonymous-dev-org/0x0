#!/usr/bin/env bun

/**
 * Release a new version of 0x0.
 *
 * Usage:
 *   bun run script/release.ts patch        # 4.0.0 → 4.0.1
 *   bun run script/release.ts minor        # 4.0.0 → 4.1.0
 *   bun run script/release.ts major        # 4.0.0 → 5.0.0
 *   bun run script/release.ts 4.2.0        # exact version
 *
 * Flags:
 *   --dry-run   Show what would happen without making changes
 *
 * Steps:
 *   1. Run typecheck + tests
 *   2. Bump version, commit, and tag (via version.ts)
 *   3. Push commit and tag to origin
 *   4. CI takes over: build → GitHub Release → npm publish
 */

import { $ } from "bun"

const args = process.argv.slice(2).filter(a => !a.startsWith("--"))
const dryRun = process.argv.includes("--dry-run")
const bump = args[0]

if (!bump) {
  console.error("Usage: bun run release <patch|minor|major|x.y.z> [--dry-run]")
  process.exit(1)
}

const pkg = await Bun.file("package.json").json()
const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim()

if (branch !== "main") {
  console.error(`Error: releases must be cut from main (currently on ${branch})`)
  process.exit(1)
}

// Check for uncommitted changes
const status = (await $`git status --porcelain`.text()).trim()
if (status) {
  console.error("Error: working tree is dirty — commit or stash changes first")
  console.error(status)
  process.exit(1)
}

// Check remote is up to date
await $`git fetch origin main --quiet`
const local = (await $`git rev-parse HEAD`.text()).trim()
const remote = (await $`git rev-parse origin/main`.text()).trim()
if (local !== remote) {
  console.error("Error: local main is out of sync with origin/main — pull or push first")
  process.exit(1)
}

console.log(`Current version: ${pkg.version}`)
console.log()

if (dryRun) {
  console.log("[dry-run] Would run: typecheck + tests")
  console.log(`[dry-run] Would bump: ${bump}`)
  console.log("[dry-run] Would push commit and tag to origin")
  process.exit(0)
}

// 1. Typecheck + tests
console.log("Running typecheck...")
await $`bun tsc --noEmit`

console.log("Running tests...")
await $`bun test --preload ./test/preload.ts`

console.log()

// 2. Bump version, commit, tag
await $`bun run script/version.ts ${bump}`

// Read the new version from the freshly written package.json
const updated = await Bun.file("package.json").json()
const next = updated.version

console.log()

// 3. Push
console.log("Pushing to origin...")
await $`git push origin main`
await $`git push origin v${next} --force`

console.log()
console.log(`Release v${next} pushed — CI will build, create a GitHub Release, and publish to npm.`)
