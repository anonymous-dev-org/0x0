#!/usr/bin/env bun

/**
 * Manually publish the current version to npm.
 *
 * Usage:
 *   bun run script/publish.ts              # publish current version
 *   bun run script/publish.ts --dry-run    # show what would be published
 *
 * Requires NPM_CONFIG_TOKEN to be set, or an active `npm login` session.
 * Normally you don't need this — the release CI publishes automatically.
 */

import { $ } from "bun"

const dryRun = process.argv.includes("--dry-run")
const pkg = await Bun.file("package.json").json()

console.log(`Publishing ${pkg.name}@${pkg.version}`)
console.log()

// Preflight
console.log("Running typecheck...")
await $`bun tsc --noEmit`

console.log("Running tests...")
await $`bun test --preload ./test/preload.ts`

console.log()

if (dryRun) {
  await $`bun publish --access public --dry-run`
} else {
  await $`bun publish --access public`
  console.log()
  console.log(`Published ${pkg.name}@${pkg.version}`)
}
