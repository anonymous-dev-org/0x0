import { Identifier } from "@/id/id"
import { iife } from "@/util/iife"
import type { PromptInfo } from "./history"

type SubmitModel = {
  providerID: string
  modelID: string
}

type SubmitResult = {
  error?: unknown
}

type SubmitContext = {
  local: {
    model: {
      current: () => SubmitModel | undefined
      variant: {
        current: () => string | undefined
      }
    }
    agent: {
      current: () => {
        name: string
      }
    }
  }
  sdk: {
    client: {
      session: {
        create: (input: {}) => Promise<{ data?: { id?: string }; error?: unknown }>
        shell: (input: {
          sessionID: string
          agent: string
          model: SubmitModel
          command: string
        }) => Promise<SubmitResult>
        command: (input: {
          sessionID: string
          command: string
          arguments: string
          agent: string
          model: string
          messageID: string
          variant: string | undefined
          parts: Array<PromptInfo["parts"][number] & { id: string; type: "file" }>
        }) => Promise<SubmitResult>
        prompt: (input: {
          sessionID: string
          providerID: string
          modelID: string
          messageID: string
          agent: string
          model: SubmitModel
          variant: string | undefined
          parts: Array<{ id: string; type: "text"; text: string } | (PromptInfo["parts"][number] & { id: string })>
        }) => Promise<SubmitResult>
        promptAsync: (input: {
          sessionID: string
          messageID: string
          agent: string
          model: SubmitModel
          variant: string | undefined
          parts: Array<{ id: string; type: "text"; text: string } | (PromptInfo["parts"][number] & { id: string })>
        }) => Promise<SubmitResult>
      }
    }
  }
  sync: {
    data: {
      command: Array<{
        name: string
      }>
    }
  }
  route: {
    navigate: (route: { type: "session"; sessionID: string }) => void
  }
  history: {
    append: (prompt: PromptInfo & { mode: "normal" | "shell" }) => void
  }
}

type SubmitInput = {
  extmarks: {
    getAllForTypeId: (typeId: number) => Array<{ id: number; start: number; end: number }>
    clear: () => void
  }
  clear: () => void
  setText: (value: string) => void
  gotoBufferEnd: () => void
}

