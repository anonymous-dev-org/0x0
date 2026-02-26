import path from "path"
import fs from "fs/promises"
import YAML from "yaml"
import { Global } from "../global"
import { Config } from "./config"

const providerDirName = "providers"

function globalProviderDir() {
  return path.join(Global.Path.config, providerDirName)
}

function projectProviderDir(projectRoot: string) {
  return path.join(projectRoot, ".0x0", providerDirName)
}

function providerIDFromFilename(filename: string) {
  if (filename.endsWith(".yaml")) return filename.slice(0, -5)
  if (filename.endsWith(".yml")) return filename.slice(0, -4)
  return undefined
}

async function loadFromDirectory(directory: string): Promise<Config.Info[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
  const fragments: Config.Info[] = []

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const providerID = providerIDFromFilename(entry.name)
    if (!providerID) continue

    const filepath = path.join(directory, entry.name)
    const text = await Bun.file(filepath)
      .text()
      .catch((error) => {
        throw new Config.JsonError({ path: filepath, message: String(error) }, { cause: error })
      })

    let parsedYaml: unknown
    try {
      parsedYaml = YAML.parse(text) ?? {}
    } catch (error) {
      throw new Config.JsonError({
        path: filepath,
        message: `YAML parse error: ${error instanceof Error ? error.message : String(error)}`,
      })
    }

    const parsedProvider = Config.Provider.safeParse(parsedYaml)
    if (!parsedProvider.success) {
      throw new Config.InvalidError({
        path: filepath,
        issues: parsedProvider.error.issues,
      })
    }

    fragments.push({
      provider: {
        [providerID]: parsedProvider.data,
      },
    })
  }

  return fragments
}

export async function loadGlobalProviders() {
  return loadFromDirectory(globalProviderDir())
}

export async function loadProjectProviders(projectRoot: string) {
  return loadFromDirectory(projectProviderDir(projectRoot))
}
