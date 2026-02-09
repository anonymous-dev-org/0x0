import { $, semver } from "bun"
import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  ZEROXZERO_CHANNEL: process.env["ZEROXZERO_CHANNEL"],
  ZEROXZERO_BUMP: process.env["ZEROXZERO_BUMP"],
  ZEROXZERO_VERSION: process.env["ZEROXZERO_VERSION"],
  ZEROXZERO_RELEASE: process.env["ZEROXZERO_RELEASE"],
}
const CHANNEL = await (async () => {
  if (env.ZEROXZERO_CHANNEL) return env.ZEROXZERO_CHANNEL
  if (env.ZEROXZERO_BUMP) return "latest"
  if (env.ZEROXZERO_VERSION && !env.ZEROXZERO_VERSION.startsWith("0.0.0-")) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim())
})()
const IS_PREVIEW = CHANNEL !== "latest"

const VERSION = await (async () => {
  if (env.ZEROXZERO_VERSION) return env.ZEROXZERO_VERSION
  if (IS_PREVIEW) return `0.0.0-${CHANNEL}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
  const version = await fetch("https://registry.npmjs.org/0x0-ai/latest")
    .then((res) => {
      if (!res.ok) throw new Error(res.statusText)
      return res.json()
    })
    .then((data: any) => data.version)
  const [major, minor, patch] = version.split(".").map((x: string) => Number(x) || 0)
  const t = env.ZEROXZERO_BUMP?.toLowerCase()
  if (t === "major") return `${major + 1}.0.0`
  if (t === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
})()

const team = [
  "actions-user",
  "zeroxzero",
  "rekram1-node",
  "thdxr",
  "kommander",
  "jayair",
  "fwang",
  "adamdotdevin",
  "iamdavidhill",
  "zeroxzero-agent[bot]",
  "R44VC0RP",
]

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.ZEROXZERO_RELEASE
  },
  get team() {
    return team
  },
}
console.log(`zeroxzero script`, JSON.stringify(Script, null, 2))
