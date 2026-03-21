import path from "path"
import { existsSync } from "fs"
import z from "zod"
import { Global } from "@/core/global"
import { NamedError } from "@/util/error"
import { lazy } from "@/util/lazy"
import { Log } from "@/util/log"

export namespace Config {
  const log = Log.create({ service: "config" })
  const configFile = "config.json"
  const configSchemaURL = "https://zeroxzero.ai/config.json"

  export const Server = z
    .object({
      port: z.number().int().positive().optional().describe("Port to listen on"),
      hostname: z.string().optional().describe("Hostname to listen on"),
      mdns: z.boolean().optional().describe("Enable mDNS service discovery"),
      mdnsDomain: z.string().optional().describe("Custom domain name for mDNS service"),
      cors: z.array(z.string()).optional().describe("Additional domains to allow for CORS"),
      password: z.string().optional().describe("Password for server authentication"),
      username: z.string().optional().describe("Username for server authentication"),
    })
    .strict()
    .meta({ ref: "ServerConfig" })

  export const Completion = z
    .object({
      default_model: z.string().optional().describe("Default model for completions"),
      default_provider: z.enum(["claude", "codex"]).optional().describe("Default provider"),
      memory_enabled: z.boolean().optional().describe("Enable completion memory"),
      memory_max_entries: z.number().int().positive().optional().describe("Max memory entries (default: 500)"),
    })
    .strict()
    .meta({ ref: "CompletionConfig" })

  export const Git = z
    .object({
      default_model: z.string().optional().describe("Default model for commit messages"),
    })
    .strict()
    .meta({ ref: "GitConfig" })

  export const Info = z
    .object({
      $schema: z.string().optional(),
      server: Server.optional().describe("Server configuration"),
      completion: Completion.optional().describe("Completion settings"),
      git: Git.optional().describe("Git commit message settings"),
    })
    .passthrough()
    .meta({ ref: "Config" })

  export type Info = z.output<typeof Info>

  function formatJsonConfig(config: Info): string {
    const normalized = { $schema: config.$schema ?? configSchemaURL, ...config }
    return JSON.stringify(normalized, null, 2) + "\n"
  }

  async function ensureDefaultGlobalConfigFile() {
    const filepath = path.join(Global.Path.config, configFile)
    if (await Bun.file(filepath).exists()) return
    await Bun.write(filepath, formatJsonConfig({ $schema: configSchemaURL }))
  }

  async function loadFile(filepath: string): Promise<Info> {
    log.info("loading", { path: filepath })
    const text = await Bun.file(filepath)
      .text()
      .catch(err => {
        if (err.code === "ENOENT") return
        throw new JsonError({ path: filepath }, { cause: err })
      })
    if (!text) return {}

    text.replace(/\{env:([^}]+)\}/g, (_, varName) => {
      return process.env[varName] || ""
    })

    let data: unknown
    try {
      data = JSON.parse(text)
    } catch (error) {
      throw new JsonError({
        path: filepath,
        message: `JSON parse error: ${error instanceof Error ? error.message : String(error)}`,
      })
    }

    const parsed = Info.safeParse(data)
    if (parsed.success) return parsed.data

    throw new InvalidError({
      path: filepath,
      issues: parsed.error.issues,
    })
  }

  export const global = lazy(async () => {
    await ensureDefaultGlobalConfigFile()
    const filepath = path.join(Global.Path.config, configFile)
    return loadFile(filepath)
  })

  export async function get() {
    return global()
  }

  export const JsonError = NamedError.create(
    "ConfigJsonError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
    })
  )

  export const InvalidError = NamedError.create(
    "ConfigInvalidError",
    z.object({
      path: z.string(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
      message: z.string().optional(),
    })
  )
}
