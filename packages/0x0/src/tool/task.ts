import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { SessionCompaction } from "../session/compaction"
import { iife } from "@/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { PermissionNext } from "@/permission/next"

const parameters = z.object({
  mode: z
    .enum(["subtask", "handoff"])
    .describe(
      "subtask: delegate work and return to the current agent. handoff: permanently transfer control to another agent",
    ),
  description: z.string().describe("A short (3-5 words) description of the task"),
  agent: z.string().describe("The agent to use for this task"),
  prompt: z.string().describe("The task for the agent to perform (required for subtask mode)").optional(),
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same agent session as before instead of creating a fresh one)",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
})

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => !a.hidden))

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map((a) => `- ${a.name}: ${a.description ?? "This agent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const config = await Config.get()

      const agent = await Agent.get(params.agent)
      if (!agent) throw new Error(`Unknown agent: ${params.agent} is not a valid agent`)

      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const model = agent.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      if (params.mode === "handoff") {
        if (!ctx.extra?.bypassAgentCheck && ctx.agent !== params.agent) {
          await ctx.ask({
            permission: "task_handoff",
            patterns: [params.agent],
            always: [],
            metadata: {
              sourceAgent: ctx.agent,
              targetAgent: params.agent,
              reason: params.description,
            },
          })
        }

        const lastUser = [...ctx.messages].reverse().find((item) => item.info.role === "user")?.info
        if (!lastUser || lastUser.role !== "user") {
          throw new Error("Unable to handoff: missing user message context")
        }

        const compacted = await SessionCompaction.process({
          parentID: lastUser.id,
          messages: ctx.messages,
          sessionID: ctx.sessionID,
          abort: ctx.abort,
          auto: false,
        })
        if (compacted === "stop") {
          throw new Error("Unable to handoff: compaction failed")
        }

        const handoffMessage = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: ctx.sessionID,
          role: "user",
          time: {
            created: Date.now(),
          },
          agent: agent.name,
          model,
        })

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: handoffMessage.id,
          sessionID: ctx.sessionID,
          type: "text",
          synthetic: true,
          text: [`Handoff from @${ctx.agent} to @${agent.name}.`, `Objective: ${params.description}`].join("\n"),
        } satisfies MessageV2.TextPart)

        return {
          title: `Handoff to ${agent.name}`,
          metadata: {
            sessionId: ctx.sessionID,
            model,
            handoff: {
              switched: true,
              sourceAgent: ctx.agent,
              targetAgent: agent.name,
              reason: params.description,
            },
          },
          output: ["<handoff_result>", `Handed off to @${agent.name}`, "</handoff_result>"].join("\n"),
        }
      }

      if (!params.prompt) throw new Error("prompt is required for subtask mode")

      // Skip permission check when user explicitly invoked via @ or command subtask
      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [params.agent],
          always: ["*"],
          metadata: {
            description: params.description,
            agent: params.agent,
          },
        })
      }

      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")

      const session = await iife(async () => {
        if (params.task_id) {
          const found = await Session.get(params.task_id).catch(() => {})
          if (found) return found
        }

        return await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} agent)`,
          permission: [
            {
              permission: "todowrite",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "todoread",
              pattern: "*",
              action: "deny",
            },
            ...(hasTaskPermission
              ? []
              : [
                  {
                    permission: "task" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(config.experimental?.primary_tools?.map((t) => ({
              pattern: "*",
              action: "allow" as const,
              permission: t,
            })) ?? []),
          ],
        })
      })

      ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: session.id,
          model,
        },
      })

      const messageID = Identifier.ascending("message")

      function cancel() {
        SessionPrompt.cancel(session.id)
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
      const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)

      const result = await SessionPrompt.prompt({
        messageID,
        sessionID: session.id,
        model: {
          modelID: model.modelID,
          providerID: model.providerID,
        },
        agent: agent.name,
        tools: {
          todowrite: false,
          todoread: false,
          ...(hasTaskPermission ? {} : { task: false }),
          ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
        },
        parts: promptParts,
      })

      const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""

      const output = [
        `task_id: ${session.id} (for resuming to continue this task if needed)`,
        "",
        "<task_result>",
        text,
        "</task_result>",
      ].join("\n")

      return {
        title: params.description,
        metadata: {
          sessionId: session.id,
          model,
          handoff: {
            switched: false,
            sourceAgent: ctx.agent,
            targetAgent: agent.name,
            reason: params.description,
          },
        },
        output,
      }
    },
  }
})
