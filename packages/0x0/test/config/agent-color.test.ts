import { test, expect } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Config } from "../../src/config/config"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Color } from "../../src/util/color"
import YAML from "yaml"

test("agent color parsed from project config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".0x0", "config.yaml"),
        YAML.stringify({
          $schema: "https://zeroxzero.ai/config.json",
          agent: {
            build: {
              name: "Build",
              color: "#FFA500",
              actions: { "claude-code": { Read: "allow" } },
              thinking_effort: "medium",
            },
            plan: {
              name: "Plan",
              color: "#7C3AED",
              actions: { "claude-code": { Read: "allow" } },
              thinking_effort: "high",
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const cfg = await Config.get()
      expect(cfg.agent?.["build"]?.color).toBe("#FFA500")
      expect(cfg.agent?.["plan"]?.color).toBe("#7C3AED")
    },
  })
})

test("Agent.get includes color from config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".0x0", "config.yaml"),
        YAML.stringify({
          $schema: "https://zeroxzero.ai/config.json",
          agent: {
            plan: {
              name: "Plan",
              color: "#A855F7",
              actions: { "claude-code": { Read: "allow" } },
              thinking_effort: "high",
            },
            build: {
              name: "Build",
              color: "#2563EB",
              actions: { "claude-code": { Read: "allow" } },
              thinking_effort: "medium",
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const plan = await AgentSvc.get("plan")
      expect(plan?.color).toBe("#A855F7")
      const build = await AgentSvc.get("build")
      expect(build?.color).toBe("#2563EB")
    },
  })
})

test("Color.hexToAnsiBold converts valid hex to ANSI", () => {
  const result = Color.hexToAnsiBold("#FFA500")
  expect(result).toBe("\x1b[38;2;255;165;0m\x1b[1m")
})

test("Color.hexToAnsiBold returns undefined for invalid hex", () => {
  expect(Color.hexToAnsiBold(undefined)).toBeUndefined()
  expect(Color.hexToAnsiBold("")).toBeUndefined()
  expect(Color.hexToAnsiBold("#FFF")).toBeUndefined()
  expect(Color.hexToAnsiBold("FFA500")).toBeUndefined()
  expect(Color.hexToAnsiBold("#GGGGGG")).toBeUndefined()
})
