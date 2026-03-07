import { expect, test } from "bun:test"
import { Config } from "../../../src/core/config/config"
import { Instance } from "../../../src/project/instance"
import { Agent as AgentSvc } from "../../../src/runtime/agent/agent"
import { Color } from "../../../src/util/color"
import { tmpdir } from "../../fixture/fixture"

test("agent color parsed from project config", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        builder: {
          color: "#FFA500",
        },
        planner: {
          color: "#7C3AED",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const cfg = await Config.get()
      expect(cfg.agent?.builder?.color).toBe("#FFA500")
      expect(cfg.agent?.planner?.color).toBe("#7C3AED")
    },
  })
})

test("Agent.get includes color from config", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        planner: {
          color: "#A855F7",
        },
        builder: {
          color: "#2563EB",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const plan = await AgentSvc.get("planner")
      expect(plan?.color).toBe("#A855F7")
      const build = await AgentSvc.get("builder")
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
