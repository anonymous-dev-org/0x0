import { BusEvent } from "@/core/bus/bus-event"
import path from "path"
import { $ } from "bun"
import z from "zod"
import { NamedError } from "@/util/error"
import { Log } from "@/util/log"
import { iife } from "@/util/iife"
import { Flag } from "../flag/flag"

declare global {
  const ZEROXZERO_VERSION: string
  const ZEROXZERO_CHANNEL: string
}

export namespace Installation {
  const log = Log.create({ service: "installation" })
  const npmPkg = "@anonymous-dev/0x0"

  export type Method = Awaited<ReturnType<typeof method>>

  export const Event = {
    Updated: BusEvent.define(
      "installation.updated",
      z.object({
        version: z.string(),
      }),
    ),
    UpdateAvailable: BusEvent.define(
      "installation.update-available",
      z.object({
        version: z.string(),
      }),
    ),
  }

  export const Info = z
    .object({
      version: z.string(),
      latest: z.string(),
    })
    .meta({
      ref: "InstallationInfo",
    })
  export type Info = z.infer<typeof Info>

  export async function info() {
    return {
      version: VERSION,
      latest: await latest(),
    }
  }

  export function isPreview() {
    return CHANNEL !== "latest"
  }

  export function isLocal() {
    return CHANNEL === "local"
  }

  export async function method() {
    if (process.execPath.includes(path.join(".zeroxzero", "bin"))) return "curl"
    if (process.execPath.includes(path.join(".local", "bin"))) return "curl"
    const exec = process.execPath.toLowerCase()

    const checks = [
      {
        name: "npm" as const,
        command: () => $`npm list -g --depth=0`.throws(false).quiet().text(),
      },
      {
        name: "yarn" as const,
        command: () => $`yarn global list`.throws(false).quiet().text(),
      },
      {
        name: "pnpm" as const,
        command: () => $`pnpm list -g --depth=0`.throws(false).quiet().text(),
      },
      {
        name: "bun" as const,
        command: () => $`bun pm ls -g`.throws(false).quiet().text(),
      },
      {
        name: "brew" as const,
        command: () => $`brew list --formula`.throws(false).quiet().text(),
      },
      {
        name: "scoop" as const,
        command: () => $`scoop list zeroxzero`.throws(false).quiet().text(),
      },
      {
        name: "choco" as const,
        command: () => $`choco list --limit-output zeroxzero`.throws(false).quiet().text(),
      },
    ]

    checks.sort((a, b) => {
      const aMatches = exec.includes(a.name)
      const bMatches = exec.includes(b.name)
      if (aMatches && !bMatches) return -1
      if (!aMatches && bMatches) return 1
      return 0
    })

    for (const check of checks) {
      const output = await check.command()
      if (check.name === "brew") {
        if (/\b0x0\b/.test(output) || output.includes("zeroxzero")) return check.name
        continue
      }
      if (check.name === "choco" || check.name === "scoop") {
        if (output.includes("zeroxzero")) return check.name
        continue
      }
      if (output.includes(npmPkg)) {
        return check.name
      }
    }

    return "unknown"
  }

  export const UpgradeFailedError = NamedError.create(
    "UpgradeFailedError",
    z.object({
      stderr: z.string(),
    }),
  )

  async function getBrewFormula() {
    const tapFormula = await $`brew list --formula anonymous-dev-org/tap/0x0`.throws(false).quiet().text()
    if (/\b0x0\b/.test(tapFormula)) return "anonymous-dev-org/tap/0x0"
    const oldTapFormula = await $`brew list --formula anonymous-dev-org/tap/zeroxzero`.throws(false).quiet().text()
    if (oldTapFormula.includes("zeroxzero")) return "anonymous-dev-org/tap/zeroxzero"
    const coreFormula = await $`brew list --formula 0x0`.throws(false).quiet().text()
    if (/\b0x0\b/.test(coreFormula)) return "0x0"
    const oldCoreFormula = await $`brew list --formula zeroxzero`.throws(false).quiet().text()
    if (oldCoreFormula.includes("zeroxzero")) return "zeroxzero"
    return "anonymous-dev-org/tap/0x0"
  }

  export async function upgrade(method: Method, target: string) {
    let cmd
    switch (method) {
      case "curl":
        cmd = $`curl -fsSL https://zeroxzero.ai/install | bash`.env({
          ...process.env,
          VERSION: target,
        })
        break
      case "npm":
        cmd = $`npm install -g ${npmPkg}@${target}`
        break
      case "pnpm":
        cmd = $`pnpm install -g ${npmPkg}@${target}`
        break
      case "bun":
        cmd = $`bun install -g ${npmPkg}@${target}`
        break
      case "brew": {
        const formula = await getBrewFormula()
        cmd = $`brew upgrade ${formula}`.env({
          HOMEBREW_NO_AUTO_UPDATE: "1",
          ...process.env,
        })
        break
      }
      case "choco":
        cmd = $`echo Y | choco upgrade zeroxzero --version=${target}`
        break
      case "scoop":
        cmd = $`scoop install zeroxzero@${target}`
        break
      default:
        throw new Error(`Unknown method: ${method}`)
    }
    const result = await cmd.quiet().throws(false)
    if (result.exitCode !== 0) {
      const stderr = method === "choco" ? "not running from an elevated command shell" : result.stderr.toString("utf8")
      throw new UpgradeFailedError({
        stderr: stderr,
      })
    }
    log.info("upgraded", {
      method,
      target,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    })
    await $`${process.execPath} --version`.nothrow().quiet().text()
  }

  export const VERSION = typeof ZEROXZERO_VERSION === "string" ? ZEROXZERO_VERSION : "local"
  export const CHANNEL = typeof ZEROXZERO_CHANNEL === "string" ? ZEROXZERO_CHANNEL : "local"
  export const USER_AGENT = `zeroxzero/${CHANNEL}/${VERSION}/${Flag.ZEROXZERO_CLIENT}`

  export async function latest(installMethod?: Method) {
    const detectedMethod = installMethod || (await method())

    if (detectedMethod === "brew") {
      const formula = await getBrewFormula()
      if (formula === "0x0" || formula === "zeroxzero") {
        return fetch(`https://formulae.brew.sh/api/formula/${formula}.json`)
          .then((res) => {
            if (!res.ok) throw new Error(res.statusText)
            return res.json()
          })
          .then((data: any) => data.versions.stable)
      }
    }

    if (detectedMethod === "npm" || detectedMethod === "bun" || detectedMethod === "pnpm") {
      const registry = await iife(async () => {
        const r = (await $`npm config get registry`.quiet().nothrow().text()).trim()
        const reg = r || "https://registry.npmjs.org"
        return reg.endsWith("/") ? reg.slice(0, -1) : reg
      })
      const channel = CHANNEL
      const pkg = encodeURIComponent(npmPkg)
      return fetch(`${registry}/${pkg}/${channel}`)
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => data.version)
    }

    if (detectedMethod === "choco") {
      return fetch(
        "https://community.chocolatey.org/api/v2/Packages?$filter=Id%20eq%20%270x0%27%20and%20IsLatestVersion&$select=Version",
        { headers: { Accept: "application/json;odata=verbose" } },
      )
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => data.d.results[0].Version)
    }

    if (detectedMethod === "scoop") {
      return fetch("https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/zeroxzero.json", {
        headers: { Accept: "application/json" },
      })
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => data.version)
    }

    return fetch("https://api.github.com/repos/anonymous-dev-org/0x0/releases/latest")
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText)
        return res.json()
      })
      .then((data: any) => data.tag_name.replace(/^v/, ""))
  }
}
