import type { Hooks, PluginInput, Plugin as PluginInstance } from "@0x0-ai/plugin"
import { Config } from "../config/config"
import { Bus } from "../bus"
import { Log } from "../util/log"
import { createZeroxzeroClient } from "@0x0-ai/sdk"
import { Server } from "../server/server"
import { BunProc } from "../bun"
import { Instance } from "../project/instance"
import { Session } from "../session"
import { NamedError } from "@0x0-ai/util/error"
import { Global } from "@/global"
import path from "path"

export namespace Plugin {
  const log = Log.create({ service: "plugin" })

  const BUILTIN: string[] = []
  const INSTALL_RETRY_BACKOFF_MS = 15 * 60 * 1000
  const installFailurePath = path.join(Global.Path.state, "plugin-install-failures.json")

  async function installFailures() {
    return Bun.file(installFailurePath)
      .json()
      .catch(() => ({}) as Record<string, number>)
      .then((data) => {
        if (!data || typeof data !== "object") return {} as Record<string, number>
        return Object.fromEntries(
          Object.entries(data).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
        )
      })
  }

  async function persistInstallFailures(entries: Record<string, number>) {
    await Bun.write(installFailurePath, JSON.stringify(entries, null, 2))
  }

  const state = Instance.state(async () => {
    const client = createZeroxzeroClient({
      baseUrl: "http://localhost:4096",
      directory: Instance.directory,
      // @ts-ignore - fetch type incompatibility
      fetch: async (...args) => Server.App().fetch(...args),
    })
    const config = await Config.get()
    const hooks: Hooks[] = []
    const input: PluginInput = {
      client,
      project: Instance.project,
      worktree: Instance.worktree,
      directory: Instance.directory,
      serverUrl: Server.url(),
      $: Bun.$,
    }

    let plugins = config.plugin ?? []
    const failures = await installFailures()
    if (plugins.length) await Config.waitForDependencies()
    if (!config.disable_default_plugins) {
      plugins = [...BUILTIN, ...plugins]
    }

    for (let plugin of plugins) {
      // ignore old codex plugin since it is supported first party now
      if (plugin.includes("zeroxzero-openai-codex-auth") || plugin.includes("zeroxzero-copilot-auth")) continue
      log.info("loading plugin", { path: plugin })
      if (!plugin.startsWith("file://")) {
        const lastAtIndex = plugin.lastIndexOf("@")
        const pkg = lastAtIndex > 0 ? plugin.substring(0, lastAtIndex) : plugin
        const version = lastAtIndex > 0 ? plugin.substring(lastAtIndex + 1) : "latest"
        const key = `${pkg}@${version}`
        const retryAt = failures[key]
        if (retryAt && retryAt > Date.now()) {
          log.warn("skipping plugin install retry", {
            pkg,
            version,
            retryAt,
          })
          continue
        }

        const builtin = BUILTIN.some((x) => x.startsWith(pkg + "@"))
        plugin = await BunProc.install(pkg, version).catch((err) => {
          failures[key] = Date.now() + INSTALL_RETRY_BACKOFF_MS
          void persistInstallFailures(failures)

          if (!builtin) throw err

          const message = err instanceof Error ? err.message : String(err)
          log.error("failed to install builtin plugin", {
            pkg,
            version,
            error: message,
          })
          Bus.publish(Session.Event.Error, {
            error: new NamedError.Unknown({
              message: `Failed to install built-in plugin ${pkg}@${version}: ${message}`,
            }).toObject(),
          })

          return ""
        })

        if (plugin) {
          if (failures[key]) {
            delete failures[key]
            void persistInstallFailures(failures)
          }
        }

        if (!plugin) continue
      }
      const mod = await import(plugin)
      // Prevent duplicate initialization when plugins export the same function
      // as both a named export and default export (e.g., `export const X` and `export default X`).
      // Object.entries(mod) would return both entries pointing to the same function reference.
      const seen = new Set<PluginInstance>()
      for (const [_name, fn] of Object.entries<PluginInstance>(mod)) {
        if (seen.has(fn)) continue
        seen.add(fn)
        const init = await fn(input)
        hooks.push(init)
      }
    }

    return {
      hooks,
      input,
    }
  })

  export async function trigger<
    Name extends Exclude<keyof Required<Hooks>, "auth" | "event" | "tool">,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(name: Name, input: Input, output: Output): Promise<Output> {
    if (!name) return output
    for (const hook of await state().then((x) => x.hooks)) {
      const fn = hook[name]
      if (!fn) continue
      // @ts-expect-error if you feel adventurous, please fix the typing, make sure to bump the try-counter if you
      // give up.
      // try-counter: 2
      await fn(input, output)
    }
    return output
  }

  export async function list() {
    return state().then((x) => x.hooks)
  }

  export async function init() {
    const hooks = await state().then((x) => x.hooks)
    const config = await Config.get()
    for (const hook of hooks) {
      // @ts-expect-error this is because we haven't moved plugin to sdk v2
      await hook.config?.(config)
    }
    Bus.subscribeAll(async (input) => {
      const hooks = await state().then((x) => x.hooks)
      for (const hook of hooks) {
        hook["event"]?.({
          event: input,
        })
      }
    })
  }
}