export async function submitPrompt(props: {
  disabled?: boolean
  autocompleteVisible: boolean
  prompt: PromptInfo
  mode: "normal" | "shell"
  extmarkToPartIndex: Map<number, number>
  sessionID?: string
  local: SubmitContext["local"]
  sdk: SubmitContext["sdk"]
  sync: SubmitContext["sync"]
  route: SubmitContext["route"]
  history: SubmitContext["history"]
  input: SubmitInput
  promptPartTypeId: number
  setMode: (mode: "normal" | "shell") => void
  setPrompt: (prompt: PromptInfo) => void
  setExtmarkToPartIndex: (map: Map<number, number>) => void
  restorePromptParts?: (parts: PromptInfo["parts"]) => void
  onPromptModelWarning: () => void
  onSubmit?: () => void
  onSubmitError?: (message: string) => void
  onOptimistic?: (
    message: {
      id: string
      sessionID: string
      role: "user"
      agent: string
      model: SubmitModel
      variant: string | undefined
      time: { created: number }
    },
    parts: Array<{ id: string; sessionID: string; messageID: string; type: string; text?: string }>,
  ) => void
  exit: () => void
}) {
  if (props.disabled) return
  if (props.autocompleteVisible) return
  if (!props.prompt.input) return
  const trimmed = props.prompt.input.trim()
  if (trimmed === "exit" || trimmed === "quit" || trimmed === ":q") {
    props.exit()
    return
  }

  const selectedModel = props.local.model.current()
  if (!selectedModel) {
    props.onPromptModelWarning()
    return
  }

  const snapshotPrompt = clonePromptInfo(props.prompt)
  const snapshotMode = props.mode
  const snapshotExtmarkToPartIndex = new Map(props.extmarkToPartIndex)

  const allExtmarks = props.input.extmarks.getAllForTypeId(props.promptPartTypeId)
  const sortedExtmarks = [...allExtmarks].sort((a: { start: number }, b: { start: number }) => b.start - a.start)

  const messageID = Identifier.ascending("message")
  let inputText = snapshotPrompt.input

  for (const extmark of sortedExtmarks) {
    const partIndex = snapshotExtmarkToPartIndex.get(extmark.id)
    if (partIndex === undefined) continue
    const part = snapshotPrompt.parts[partIndex]
    if (part?.type !== "text" || !part.text) continue
    const before = inputText.slice(0, extmark.start)
    const after = inputText.slice(extmark.end)
    inputText = before + part.text + after
  }

  const nonTextParts = snapshotPrompt.parts.filter((part) => part.type !== "text")
  const variant = props.local.model.variant.current()

  props.input.extmarks.clear()
  props.setPrompt({
    input: "",
    parts: [],
  })
  props.setExtmarkToPartIndex(new Map())
  props.onSubmit?.()
  props.input.clear()

  function rollbackSubmit(error: unknown) {
    props.setPrompt(snapshotPrompt)
    props.setMode(snapshotMode)
    props.setExtmarkToPartIndex(new Map(snapshotExtmarkToPartIndex))
    props.input.setText(snapshotPrompt.input)
    props.restorePromptParts?.(snapshotPrompt.parts)
    props.input.gotoBufferEnd()
    props.onSubmitError?.(errorMessage(error))
  }

  const sessionID = props.sessionID
    ? props.sessionID
    : await (async () => {
        try {
          const created = await props.sdk.client.session.create({})
          if (!created.data?.id) {
            rollbackSubmit("Failed to create session")
            return
          }
          return created.data.id
        } catch (error) {
          rollbackSubmit(error)
          return
        }
      })()
  if (!sessionID) return

  props.history.append({
    ...snapshotPrompt,
    mode: snapshotMode,
  })

  if (props.mode === "shell") props.setMode("normal")

  if (!props.sessionID)
    props.route.navigate({
      type: "session",
      sessionID,
    })

  if (props.mode === "shell") {
    props.sdk.client.session
      .shell({
        sessionID,
        agent: props.local.agent.current().name,
        model: {
          providerID: selectedModel.providerID,
          modelID: selectedModel.modelID,
        },
        command: inputText,
      })
      .catch(() => {})
    return
  }

  const isCommand =
    inputText.startsWith("/") &&
    iife(() => {
      const firstLine = inputText.split("\n")[0]!
      const command = firstLine.split(" ")[0]!.slice(1)
      return props.sync.data.command.some((x) => x.name === command)
    })

  if (isCommand) {
    const firstLineEnd = inputText.indexOf("\n")
    const firstLine = firstLineEnd === -1 ? inputText : inputText.slice(0, firstLineEnd)
    const [command, ...firstLineArgs] = firstLine.split(" ")
    const restOfInput = firstLineEnd === -1 ? "" : inputText.slice(firstLineEnd + 1)
    const args = firstLineArgs.join(" ") + (restOfInput ? "\n" + restOfInput : "")

    const fileParts = nonTextParts
      .filter((x) => x.type === "file")
      .map((x) => ({
        id: Identifier.ascending("part"),
        ...x,
      }))

    props.onOptimistic?.(
      {
        id: messageID,
        sessionID,
        role: "user",
        agent: props.local.agent.current().name,
        model: selectedModel,
        variant,
        time: { created: Date.now() },
      },
      [
        {
          id: Identifier.ascending("part"),
          sessionID,
          messageID,
          type: "text",
          text: inputText,
        },
        ...fileParts.map((x) => ({
          ...x,
          sessionID,
          messageID,
        })),
      ],
    )

    props.sdk.client.session
      .command({
        sessionID,
        command: command!.slice(1),
        arguments: args,
        agent: props.local.agent.current().name,
        model: `${selectedModel.providerID}/${selectedModel.modelID}`,
        messageID,
        variant,
        parts: fileParts,
      })
      .catch(() => {})
    return
  }

  const parts = [
    {
      id: Identifier.ascending("part"),
      type: "text" as const,
      text: inputText,
    },
    ...nonTextParts.map((x) => ({
      id: Identifier.ascending("part"),
      ...x,
    })),
  ]

  props.onOptimistic?.(
    {
      id: messageID,
      sessionID,
      role: "user",
      agent: props.local.agent.current().name,
      model: selectedModel,
      variant,
      time: { created: Date.now() },
    },
    parts.map((x) => ({
      ...x,
      sessionID,
      messageID,
    })),
  )

  props.sdk.client.session
    .promptAsync({
      sessionID,
      messageID,
      agent: props.local.agent.current().name,
      model: selectedModel,
      variant,
      parts,
    })
    .catch(() => {})
}

function clonePromptInfo(prompt: PromptInfo): PromptInfo {
  return {
    input: prompt.input,
    mode: prompt.mode,
    parts: prompt.parts.map((part) => {
      if (part.type === "text") {
        return {
          ...part,
          ...(part.source
            ? {
                source: {
                  text: {
                    start: part.source.text.start,
                    end: part.source.text.end,
                    value: part.source.text.value,
                  },
                },
              }
            : {}),
        }
      }

      if (part.type === "agent") {
        return {
          ...part,
          ...(part.source
            ? {
                source: {
                  value: part.source.value,
                  start: part.source.start,
                  end: part.source.end,
                },
              }
            : {}),
        }
      }

      if (part.type === "file") {
        return {
          ...part,
          ...(part.source ? { source: { ...part.source } } : {}),
        }
      }

      return part
    }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isErrorResult(value: unknown): value is { error: unknown } {
  return isRecord(value) && "error" in value
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (isRecord(error) && "data" in error) {
    const data = error.data
    if (isRecord(data) && "message" in data && typeof data.message === "string") return data.message
  }
  if (typeof error === "string" && error) return error
  return "Failed to submit prompt"
}
