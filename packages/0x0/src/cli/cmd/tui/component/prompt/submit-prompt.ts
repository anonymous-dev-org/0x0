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
  onPromptModelWarning: () => void
  onSubmit?: () => void
  onSubmitError?: (message: string) => void
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

  const sessionID = props.sessionID
    ? props.sessionID
    : await (async () => {
        try {
          const created = await props.sdk.client.session.create({})
          if (!created.data?.id) {
            props.onSubmitError?.("Failed to create session")
            return
          }
          return created.data.id
        } catch (error) {
          props.onSubmitError?.(errorMessage(error))
          return
        }
      })()
  if (!sessionID) return

  const messageID = Identifier.ascending("message")
  let inputText = props.prompt.input
  const allExtmarks = props.input.extmarks.getAllForTypeId(props.promptPartTypeId)
  const sortedExtmarks = allExtmarks.sort((a: { start: number }, b: { start: number }) => b.start - a.start)

  for (const extmark of sortedExtmarks) {
    const partIndex = props.extmarkToPartIndex.get(extmark.id)
    if (partIndex === undefined) continue
    const part = props.prompt.parts[partIndex]
    if (part?.type !== "text" || !part.text) continue
    const before = inputText.slice(0, extmark.start)
    const after = inputText.slice(extmark.end)
    inputText = before + part.text + after
  }

  const nonTextParts = props.prompt.parts.filter((part) => part.type !== "text")
  const variant = props.local.model.variant.current()

  const result = await (async () => {
    try {
      if (props.mode === "shell") {
        return await props.sdk.client.session.shell({
          sessionID,
          agent: props.local.agent.current().name,
          model: {
            providerID: selectedModel.providerID,
            modelID: selectedModel.modelID,
          },
          command: inputText,
        })
      }

      if (
        inputText.startsWith("/") &&
        iife(() => {
          const firstLine = inputText.split("\n")[0]
          const command = firstLine.split(" ")[0].slice(1)
          return props.sync.data.command.some((x) => x.name === command)
        })
      ) {
        const firstLineEnd = inputText.indexOf("\n")
        const firstLine = firstLineEnd === -1 ? inputText : inputText.slice(0, firstLineEnd)
        const [command, ...firstLineArgs] = firstLine.split(" ")
        const restOfInput = firstLineEnd === -1 ? "" : inputText.slice(firstLineEnd + 1)
        const args = firstLineArgs.join(" ") + (restOfInput ? "\n" + restOfInput : "")

        return await props.sdk.client.session.command({
          sessionID,
          command: command.slice(1),
          arguments: args,
          agent: props.local.agent.current().name,
          model: `${selectedModel.providerID}/${selectedModel.modelID}`,
          messageID,
          variant,
          parts: nonTextParts
            .filter((x) => x.type === "file")
            .map((x) => ({
              id: Identifier.ascending("part"),
              ...x,
            })),
        })
      }

      return await props.sdk.client.session.prompt({
        sessionID,
        ...selectedModel,
        messageID,
        agent: props.local.agent.current().name,
        model: selectedModel,
        variant,
        parts: [
          {
            id: Identifier.ascending("part"),
            type: "text",
            text: inputText,
          },
          ...nonTextParts.map((x) => ({
            id: Identifier.ascending("part"),
            ...x,
          })),
        ],
      })
    } catch (error) {
      return error
    }
  })()

  if (isErrorResult(result) && result.error) {
    props.onSubmitError?.(errorMessage(result.error))
    return
  }
  if (result instanceof Error) {
    props.onSubmitError?.(errorMessage(result))
    return
  }
  if (props.mode === "shell") props.setMode("normal")

  props.history.append({
    ...props.prompt,
    mode: props.mode,
  })
  props.input.extmarks.clear()
  props.setPrompt({
    input: "",
    parts: [],
  })
  props.setExtmarkToPartIndex(new Map())
  props.onSubmit?.()

  if (!props.sessionID)
    setTimeout(() => {
      props.route.navigate({
        type: "session",
        sessionID,
      })
    }, 50)
  props.input.clear()
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
