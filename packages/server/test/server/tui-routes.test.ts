import { describe, expect, test } from "bun:test"
import path from "path"
import { Bus } from "../../src/bus"
import { TuiEvent } from "../../src/bus/tui-event"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("tui routes", () => {
  test("execute-command publishes mapped command for valid alias", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let command = ""
        const unsub = Bus.subscribe(TuiEvent.CommandExecute, (evt) => {
          command = evt.properties.command
        })

        const app = Server.App()
        const response = await app.request("/tui/execute-command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "agent_cycle" }),
        })

        unsub()

        expect(response.status).toBe(200)
        expect(await response.json()).toBe(true)
        expect(command).toBe("agent.cycle")
      },
    })
  })

  test("execute-command rejects invalid alias with 400 and publishes nothing", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let published = false
        const unsub = Bus.subscribe(TuiEvent.CommandExecute, () => {
          published = true
        })

        const app = Server.App()
        const response = await app.request("/tui/execute-command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "not_a_real_command" }),
        })

        unsub()

        expect(response.status).toBe(400)
        expect(published).toBe(false)
      },
    })
  })
})
