import { BoxRenderable, TextareaRenderable, MouseEvent, PasteEvent, TextAttributes, t, dim, fg } from "@opentui/core"
import { createEffect, createMemo, type JSX, onMount, createSignal, onCleanup, Show } from "solid-js"
import "opentui-spinner/solid"
import { useLocal } from "@tui/context/local"
import { tint, useTheme } from "@tui/context/theme"
import { EmptyBorder } from "@tui/component/border"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { createStore, produce } from "solid-js/store"
import { useKeybind } from "@tui/context/keybind"
import { usePromptHistory, type PromptInfo } from "./history"
import { usePromptStash } from "./stash"
import { DialogStash } from "../dialog-stash"
import { type AutocompleteRef, Autocomplete } from "./autocomplete"
import { useCommandDialog } from "../dialog-command"
import { useRenderer } from "@opentui/solid"
import { Editor } from "@tui/util/editor"
import { useExit } from "../../context/exit"
import { Clipboard } from "../../util/clipboard"
import type { FilePart } from "@0x0-ai/sdk/v2"
import { TuiEvent } from "../../event"
import { Locale } from "@/util/locale"
import { formatDuration } from "@/util/format"
import { createColors, createFrames } from "../../ui/spinner.ts"
import { useDialog } from "@tui/ui/dialog"
import { DialogProvider as DialogProviderConnect } from "../dialog-provider"
import { DialogAlert } from "../../ui/dialog-alert"
import { useToast } from "../../ui/toast"
import { useKV } from "../../context/kv"
import { useTextareaKeybindings } from "../textarea-keybindings"
import { DialogSkill } from "../dialog-skill"
import { usePromptCommands } from "./use-prompt-commands"
import { usePromptParts } from "./use-prompt-parts"
import { submitPrompt } from "./submit-prompt"

export type PromptProps = {
  sessionID?: string
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  onInputChange?: (value: string) => void
  ref?: (ref: PromptRef) => void
  hint?: JSX.Element
  showPlaceholder?: boolean
}

