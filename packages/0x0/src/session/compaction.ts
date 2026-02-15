import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { Log } from "../util/log"
import { SessionProcessor } from "./processor"
import { fn } from "@/util/fn"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"

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

  function words(text: string) {
    const normalized = text.trim()
    if (!normalized) return 0
    return normalized.split(/\s+/).length
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

    const formatted = lines.join("\n\n")
    return {
      formatted,
      totalWords: words(formatted),
    }
  }

  export async function shouldCompact(input: { sessionID: string; messages?: MessageV2.WithParts[] }) {
    const config = await Config.get()
    const threshold = config.compaction?.max_words_before_compact
    if (!threshold) return false
    const messages = input.messages ?? (await MessageV2.filterCompacted(MessageV2.stream(input.sessionID)))
    const count = history(messages).totalWords
    if (count <= threshold) return false
    log.info("compaction threshold exceeded", {
      sessionID: input.sessionID,
      words: count,
      threshold,
    })
    return true
  }

  export async function isOverflow(input: {
    sessionID?: string
    messages?: MessageV2.WithParts[]
    tokens: MessageV2.Assistant["tokens"]
    model: Provider.Model
  }) {
    if (!input.sessionID) return false
    return shouldCompact({
      sessionID: input.sessionID,
      messages: input.messages,
    })
  }

  export async function process(input: {
    parentID: string
    messages: MessageV2.WithParts[]
    sessionID: string
    abort: AbortSignal
    auto: boolean
  }) {
    const userMessage = input.messages.findLast((m) => m.info.id === input.parentID)!.info as MessageV2.User
    const agent = await Agent.get("compaction")
    const config = await Config.get()
    const model =
      config.compaction?.provider && config.compaction.model
        ? await Provider.getModel(config.compaction.provider, config.compaction.model)
        : await Provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
    // Allow plugins to inject additional compaction context
    const compacting = await Plugin.trigger(
      "experimental.session.compacting",
      { sessionID: input.sessionID },
      { context: [], prompt: undefined },
    )
    const prompt = config.compaction?.prompt?.trim()
    if (!prompt) {
      log.info("skipping compaction, missing compaction.prompt")
      return "stop"
    }
    const context = history(input.messages).formatted

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
      agent,
      abort: input.abort,
      sessionID: input.sessionID,
      tools: {},
      system: [prompt],
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
      log.warn("auto compaction failed, continuing", { sessionID: input.sessionID })
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
