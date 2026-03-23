#!/usr/bin/env bun

/**
 * Bump the version in package.json, commit, and tag.
 *
 * Usage:
 *   bun run script/version.ts patch     # 3.0.0 → 3.0.1
 *   bun run script/version.ts minor     # 3.0.0 → 3.1.0
 *   bun run script/version.ts major     # 3.0.0 → 4.0.0
 *   bun run script/version.ts 3.2.0     # set exact version
 *   bun run script/version.ts           # show current version
 *
 * Flags:
 *   --no-commit   Skip git commit + tag
 *   --no-tag      Create commit but skip tag
 */

import { $ } from "bun"

const pkg = await Bun.file("package.json").json()
const current = pkg.version as string
const args = process.argv.slice(2).filter(a => !a.startsWith("--"))
const bump = args[0]
const noCommit = process.argv.includes("--no-commit")
const noTag = process.argv.includes("--no-tag")

if (!bump) {
  console.log(current)
  process.exit(0)
}

function bumpVersion(version: string, type: string): string {
  if (/^\d+\.\d+\.\d+/.test(type)) return type

  const [major, minor, patch] = version.split(".").map(Number)
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(`Invalid version: ${version}`)
  }

  switch (type) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`
    case "minor":
      return `${major}.${minor + 1}.0`
    case "major":
      return `${major + 1}.0.0`
    default:
      throw new Error(`Unknown bump type: ${type}. Use patch, minor, major, or an exact version.`)
  }
}

const next = bumpVersion(current, bump)

console.log(`${current} → ${next}`)

// Update package.json
pkg.version = next
await Bun.write("package.json", JSON.stringify(pkg, null, 2) + "\n")

if (noCommit) {
  console.log("Version updated (skipping commit)")
  process.exit(0)
}

// Commit
await $`git add package.json`
await $`git commit -m "chore: bump version to ${next}"`

if (noTag) {
  console.log(`Committed v${next} (skipping tag)`)
  process.exit(0)
}

// Tag
await $`git tag -f v${next}`
console.log(`Tagged v${next}`)
console.log()
console.log(`To release: git push && git push --tags`)
