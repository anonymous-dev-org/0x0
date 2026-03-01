import { BusEvent } from "@/core/bus/bus-event"
import { Bus } from "@/core/bus"
import { Session } from "."
import { Identifier } from "@/core/id/id"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { Log } from "../util/log"
import { SessionProcessor } from "./processor"
import { fn } from "@/util/fn"
import { Agent } from "@/runtime/agent/agent"
import { Config } from "@/core/config/config"

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: z.string(),
      }),
    ),
  }

  function text(part: MessageV2.Part) {
    if (part.type === "text" && !part.ignored) return part.text
    if (part.type === "reasoning") return part.text
    if (part.type === "tool" && part.state.status === "completed") return part.state.output
    if (part.type === "tool" && part.state.status === "error") return part.state.error
    return ""
  }

  function history(messages: MessageV2.WithParts[]) {
    const lines = messages
      .map((message) => {
        const content = message.parts
          .map((part) => text(part))
          .filter(Boolean)
          .join("\n")
          .trim()
        if (!content) return ""
        return `${message.info.role}: ${content}`
      })
      .filter(Boolean)

    return lines.join("\n\n")
  }

  export function shouldCompact(input: {
    model: Provider.Model
    tokens: MessageV2.Assistant["tokens"]
  }): boolean {
    const limit = input.model.limit
    if (limit.context <= 0) return false
    const usable = Math.min(limit.context - limit.output, limit.input ?? Infinity)
    const used = input.tokens.input + input.tokens.output + input.tokens.cache.read
    return used >= usable * 0.8
  }

  export async function process(input: {
    parentID: string
    messages: MessageV2.WithParts[]
    sessionID: string
    abort: AbortSignal
    auto: boolean
  }) {
    const parentMessage = input.messages.findLast((m) => m.info.id === input.parentID)
    if (!parentMessage) throw new Error(`compaction parent message ${input.parentID} not found`)
    const userMessage = parentMessage.info as MessageV2.User
    const agent = await Agent.get("compaction")
    const config = await Config.get()
    const model =
      config.compaction?.provider && config.compaction.model
        ? await Provider.getModel(config.compaction.provider, config.compaction.model)
        : await Provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
    const compacting = { context: [] as string[], prompt: undefined }
    const prompt = config.compaction?.prompt?.trim()
    if (!prompt && input.auto) {
      log.info("skipping compaction, missing compaction.prompt")
      return "stop"
    }
    const effectivePrompt =
      prompt ||
      "Provide a detailed prompt for continuing our conversation above. Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next considering new session will not have access to our conversation."
    const context = history(input.messages)

    const msg = (await Session.updateMessage({
      id: Identifier.ascending("message"),
      role: "assistant",
      parentID: input.parentID,
      sessionID: input.sessionID,
      mode: "compaction",
      agent: "compaction",
      variant: userMessage.variant,
      summary: true,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.id,
      providerID: model.providerID,
      time: {
        created: Date.now(),
      },
    })) as MessageV2.Assistant
    const processor = SessionProcessor.create({
      assistantMessage: msg,
      sessionID: input.sessionID,
      model,
      abort: input.abort,
    })
    const promptText = ["Conversation history:", context, ...(compacting?.context ?? [])]
      .filter((item): item is string => Boolean(item))
      .join("\n\n")
    const result = await processor.process({
      user: userMessage,
      agent: agent ?? (() => { throw new Error("compaction agent not found") })(),
      abort: input.abort,
      sessionID: input.sessionID,
      tools: {},
      system: [effectivePrompt],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: promptText,
            },
          ],
        },
      ],
      model,
    })

    if (result === "stop" && input.auto) {
      return "continue"
    }

    if (result === "continue" && input.auto) {
      const continueMsg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: input.sessionID,
        time: {
          created: Date.now(),
        },
        agent: userMessage.agent,
        model: userMessage.model,
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: continueMsg.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: "Continue if you have next steps",
        time: {
          start: Date.now(),
          end: Date.now(),
        },
      })
    }
    if (processor.message.error) return "stop"
    Bus.publish(Event.Compacted, { sessionID: input.sessionID })
    return "continue"
  }

  export const create = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      agent: z.string(),
      model: z.object({
        providerID: z.string(),
        modelID: z.string(),
      }),
      auto: z.boolean(),
    }),
    async (input) => {
      const msg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: {
          created: Date.now(),
        },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
      })
    },
  )
}
