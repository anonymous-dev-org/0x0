import z from "zod"
import { Bus } from "@/core/bus"
import { TuiEvent } from "@/core/bus/tui-event"
import { Config } from "@/core/config/config"
import { PermissionNext } from "@/permission/next"
import { Agent } from "@/runtime/agent/agent"
import { Question } from "@/runtime/question"
import { defer } from "@/util/defer"
import { iife } from "@/util/iife"
import { Log } from "@/util/log"
import { Session } from "../session"
import { SessionCompaction } from "../session/compaction"
import { MessageV2 } from "../session/message-v2"
import { SessionPrompt } from "../session/prompt"
import DESCRIPTION from "./task.txt"
import { Tool } from "./tool"

const log = Log.create({ service: "tool.task" })

const parameters = z.object({
  mode: z
    .enum(["subtask", "handoff"])
    .describe(
      "subtask: delegate work and return to the current agent. handoff: permanently transfer control to another agent"
    ),
  description: z.string().describe("A short (3-5 words) description of the task"),
  agent: z.string().describe("The agent to use for this task"),
  prompt: z.string().describe("The task for the agent to perform (required for subtask mode)").optional(),
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same agent session as before instead of creating a fresh one)"
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
  compact: z
    .boolean()
    .describe("Whether to run compaction before handoff (default: true, only applies to handoff mode)")
    .optional()
    .default(true),
})

export const TaskTool = Tool.define("task", async ctx => {
  const agents = await Agent.list().then(x => x.filter(a => !a.hidden))

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter(a => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map(a => `- ${a.name}: ${a.description ?? "This agent should only be called manually by the user."}`)
      .join("\n")
  )
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const config = await Config.get()

      const agent = await Agent.get(params.agent)
      if (!agent) throw new Error(`Unknown agent: ${params.agent} is not a valid agent`)
      if (agent.hidden && !ctx.extra?.bypassAgentCheck)
        throw new Error(`Unknown agent: ${params.agent} is not a valid agent`)

      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const model = agent.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      if (params.mode === "handoff") {
        return executeHandoff({ params, ctx, agent, model })
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

      const hasTaskPermission = PermissionNext.evaluate("task", "*", agent.permission).action !== "deny"

      const session = await iife(async () => {
        if (params.task_id) {
          const found = await Session.get(params.task_id).catch(e => {
            log.warn("failed to lookup task session", { error: e, taskId: params.task_id })
            return undefined
          })
          if (found) {
            if (found.parentID !== ctx.sessionID) {
              log.warn("task_id does not belong to this session", {
                taskId: params.task_id,
                parentID: found.parentID,
                sessionID: ctx.sessionID,
              })
              throw new Error(`Task ${params.task_id} does not belong to this session`)
            }
            return found
          }
        }

        return await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} agent)`,
        })
      })

      ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: session.id,
          model,
        },
      })

      if (ctx.abort.aborted) throw new Error("Task aborted")

      function cancel() {
        SessionPrompt.cancel(session.id)
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
      const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)

      // Re-check abort after async work — covers the race window between
      // listener registration and SessionPrompt.start() populating state
      if (ctx.abort.aborted) throw new Error("Task aborted")

      const result = await SessionPrompt.prompt({
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
          ...Object.fromEntries((config.experimental?.primary_tools ?? []).map(t => [t, false])),
        },
        parts: promptParts,
      })

      const text = result.parts.findLast(x => x.type === "text")?.text ?? ""

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

async function executeHandoff(input: {
  params: z.infer<typeof parameters>
  ctx: Tool.Context
  agent: Agent.Info
  model: { modelID: string; providerID: string }
}) {
  const { params, ctx, agent, model } = input

  // Block until user picks an action
  const answers = await Question.ask({
    sessionID: ctx.sessionID,
    questions: [
      {
        question: `Handoff from @${ctx.agent} to @${agent.name}: ${params.description}`,
        header: "Agent Handoff",
        options: [
          { label: "Handoff + compact", description: `Fork session with compacted history to @${agent.name}` },
          { label: "Handoff", description: `Fork session with full history to @${agent.name}` },
          { label: "Keep iterating", description: `Stay in @${ctx.agent} and continue working` },
        ],
      },
    ],
    tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
  })

  const choice = answers[0]?.[0] ?? "Keep iterating"

  if (choice === "Keep iterating") {
    return {
      title: `Handoff declined — continuing as @${ctx.agent}`,
      metadata: {
        sessionId: undefined as string | undefined,
        model,
        handoff: {
          switched: false,
          sourceAgent: ctx.agent,
          targetAgent: agent.name,
          reason: params.description,
        },
      },
      output: `The user chose to keep iterating in @${ctx.agent} instead of handing off to @${agent.name}. Continue with the current task.`,
    }
  }

  const shouldCompact = choice === "Handoff + compact"

  // Fork the current session — copies all messages to a new session
  const forked = await Session.fork({ sessionID: ctx.sessionID })

  if (shouldCompact) {
    const lastUser = [...ctx.messages].reverse().find(item => item.info.role === "user")?.info
    if (lastUser && lastUser.role === "user") {
      const compacted = await SessionCompaction.process({
        parentID: lastUser.id,
        messages: ctx.messages,
        sessionID: forked.id,
        abort: ctx.abort,
        auto: false,
      })
      if (compacted === "stop") {
        log.warn("compaction failed during handoff, proceeding without", { sessionID: forked.id })
      }
    }
  }

  // Find plan file path from the current session's messages
  const planFilePath = ctx.messages
    .flatMap(m => m.parts)
    .filter((p): p is MessageV2.ToolPart => p.type === "tool" && p.tool === "plan" && p.state.status === "completed")
    .at(-1)?.metadata?.filepath as string | undefined

  // Build handoff prompt
  const promptLines = [`Handoff from @${ctx.agent} to @${agent.name}.`, `Objective: ${params.description}`]
  if (planFilePath) {
    promptLines.push("", `Plan file: ${planFilePath}`)
    promptLines.push(
      "",
      "Read the plan file above and execute it. Update the todo checklist as you complete each task."
    )
  }

  const targetMode = agent.modes && agent.modes.length > 0 ? agent.modes[0] : undefined

  // Start prompt on the forked session (fire and forget — TUI navigates to it)
  void SessionPrompt.prompt({
    sessionID: forked.id,
    agent: agent.name,
    agentMode: targetMode,
    model,
    parts: [{ type: "text", text: promptLines.join("\n") }],
  })

  // Navigate TUI to the new session
  await Bus.publish(TuiEvent.SessionSelect, { sessionID: forked.id })

  return {
    title: `Handoff to ${agent.name}`,
    metadata: {
      sessionId: forked.id,
      model,
      handoff: {
        switched: true,
        sourceAgent: ctx.agent,
        targetAgent: agent.name,
        reason: params.description,
      },
    },
    output: [
      "<handoff_result>",
      `Handed off to @${agent.name} in session ${forked.id}`,
      shouldCompact ? "History was compacted before handoff." : "Full history was copied.",
      "</handoff_result>",
    ].join("\n"),
  }
}
