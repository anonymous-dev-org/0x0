import { $ } from "bun"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import type { Config } from "../../src/core/config/config"
import YAML from "yaml"

// Strip null bytes from paths (defensive fix for CI environment issues)
function sanitizePath(p: string): string {
  return p.replace(/\0/g, "")
}

type TmpDirOptions<T> = {
  git?: boolean
  config?: Record<string, unknown>
  init?: (dir: string) => Promise<T>
  dispose?: (dir: string) => Promise<T>
}
export async function tmpdir<T>(options?: TmpDirOptions<T>) {
  const dirpath = sanitizePath(path.join(os.tmpdir(), "zeroxzero-test-" + Math.random().toString(36).slice(2)))
  await fs.mkdir(dirpath, { recursive: true })
  await fs.mkdir(path.join(dirpath, ".0x0"), { recursive: true })
  if (options?.git) {
    await $`git init`.cwd(dirpath).quiet()
    await $`git commit --allow-empty -m "root commit ${dirpath}"`.cwd(dirpath).quiet()
  }
  if (options?.config) {
    const configDir = path.join(dirpath, ".0x0")
    await fs.mkdir(configDir, { recursive: true })
    await Bun.write(
      path.join(configDir, "config.yaml"),
      YAML.stringify({
        $schema: "https://zeroxzero.ai/config.json",
        ...options.config,
      }),
    )
  }
  const extra = await options?.init?.(dirpath)
  const realpath = sanitizePath(await fs.realpath(dirpath))
  const result = {
    [Symbol.asyncDispose]: async () => {
      await options?.dispose?.(dirpath)
      // await fs.rm(dirpath, { recursive: true, force: true })
    },
    path: realpath,
    extra: extra as T,
  }
  return result
}