export type PromptRef = {
  focused: boolean
  current: PromptInfo
  set(prompt: PromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
}

const PLACEHOLDERS = ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"]

export function Prompt(props: PromptProps) {
  let input: TextareaRenderable
  let anchor: BoxRenderable
  let autocomplete: AutocompleteRef

  const keybind = useKeybind()
  const local = useLocal()
  const sdk = useSDK()
  const route = useRoute()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const status = createMemo(() => sync.data.session_status?.[props.sessionID ?? ""] ?? { type: "idle" })
  const history = usePromptHistory()
  const stash = usePromptStash()
  const command = useCommandDialog()
  const renderer = useRenderer()
  const { theme, syntax } = useTheme()
  const kv = useKV()

  function promptModelWarning() {
    toast.show({
      variant: "warning",
      message: "Connect a provider to send prompts",
      duration: 3000,
    })
    if (sync.data.provider.length === 0) {
      dialog.replace(() => <DialogProviderConnect />)
    }
  }

  const textareaKeybindings = useTextareaKeybindings()

  const fileStyleId = syntax().getStyleId("extmark.file")!
  const agentStyleId = syntax().getStyleId("extmark.agent")!
  const pasteStyleId = syntax().getStyleId("extmark.paste")!
  let promptPartTypeId = 0
  const defer = (cb: () => void) => {
    queueMicrotask(() => {
      if (!input || input.isDestroyed) return
      cb()
    })
  }

  const off = sdk.event.on(TuiEvent.PromptAppend.type, (evt) => {
    if (!input || input.isDestroyed) return
    input.insertText(evt.properties.text)
    defer(() => {
      input.getLayoutNode().markDirty()
      input.gotoBufferEnd()
      renderer.requestRender()
    })
  })

  onCleanup(off)

  createEffect(() => {
    if (props.disabled) input.cursorColor = theme.backgroundElement
    if (!props.disabled) input.cursorColor = theme.text
  })

  const lastUserMessage = createMemo(() => {
    if (!props.sessionID) return undefined
    const messages = sync.data.message[props.sessionID]
    if (!messages) return undefined
    return messages.findLast((m) => m.role === "user")
  })

  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: "normal" | "shell"
    extmarkToPartIndex: Map<number, number>
    interrupt: number
    placeholder: number
  }>({
    placeholder: Math.floor(Math.random() * PLACEHOLDERS.length),
    prompt: {
      input: "",
      parts: [],
    },
    mode: "normal",
    extmarkToPartIndex: new Map(),
    interrupt: 0,
  })

  // Initialize agent/model/variant from last user message when session changes
  let syncedSessionID: string | undefined
  createEffect(() => {
    const sessionID = props.sessionID
    const msg = lastUserMessage()

    if (sessionID !== syncedSessionID) {
      if (!sessionID || !msg) return

      syncedSessionID = sessionID

      const hasAgent = local.agent.list().some((x) => x.name === msg.agent)
      if (msg.agent && hasAgent) {
        local.agent.set(msg.agent)
        if (msg.model) local.model.set(msg.model)
        local.model.variant.set(msg.variant)
      }
    }
  })

  function clear() {
    input.extmarks.clear()
    input.clear()
  }

  async function paste() {
    const content = await Clipboard.read()
    if (content?.mime.startsWith("image/")) {
      await pasteImage({
        filename: "clipboard",
        mime: content.mime,
        content: content.data,
      })
    }
  }

  async function edit() {
    const text = store.prompt.parts
      .filter((p) => p.type === "text")
      .reduce((acc, p) => {
        if (!p.source) return acc
        return acc.replace(p.source.text.value, p.text)
      }, store.prompt.input)

    const nonTextParts = store.prompt.parts.filter((p) => p.type !== "text")

    const value = text
    const content = await Editor.open({ value, renderer })
    if (!content) return

    input.setText(content)

    const updatedNonTextParts = nonTextParts
      .map((part) => {
        let virtualText = ""
        if (part.type === "file" && part.source?.text) {
          virtualText = part.source.text.value
        } else if (part.type === "agent" && part.source) {
          virtualText = part.source.value
        }

        if (!virtualText) return part

        const newStart = content.indexOf(virtualText)
        if (newStart === -1) return null

        const newEnd = newStart + virtualText.length

        if (part.type === "file" && part.source?.text) {
          return {
            ...part,
            source: {
              ...part.source,
              text: {
                ...part.source.text,
                start: newStart,
                end: newEnd,
              },
            },
          }
        }

        if (part.type === "agent" && part.source) {
          return {
            ...part,
            source: {
              ...part.source,
              start: newStart,
              end: newEnd,
            },
          }
        }

        return part
      })
      .filter((part) => part !== null)

    setStore("prompt", {
      input: content,
      parts: updatedNonTextParts,
    })
    parts.restore(updatedNonTextParts)
    input.cursorOffset = Bun.stringWidth(content)
  }

  function skills() {
    dialog.replace(() => (
      <DialogSkill
        onSelect={(skill) => {
          input.setText(`/${skill} `)
          setStore("prompt", {
            input: `/${skill} `,
            parts: [],
          })
          input.gotoBufferEnd()
        }}
      />
    ))
  }

  const ref: PromptRef = {
    get focused() {
      return input.focused
    },
    get current() {
      return store.prompt
    },
    focus() {
      input.focus()
    },
    blur() {
      input.blur()
    },
    set(prompt) {
      input.setText(prompt.input)
      setStore("prompt", prompt)
      parts.restore(prompt.parts)
      input.gotoBufferEnd()
    },
    reset() {
      input.clear()
      input.extmarks.clear()
      setStore("prompt", {
        input: "",
        parts: [],
      })
      setStore("extmarkToPartIndex", new Map())
    },
    submit() {
      submit()
    },
  }

  createEffect(() => {
    if (props.visible !== false) input?.focus()
    if (props.visible === false) input?.blur()
  })

  createEffect(() => {
    props.onInputChange?.(store.prompt.input)
  })

  const parts = usePromptParts({
    input: () => input,
    promptPartTypeId: () => promptPartTypeId,
    fileStyleId,
    agentStyleId,
    pasteStyleId,
    getParts: () => store.prompt.parts,
    getMap: () => store.extmarkToPartIndex,
    setParts: (parts) => setStore("prompt", "parts", parts),
    setMap: (map) => setStore("extmarkToPartIndex", map),
  })

  function stashPush() {
    if (!store.prompt.input) return
    stash.push({
      input: store.prompt.input,
      parts: store.prompt.parts,
    })
    input.extmarks.clear()
    input.clear()
    setStore("prompt", { input: "", parts: [] })
    setStore("extmarkToPartIndex", new Map())
  }

  function stashPop() {
    const entry = stash.pop()
    if (!entry) return
    input.setText(entry.input)
    setStore("prompt", { input: entry.input, parts: entry.parts })
    parts.restore(entry.parts)
    input.gotoBufferEnd()
  }

  function stashList() {
    dialog.replace(() => (
      <DialogStash
        onSelect={(entry) => {
          input.setText(entry.input)
          setStore("prompt", { input: entry.input, parts: entry.parts })
          parts.restore(entry.parts)
          input.gotoBufferEnd()
        }}
      />
    ))
  }

  usePromptCommands({
    command,
    sessionID: props.sessionID,
    status,
    promptInput: () => store.prompt.input,
    stashCount: () => stash.list().length,
    mode: () => store.mode,
    interrupt: () => store.interrupt,
    inputFocused: () => input.focused,
    autocompleteVisible: () => autocomplete.visible !== false,
    setMode: (mode: "normal" | "shell") => setStore("mode", mode),
    setInterrupt: (value: number) => setStore("interrupt", value),
    abortSession: (sessionID: string) => {
      sdk.client.session.abort({ sessionID })
    },
    clear,
    submit,
    paste,
    edit,
    skills,
    stashPush,
    stashPop,
    stashList,
  })

  async function submit() {
    await submitPrompt({
      disabled: props.disabled,
      autocompleteVisible: autocomplete.visible !== false,
      prompt: store.prompt,
      mode: store.mode,
      extmarkToPartIndex: store.extmarkToPartIndex,
      sessionID: props.sessionID,
      local,
      sdk,
      sync,
      route,
      history,
      input,
      promptPartTypeId,
      setMode: (mode) => setStore("mode", mode),
      setPrompt: (prompt) => setStore("prompt", prompt),
      setExtmarkToPartIndex: (map) => setStore("extmarkToPartIndex", map),
      onPromptModelWarning: promptModelWarning,
      onSubmit: props.onSubmit,
      exit,
    })
  }
  const exit = useExit()

  function pasteText(text: string, virtualText: string) {
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const extmarkEnd = extmarkStart + virtualText.length

    input.insertText(virtualText + " ")

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push({
          type: "text" as const,
          text,
          source: {
            text: {
              start: extmarkStart,
              end: extmarkEnd,
              value: virtualText,
            },
          },
        })
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
  }

  async function pasteImage(file: { filename?: string; content: string; mime: string }) {
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const count = store.prompt.parts.filter((x) => x.type === "file").length
    const virtualText = `[Image ${count + 1}]`
    const extmarkEnd = extmarkStart + virtualText.length
    const textToInsert = virtualText + " "

    input.insertText(textToInsert)

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    const part: Omit<FilePart, "id" | "messageID" | "sessionID"> = {
      type: "file" as const,
      mime: file.mime,
      filename: file.filename,
      url: `data:${file.mime};base64,${file.content}`,
      source: {
        type: "file",
        path: file.filename ?? "",
        text: {
          start: extmarkStart,
          end: extmarkEnd,
          value: virtualText,
        },
      },
    }
    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push(part)
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
    return
  }

  const agent = createMemo(() => local.agent.color(local.agent.current().name))

  const line = createMemo(() => {
    if (keybind.leader) return theme.border
    if (store.mode === "shell") return theme.primary
    return tint(theme.backgroundElement, agent(), 0.12)
  })

  const highlight = createMemo(() => {
    if (keybind.leader) return theme.border
    if (store.mode === "shell") return theme.primary
    return agent()
  })

  const showVariant = createMemo(() => {
    const variants = local.model.variant.list()
    if (variants.length === 0) return false
    const current = local.model.variant.current()
    return !!current
  })

  const spinnerDef = createMemo(() => {
    const color = local.agent.color(local.agent.current().name)
    return {
      frames: createFrames({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
      color: createColors({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
    }
  })

  return (
    <>
      <Autocomplete
        sessionID={props.sessionID}
        ref={(r) => (autocomplete = r)}
        anchor={() => anchor}
        input={() => input}
        setPrompt={(cb) => {
          setStore("prompt", produce(cb))
        }}
        value={store.prompt.input}
      />
      <box ref={(r) => (anchor = r)} visible={props.visible !== false}>
        <box
          border={["left"]}
          borderColor={line()}
          customBorderChars={{
            ...EmptyBorder,
            vertical: "┃",
            bottomLeft: "╹",
          }}
        >
          <box
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            flexShrink={0}
            backgroundColor={theme.backgroundElement}
            flexGrow={1}
          >
            <textarea
              placeholder={props.sessionID ? undefined : `Ask anything... "${PLACEHOLDERS[store.placeholder]}"`}
              textColor={keybind.leader ? theme.textMuted : theme.text}
              focusedTextColor={keybind.leader ? theme.textMuted : theme.text}
              minHeight={1}
              maxHeight={6}
              onContentChange={() => {
                const value = input.plainText
                setStore("prompt", "input", value)
                autocomplete.onInput(value)
                parts.sync()
              }}
              keyBindings={textareaKeybindings()}
              onKeyDown={async (e) => {
                if (props.disabled) {
                  e.preventDefault()
                  return
                }
                // Handle clipboard paste (Ctrl+V) - check for images first on Windows
                // This is needed because Windows terminal doesn't properly send image data
                // through bracketed paste, so we need to intercept the keypress and
                // directly read from clipboard before the terminal handles it
                if (keybind.match("input_paste", e)) {
                  const content = await Clipboard.read()
                  if (content?.mime.startsWith("image/")) {
                    e.preventDefault()
                    await pasteImage({
                      filename: "clipboard",
                      mime: content.mime,
                      content: content.data,
                    })
                    return
                  }
                  // If no image, let the default paste behavior continue
                }
                if (keybind.match("input_clear", e) && store.prompt.input !== "") {
                  input.clear()
                  input.extmarks.clear()
                  setStore("prompt", {
                    input: "",
                    parts: [],
                  })
                  setStore("extmarkToPartIndex", new Map())
                  return
                }
                if (keybind.match("app_exit", e)) {
                  if (store.prompt.input === "") {
                    await exit()
                    // Don't preventDefault - let textarea potentially handle the event
                    e.preventDefault()
                    return
                  }
                }
                if (e.name === "!" && input.visualCursor.offset === 0) {
                  setStore("mode", "shell")
                  e.preventDefault()
                  return
                }
                if (store.mode === "shell") {
                  if ((e.name === "backspace" && input.visualCursor.offset === 0) || e.name === "escape") {
                    setStore("mode", "normal")
                    e.preventDefault()
                    return
                  }
                }
                if (store.mode === "normal" && autocomplete.visible) {
                  if (keybind.match("agent_cycle", e)) {
                    local.agent.move(1)
                    e.preventDefault()
                    return
                  }
                  if (keybind.match("agent_cycle_reverse", e)) {
                    local.agent.move(-1)
                    e.preventDefault()
                    return
                  }
                }
                if (store.mode === "normal") autocomplete.onKeyDown(e)
                if (!autocomplete.visible) {
                  if (
                    (keybind.match("history_previous", e) && input.cursorOffset === 0) ||
                    (keybind.match("history_next", e) && input.cursorOffset === input.plainText.length)
                  ) {
                    const direction = keybind.match("history_previous", e) ? -1 : 1
                    const item = history.move(direction, input.plainText)

                    if (item) {
                      input.setText(item.input)
                      setStore("prompt", item)
                      setStore("mode", item.mode ?? "normal")
                      parts.restore(item.parts)
                      e.preventDefault()
                      if (direction === -1) input.cursorOffset = 0
                      if (direction === 1) input.cursorOffset = input.plainText.length
                    }
                    return
                  }

                  if (keybind.match("history_previous", e) && input.visualCursor.visualRow === 0) input.cursorOffset = 0
                  if (keybind.match("history_next", e) && input.visualCursor.visualRow === input.height - 1)
                    input.cursorOffset = input.plainText.length
                }
              }}
              onSubmit={submit}
              onPaste={async (event: PasteEvent) => {
                if (props.disabled) {
                  event.preventDefault()
                  return
                }

                // Normalize line endings at the boundary
                // Windows ConPTY/Terminal often sends CR-only newlines in bracketed paste
                // Replace CRLF first, then any remaining CR
                const normalizedText = event.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
                const pastedContent = normalizedText.trim()
                if (!pastedContent) {
                  command.trigger("prompt.paste")
                  return
                }

                // trim ' from the beginning and end of the pasted content. just
                // ' and nothing else
                const filepath = pastedContent.replace(/^'+|'+$/g, "").replace(/\\ /g, " ")
                const isUrl = /^(https?):\/\//.test(filepath)
                if (!isUrl) {
                  try {
                    const file = Bun.file(filepath)
                    // Handle SVG as raw text content, not as base64 image
                    if (file.type === "image/svg+xml") {
                      event.preventDefault()
                      const content = await file.text().catch(() => {})
                      if (content) {
                        pasteText(content, `[SVG: ${file.name ?? "image"}]`)
                        return
                      }
                    }
                    if (file.type.startsWith("image/")) {
                      event.preventDefault()
                      const content = await file
                        .arrayBuffer()
                        .then((buffer) => Buffer.from(buffer).toString("base64"))
                        .catch(() => {})
                      if (content) {
                        await pasteImage({
                          filename: file.name,
                          mime: file.type,
                          content,
                        })
                        return
                      }
                    }
                  } catch {}
                }

                const lineCount = (pastedContent.match(/\n/g)?.length ?? 0) + 1
                if (
                  (lineCount >= 3 || pastedContent.length > 150) &&
                  !sync.data.config.experimental?.disable_paste_summary
                ) {
                  event.preventDefault()
                  pasteText(pastedContent, `[Pasted ~${lineCount} lines]`)
                  return
                }

                // Force layout update and render for the pasted content
                defer(() => {
                  input.getLayoutNode().markDirty()
                  renderer.requestRender()
                })
              }}
              ref={(r: TextareaRenderable) => {
                input = r
                if (promptPartTypeId === 0) {
                  promptPartTypeId = input.extmarks.registerType("prompt-part")
                }
                props.ref?.(ref)
                defer(() => {
                  input.cursorColor = theme.text
                })
              }}
              onMouseDown={(r: MouseEvent) => r.target?.focus()}
              focusedBackgroundColor={theme.backgroundElement}
              cursorColor={theme.text}
              syntaxStyle={syntax()}
            />
            <box flexDirection="row" flexShrink={0} paddingTop={0} gap={1}>
              <text fg={highlight()} attributes={TextAttributes.DIM}>
                {store.mode === "shell" ? "Shell" : local.agent.label(local.agent.current().name)}{" "}
              </text>
              <Show when={store.mode === "normal"}>
                <box flexDirection="row" gap={1}>
                  <text flexShrink={0} fg={theme.textMuted} attributes={TextAttributes.DIM}>
                    {local.model.parsed().model}
                  </text>
                  <text fg={theme.textMuted} attributes={TextAttributes.DIM}>
                    {local.model.parsed().provider}
                  </text>
                  <Show when={showVariant()}>
                    <text fg={theme.textMuted} attributes={TextAttributes.DIM}>
                      ·
                    </text>
                    <text fg={theme.textMuted} attributes={TextAttributes.DIM}>
                      {local.model.variant.current()}
                    </text>
                  </Show>
                </box>
              </Show>
            </box>
          </box>
        </box>
        <box
          height={1}
          border={["left"]}
          borderColor={line()}
          customBorderChars={{
            ...EmptyBorder,
            vertical: theme.backgroundElement.a !== 0 ? "╹" : " ",
          }}
        >
          <box
            height={1}
            border={["bottom"]}
            borderColor={theme.backgroundElement}
            customBorderChars={
              theme.backgroundElement.a !== 0
                ? {
                    ...EmptyBorder,
                    horizontal: "▀",
                  }
                : {
                    ...EmptyBorder,
                    horizontal: " ",
                  }
            }
          />
        </box>
        <Show when={status().type !== "idle"}>
          <box
            flexDirection="row"
            gap={1}
            flexGrow={1}
            justifyContent={status().type === "retry" ? "space-between" : "flex-start"}
          >
            <box flexShrink={0} flexDirection="row" gap={1}>
              <box marginLeft={1}>
                <Show when={kv.get("animations_enabled", true)} fallback={<text fg={theme.textMuted}>[⋯]</text>}>
                  <spinner color={spinnerDef().color} frames={spinnerDef().frames} interval={40} />
                </Show>
              </box>
              <box flexDirection="row" gap={1} flexShrink={0}>
                {(() => {
                  const retry = createMemo(() => {
                    const s = status()
                    if (s.type !== "retry") return
                    return s
                  })
                  const message = createMemo(() => {
                    const r = retry()
                    if (!r) return
                    if (r.message.includes("exceeded your current quota") && r.message.includes("gemini"))
                      return "gemini is way too hot right now"
                    if (r.message.length > 80) return r.message.slice(0, 80) + "..."
                    return r.message
                  })
                  const isTruncated = createMemo(() => {
                    const r = retry()
                    if (!r) return false
                    return r.message.length > 120
                  })
                  const [seconds, setSeconds] = createSignal(0)
                  onMount(() => {
                    const timer = setInterval(() => {
                      const next = retry()?.next
                      if (next) setSeconds(Math.round((next - Date.now()) / 1000))
                    }, 1000)

                    onCleanup(() => {
                      clearInterval(timer)
                    })
                  })
                  const handleMessageClick = () => {
                    const r = retry()
                    if (!r) return
                    if (isTruncated()) {
                      DialogAlert.show(dialog, "Retry Error", r.message)
                    }
                  }

                  const retryText = () => {
                    const r = retry()
                    if (!r) return ""
                    const baseMessage = message()
                    const truncatedHint = isTruncated() ? " (click to expand)" : ""
                    const duration = formatDuration(seconds())
                    const retryInfo = ` [retrying ${duration ? `in ${duration} ` : ""}attempt #${r.attempt}]`
                    return baseMessage + truncatedHint + retryInfo
                  }

                  return (
                    <Show when={retry()}>
                      <box onMouseUp={handleMessageClick}>
                        <text fg={theme.error}>{retryText()}</text>
                      </box>
                    </Show>
                  )
                })()}
              </box>
            </box>
            <text fg={store.interrupt > 0 ? theme.primary : theme.text}>
              esc{" "}
              <span style={{ fg: store.interrupt > 0 ? theme.primary : theme.textMuted }}>
                {store.interrupt > 0 ? "again to interrupt" : "interrupt"}
              </span>
            </text>
          </box>
        </Show>
      </box>
    </>
  )
}
