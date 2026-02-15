import { test, expect } from "bun:test"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"

async function writeProjectConfig(dir: string, content: string) {
  const configDir = path.join(dir, ".0x0")
  await fs.mkdir(configDir, { recursive: true })
  await Bun.write(path.join(configDir, "config.yaml"), content)
}

test("loads config with defaults when no files exist", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.builder?.name).toBe("Builder")
      expect(config.agent?.planner?.name).toBe("Planner")
      expect(config.agent?.builder?.model).toBeUndefined()
      expect(config.agent?.planner?.model).toBeUndefined()
    },
  })
})

test("loads project config from .0x0/config.yaml", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeProjectConfig(
        dir,
        `# yaml-language-server: $schema=https://zeroxzero.ai/config.json
$schema: https://zeroxzero.ai/config.json
model: anthropic/claude-sonnet-4-20250514
knowledge_base:
  - project note
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.model).toBe("anthropic/claude-sonnet-4-20250514")
      expect(config.knowledge_base).toEqual(["project note"])
    },
  })
})

test("updateProject writes .0x0/config.yaml", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Config.updateProject({ knowledge_base: ["first", "second"] })
      const projectConfigPath = path.join(tmp.path, ".0x0", "config.yaml")
      expect(await Bun.file(projectConfigPath).exists()).toBe(true)
      const config = await Config.getProject()
      expect(config.knowledge_base).toEqual(["first", "second"])
    },
  })
})

test("handles environment variable substitution in YAML", async () => {
  process.env.TEST_VAR = "test_theme"
  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeProjectConfig(
          dir,
          `# yaml-language-server: $schema=https://zeroxzero.ai/config.json
$schema: https://zeroxzero.ai/config.json
theme: "{env:TEST_VAR}"
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.theme).toBe("test_theme")
      },
    })
  } finally {
    delete process.env.TEST_VAR
  }
})

test("handles file inclusion substitution in YAML", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "included.txt"), "test_theme")
      await writeProjectConfig(
        dir,
        `# yaml-language-server: $schema=https://zeroxzero.ai/config.json
$schema: https://zeroxzero.ai/config.json
theme: "{file:../included.txt}"
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.theme).toBe("test_theme")
    },
  })
})
