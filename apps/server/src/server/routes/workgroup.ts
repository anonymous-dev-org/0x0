import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import z from "zod"
import { ProviderRegistry } from "@/provider/registry"
import { SessionStore } from "@/session/store"
import { Log } from "@/util/log"

const log = Log.create({ service: "workgroup" })

const AgentDef = z.object({
  name: z.string().min(1),
  provider: z.string(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  system_prompt: z.string().optional(),
  permission_mode: z.string().optional(),
  cwd: z.string().optional(),
})

const WorkgroupInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("open"),
    agents: z.array(AgentDef).min(1).max(6),
  }),
  z.object({
    action: z.literal("message"),
    workgroup_id: z.string().uuid(),
    agent_name: z.string(),
    prompt: z.string().min(1),
  }),
  z.object({
    action: z.literal("broadcast"),
    workgroup_id: z.string().uuid(),
    prompt: z.string().min(1),
  }),
  z.object({
    action: z.literal("status"),
    workgroup_id: z.string().uuid(),
  }),
  z.object({
    action: z.literal("close"),
    workgroup_id: z.string().uuid(),
  }),
])

export function WorkgroupRoutes() {
  return new Hono().post("/", async (c) => {
    const body = WorkgroupInput.parse(await c.req.json())

    switch (body.action) {
      case "open": {
        const wg = SessionStore.createWorkgroup()

        for (const def of body.agents) {
          const provider = await ProviderRegistry.resolve(def.provider)
          const session = SessionStore.create(provider.id)
          SessionStore.addWorkgroupAgent(wg.id, {
            name: def.name,
            sessionId: session.id,
            provider: provider.id,
            model: def.model,
            status: "idle",
          })
        }

        const agents = Array.from(wg.agents.values()).map((a) => ({
          name: a.name,
          session_id: a.sessionId,
          provider: a.provider,
          model: a.model,
        }))

        log.info("opened", { id: wg.id, agents: agents.length })
        return c.json({ workgroup_id: wg.id, agents })
      }

      case "message": {
        const wg = SessionStore.getWorkgroup(body.workgroup_id)
        if (!wg) return c.json({ error: "workgroup not found" }, 404)

        const agent = wg.agents.get(body.agent_name)
        if (!agent) return c.json({ error: `agent "${body.agent_name}" not found` }, 404)

        const session = SessionStore.get(agent.sessionId)
        if (!session) return c.json({ error: "agent session not found" }, 404)
        if (session.status === "busy") return c.json({ error: "agent is busy" }, 409)

        const provider = await ProviderRegistry.resolve(agent.provider)
        SessionStore.setBusy(session.id)
        agent.status = "busy"

        log.info("message", { workgroup: wg.id, agent: agent.name })

        return streamSSE(c, async (sseStream) => {
          const ac = new AbortController()
          sseStream.onAbort(() => ac.abort())

          let providerSessionId: string | undefined
          let resultText = ""

          try {
            for await (const event of provider.spawn({
              prompt: body.prompt,
              sessionId: session.providerSessionId,
              model: agent.model,
              abort: ac.signal,
            })) {
              if (event.type === "init" && event.session_id) {
                providerSessionId = event.session_id
              }
              if (event.type === "text_delta") {
                resultText += event.text
              }
              if (event.type === "result") {
                if (event.session_id) providerSessionId = event.session_id
                if (event.result) resultText = event.result
              }

              await sseStream.writeSSE({
                data: JSON.stringify({
                  ...event,
                  agent_name: agent.name,
                  session_id: event.type === "init" ? session.id : undefined,
                }),
              })
            }
          } finally {
            SessionStore.setIdle(session.id, providerSessionId)
            agent.status = "idle"
            agent.lastResponse = resultText
          }
        })
      }

      case "broadcast": {
        const wg = SessionStore.getWorkgroup(body.workgroup_id)
        if (!wg) return c.json({ error: "workgroup not found" }, 404)

        const agentNames = Array.from(wg.agents.keys())
        const results: Record<string, string> = {}

        // Run all agents in parallel, collect results
        await Promise.all(
          agentNames.map(async (name) => {
            const agent = wg.agents.get(name)!
            const session = SessionStore.get(agent.sessionId)
            if (!session || session.status === "busy") {
              results[name] = session?.status === "busy" ? "[busy]" : "[no session]"
              return
            }

            const provider = await ProviderRegistry.resolve(agent.provider)
            SessionStore.setBusy(session.id)
            agent.status = "busy"

            let providerSessionId: string | undefined
            let resultText = ""

            try {
              for await (const event of provider.spawn({
                prompt: body.prompt,
                sessionId: session.providerSessionId,
                model: agent.model,
              })) {
                if (event.type === "init" && event.session_id) {
                  providerSessionId = event.session_id
                }
                if (event.type === "text_delta") resultText += event.text
                if (event.type === "result") {
                  if (event.session_id) providerSessionId = event.session_id
                  if (event.result) resultText = event.result
                }
              }
            } finally {
              SessionStore.setIdle(session.id, providerSessionId)
              agent.status = "idle"
              agent.lastResponse = resultText
            }

            results[name] = resultText
          }),
        )

        log.info("broadcast", { workgroup: wg.id, agents: agentNames.length })
        return c.json({ workgroup_id: body.workgroup_id, results })
      }

      case "status": {
        const wg = SessionStore.getWorkgroup(body.workgroup_id)
        if (!wg) return c.json({ error: "workgroup not found" }, 404)

        const agents = Array.from(wg.agents.values()).map((a) => ({
          name: a.name,
          status: a.status,
          provider: a.provider,
          model: a.model,
          last_response: a.lastResponse,
        }))

        return c.json({ workgroup_id: body.workgroup_id, agents })
      }

      case "close": {
        const removed = SessionStore.removeWorkgroup(body.workgroup_id)
        if (!removed) return c.json({ error: "workgroup not found" }, 404)

        log.info("closed", { id: body.workgroup_id })
        return c.json({ closed: true })
      }
    }
  })
}
