import type { TextareaRenderable } from "@opentui/core"
import { Identifier } from "@/id/id"
import { iife } from "@/util/iife"
import type { PromptInfo } from "./history"
import type { useLocal } from "@tui/context/local"
import type { useRoute } from "@tui/context/route"
import type { useSDK } from "@tui/context/sdk"
import type { useSync } from "@tui/context/sync"
import type { usePromptHistory } from "./history"

export async function submitPrompt(props: {
  disabled?: boolean
  autocompleteVisible: boolean
  prompt: PromptInfo
  mode: "normal" | "shell"
  extmarkToPartIndex: Map<number, number>
  sessionID?: string
  local: ReturnType<typeof useLocal>
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  route: ReturnType<typeof useRoute>
  history: ReturnType<typeof usePromptHistory>
  input: TextareaRenderable
  promptPartTypeId: number
  setMode: (mode: "normal" | "shell") => void
  setPrompt: (prompt: PromptInfo) => void
  setExtmarkToPartIndex: (map: Map<number, number>) => void
  onPromptModelWarning: () => void
  onSubmit?: () => void
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
        const sessionID = await props.sdk.client.session.create({}).then((x) => x.data!.id)
        return sessionID
      })()

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

  if (props.mode === "shell") {
    props.sdk.client.session.shell({
      sessionID,
      agent: props.local.agent.current().name,
      model: {
        providerID: selectedModel.providerID,
        modelID: selectedModel.modelID,
      },
      command: inputText,
    })
    props.setMode("normal")
  } else if (
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

    props.sdk.client.session.command({
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
  } else {
    props.sdk.client.session
      .prompt({
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
      .catch(() => {})
  }

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
