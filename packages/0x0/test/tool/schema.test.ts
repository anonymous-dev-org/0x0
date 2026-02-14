import { test, expect } from "bun:test"
import z from "zod"
import { SearchTool } from "../../src/tool/search"
import { SearchRemoteTool } from "../../src/tool/search_remote"
import { ToolRegistry } from "../../src/tool/registry"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

test("search tool parameters serialize as object schema", async () => {
  const search = await SearchTool.init()
  const schema = z.toJSONSchema(search.parameters)
  expect(schema.type).toBe("object")
})

test("search_remote tool parameters serialize as object schema", async () => {
  const remote = await SearchRemoteTool.init()
  const schema = z.toJSONSchema(remote.parameters)
  expect(schema.type).toBe("object")
})

test("all registered tools serialize with object-root parameter schemas", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const tools = await ToolRegistry.tools({ providerID: "openai", modelID: "gpt-5" })
      for (const tool of tools) {
        const schema = z.toJSONSchema(tool.parameters)
        expect(schema.type).toBe("object")
      }
    },
  })
})
