import { expect, test } from "bun:test"
import path from "path"
import { Config } from "../../../src/core/config/config"
import { Instance } from "../../../src/project/instance"
import { tmpdir } from "../../fixture/fixture"

async function writeProjectConfig(dir: string, config: Record<string, unknown>) {
  const configDir = path.join(dir, ".0x0")
  await Bun.write(
    path.join(configDir, "config.json"),
    JSON.stringify({ $schema: "https://zeroxzero.ai/config.json", ...config }, null, 2)
  )
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

test("loads project config from .0x0/config.json", async () => {
  await using tmp = await tmpdir({
    init: async dir => {
      await writeProjectConfig(dir, {
        model: "anthropic/claude-sonnet-4-20250514",
        knowledge_base: ["project note"],
      })
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

test("updateProject writes .0x0/config.json", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Config.updateProject({ knowledge_base: ["first", "second"] })
      const projectConfigPath = path.join(tmp.path, ".0x0", "config.json")
      expect(await Bun.file(projectConfigPath).exists()).toBe(true)
      const config = await Config.getProject()
      expect(config.knowledge_base).toEqual(["first", "second"])
    },
  })
})

test("handles environment variable substitution in config", async () => {
  process.env.TEST_VAR = "anthropic/test-model"
  try {
    await using tmp = await tmpdir({
      init: async dir => {
        const configDir = path.join(dir, ".0x0")
        await Bun.write(
          path.join(configDir, "config.json"),
          JSON.stringify(
            {
              $schema: "https://zeroxzero.ai/config.json",
              model: "{env:TEST_VAR}",
            },
            null,
            2
          )
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.model).toBe("anthropic/test-model")
      },
    })
  } finally {
    delete process.env.TEST_VAR
  }
})

test("handles file inclusion substitution in config", async () => {
  await using tmp = await tmpdir({
    init: async dir => {
      await Bun.write(path.join(dir, "included.txt"), "anthropic/test-model")
      const configDir = path.join(dir, ".0x0")
      await Bun.write(
        path.join(configDir, "config.json"),
        JSON.stringify(
          {
            $schema: "https://zeroxzero.ai/config.json",
            model: "{file:../included.txt}",
          },
          null,
          2
        )
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.model).toBe("anthropic/test-model")
    },
  })
})
