#!/usr/bin/env bun

import { $ } from "bun"
import { parseArgs } from "node:util"
import { fileURLToPath } from "node:url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const args = parseArgs({
  options: {
    scope: { type: "string", default: "@anonymous-dev" },
    tag: { type: "string", default: "latest" },
    version: { type: "string" },
    otp: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
})

const dry = args.values["dry-run"]
const scope = args.values.scope
const tag = args.values.tag
const otp = args.values.otp
const token = process.env.ZEROXZERO_NPM_TOKEN ?? process.env.NPM_TOKEN ?? process.env.NODE_AUTH_TOKEN
const folders = [
  "0x0-linux-x64-baseline",
  "0x0-linux-x64",
  "0x0-darwin-arm64",
  "0x0-darwin-x64-baseline",
  "0x0-darwin-x64",
  "0x0-windows-x64",
  "0x0-linux-x64-baseline-musl",
  "0x0-linux-arm64",
  "0x0-linux-arm64-musl",
  "0x0-windows-x64-baseline",
  "0x0-linux-x64-musl",
]

const metaPath = "./dist/0x0/package.json"
const meta = await Bun.file(metaPath).json()
const version = args.values.version ?? meta.version
if (!version) throw new Error("Could not determine version. Pass --version.")

const publishName = (name: string) => `${scope}/${name}`
const config = token
  ? await Bun.write(`./dist/.npmrc.publish`, `//registry.npmjs.org/:_authToken=${token}\n`).then(() => `./dist/.npmrc.publish`)
  : undefined

if (meta.optionalDependencies?.[publishName("0x0")]) {
  delete meta.optionalDependencies[publishName("0x0")]
  await Bun.file(metaPath).write(JSON.stringify(meta, null, 2) + "\n")
  console.log("Removed self dependency from dist/0x0/package.json")
}

const published = async (name: string) => {
  const result = await $`npm view ${name}@${version} version`.quiet().nothrow()
  if (result.exitCode !== 0) return false
  return result.stdout.toString().trim() === version
}

const login = async () => {
  if (dry) {
    console.log(`DRY RUN npm login --scope=${scope} --auth-type=web`)
    return
  }
  if (token) {
    console.log("Using npm token auth")
    return
  }
  console.log("Starting npm web login...")
  const result = await $`npm login --scope=${scope} --auth-type=web`.nothrow()
  if (result.exitCode === 0) return
  throw new Error(result.stderr.toString() || "npm login failed")
}

const push = async (folder: string) => {
  const cwd = `./dist/${folder}`
  const name = publishName(folder)
  if (await published(name)) {
    console.log(`skip ${name}@${version} (already published)`)
    return
  }

  console.log(`publishing ${name}@${version}`)
  if (dry) {
    console.log(`DRY RUN bun pm pack (cwd ${cwd})`)
    console.log(`DRY RUN npm publish *.tgz --access public --tag ${tag} (cwd ${cwd})`)
    return
  }

  await $`bun pm pack`.cwd(cwd)

  while (true) {
    const result = otp
      ? await $`${{ raw: `npm publish *.tgz --access public --tag ${tag} --otp=${otp}${config ? ` --userconfig ${config}` : ""}` }}`.cwd(cwd).nothrow()
      : await $`${{ raw: `npm publish *.tgz --access public --tag ${tag}${config ? ` --userconfig ${config}` : ""}` }}`.cwd(cwd).nothrow()
    if (result.exitCode === 0) return

    const stderr = result.stderr.toString()
    if (!stderr.includes("EOTP") && !stderr.includes("Access token expired or revoked")) {
      throw new Error(stderr || `npm publish failed for ${name}`)
    }

    if (token) {
      throw new Error(stderr || `npm token auth failed for ${name}`)
    }

    await login()
  }
}

for (const folder of folders) {
  await push(folder)
}
await push("0x0")

console.log("Done")
