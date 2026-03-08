import type { QuestionAnswer, QuestionRequest } from "@anonymous-dev/0x0-server/server/types"
import type { TextareaRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { keybind } from "@tui/state/keybind"
import { local } from "@tui/state/local"
import { sdk } from "@tui/state/sdk"
import { sync } from "@tui/state/sync"
import { theme, tint } from "@tui/state/theme"
import { batch, createMemo, createSignal, For, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { SplitBorder } from "../../component/border"
import { useTextareaKeybindings } from "../../component/textarea-keybindings"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"

export function QuestionPrompt(props: { request: QuestionRequest }) {
  const bindings = useTextareaKeybindings()

  const questions = createMemo(() => props.request.questions)
  const [store, setStore] = createStore({
    tab: 0,
    answers: [] as QuestionAnswer[],
    custom: [] as string[],
    selected: 0,
    editing: false,
  })

  let textarea: TextareaRenderable | undefined

  const issuingAgent = createMemo(() => {
    const messageID = props.request.tool?.messageID
    if (!messageID) return local.agent.current().name
    const sessionMessages = sync.data.message[props.request.sessionID] ?? []
    const inSession = sessionMessages.find(message => message.id === messageID)
    if (inSession?.agent) return inSession.agent

    const allMessages = Object.values(sync.data.message).flat()
    const anySession = allMessages.find(message => message.id === messageID)
    return anySession?.agent ?? local.agent.current().name
  })
  const accent = createMemo(() => local.agent.color(issuingAgent(), local.agent.currentMode()))

  const question = createMemo(() => questions()[store.tab])
  const options = createMemo(() => question()?.options ?? [])
  const custom = createMemo(() => question()?.custom !== false)
  const other = createMemo(() => custom() && store.selected === options().length)
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const multi = createMemo(() => question()?.multiple === true)
  const isLastQuestion = createMemo(() => store.tab === questions().length - 1)
  const customPicked = createMemo(() => {
    const value = input()
    if (!value) return false
    return store.answers[store.tab]?.includes(value) ?? false
  })

  const toast = useToast()
  const [submitting, setSubmitting] = createSignal(false)

  function removeFromSyncStore() {
    const sessionID = props.request.sessionID
    const requestID = props.request.id
    sync.set(
      "question",
      sessionID,
      produce((draft: QuestionRequest[]) => {
        const index = draft.findIndex(q => q.id === requestID)
        if (index !== -1) draft.splice(index, 1)
      })
    )
  }

  async function replyAndResume(answers: QuestionAnswer[]) {
    if (submitting()) return
    setSubmitting(true)

    try {
      const response = await sdk.client.question[":requestID"].reply.$post({
        param: { requestID: props.request.id },
        json: { answers },
      } as never)

      if (!response.ok) {
        const body = await response.json().catch(() => null)
        const message =
          body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error
            : "Failed to submit answers"
        toast.show({ variant: "error", message })
        return
      }
      // Modal removal happens via the server's question.replied SSE event hitting the sync store
    } catch {
      toast.show({ variant: "error", message: "Failed to submit answers — network error" })
    } finally {
      setSubmitting(false)
    }
  }

  function submit() {
    const answers = questions().map((_, i) => store.answers[i] ?? [])
    void replyAndResume(answers)
  }

  function reject() {
    removeFromSyncStore()
    sdk.client.question[":requestID"].reject.$post({
      param: { requestID: props.request.id },
    } as never)
  }

  function pick(answer: string, isCustom: boolean = false) {
    const currentTab = store.tab
    batch(() => {
      setStore("answers", currentTab, [answer])
      if (isCustom) setStore("custom", currentTab, answer)
    })
    if (currentTab === questions().length - 1) {
      const answers = questions().map((_, i) => (i === currentTab ? [answer] : (store.answers[i] ?? [])))
      void replyAndResume(answers)
      return
    }
    batch(() => {
      setStore("tab", currentTab + 1)
      setStore("selected", 0)
    })
  }

  function toggle(answer: string) {
    const existing = store.answers[store.tab] ?? []
    const index = existing.indexOf(answer)
    const next = index === -1 ? [...existing, answer] : existing.filter(x => x !== answer)
    setStore("answers", store.tab, next)
  }

  function moveTo(index: number) {
    setStore("selected", index)
  }

  function selectTab(index: number) {
    batch(() => {
      setStore("tab", index)
      setStore("selected", 0)
    })
  }

  function selectOption() {
    if (other()) {
      if (!multi()) {
        setStore("editing", true)
        return
      }
      const value = input()
      if (value && customPicked()) {
        toggle(value)
        return
      }
      setStore("editing", true)
      return
    }
    const opt = options()[store.selected]
    if (!opt) return
    if (multi()) {
      toggle(opt.label)
      return
    }
    pick(opt.label)
  }

  const dialog = useDialog()

  useKeyboard(evt => {
    // Skip processing if a dialog (e.g., command palette) is open
    if (dialog.visible) return

    // When editing custom answer textarea
    if (store.editing) {
      if (evt.name === "escape") {
        evt.preventDefault()
        setStore("editing", false)
        return
      }
      if (keybind.match("input_clear", evt)) {
        evt.preventDefault()
        const text = textarea?.plainText ?? ""
        if (!text) {
          setStore("editing", false)
          return
        }
        textarea?.setText("")
        return
      }
      if (evt.name === "return") {
        evt.preventDefault()
        const text = textarea?.plainText?.trim() ?? ""
        const prev = store.custom[store.tab]

        if (!text) {
          if (prev) {
            batch(() => {
              setStore("custom", store.tab, "")
              setStore("answers", store.tab, a => (a ?? []).filter(x => x !== prev))
            })
          }
          setStore("editing", false)
          return
        }

        if (multi()) {
          batch(() => {
            setStore("custom", store.tab, text)
            const existing = store.answers[store.tab] ?? []
            const next = [...existing]
            if (prev) {
              const index = next.indexOf(prev)
              if (index !== -1) next.splice(index, 1)
            }
            if (!next.includes(text)) next.push(text)
            setStore("answers", store.tab, next)
            setStore("editing", false)
          })
          return
        }

        pick(text, true)
        setStore("editing", false)
        return
      }
      // Let textarea handle all other keys
      return
    }

    if (evt.name === "left" || evt.name === "h") {
      evt.preventDefault()
      if (store.tab > 0) selectTab(store.tab - 1)
      return
    }

    if (evt.name === "right" || evt.name === "l") {
      evt.preventDefault()
      if (!isLastQuestion()) {
        selectTab(store.tab + 1)
      } else if (multi()) {
        submit()
      }
      return
    }

    if (evt.name === "tab") {
      evt.preventDefault()
      const direction = evt.shift ? -1 : 1
      const next = store.tab + direction
      if (next >= 0 && next < questions().length) selectTab(next)
      return
    }

    const opts = options()
    const total = opts.length + (custom() ? 1 : 0)
    const max = Math.min(total, 9)
    const digit = Number(evt.name)

    if (!Number.isNaN(digit) && digit >= 1 && digit <= max) {
      evt.preventDefault()
      const index = digit - 1
      moveTo(index)
      selectOption()
      return
    }

    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault()
      moveTo((store.selected - 1 + total) % total)
    }

    if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault()
      moveTo((store.selected + 1) % total)
    }

    if (evt.name === "return") {
      evt.preventDefault()
      selectOption()
    }

    if (evt.name === "escape" || keybind.match("app_exit", evt)) {
      evt.preventDefault()
      reject()
    }
  })

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={accent()}
      customBorderChars={SplitBorder.customBorderChars}>
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <box paddingLeft={1} gap={1}>
          <Show when={questions().length > 1}>
            <text fg={theme.textMuted}>
              {store.tab + 1} / {questions().length}
            </text>
          </Show>
          <box>
            <text fg={theme.text}>
              {question()?.question}
              {multi() ? " (select all that apply)" : ""}
            </text>
          </box>
          <box>
            <For each={options()}>
              {(opt, i) => {
                const active = () => i() === store.selected
                const picked = () => store.answers[store.tab]?.includes(opt.label) ?? false
                return (
                  <box onMouseOver={() => moveTo(i())} onMouseDown={() => moveTo(i())} onMouseUp={() => selectOption()}>
                    <box flexDirection="row">
                      <box backgroundColor={active() ? theme.backgroundElement : undefined} paddingRight={1}>
                        <text fg={active() ? tint(theme.textMuted, theme.secondary, 0.6) : theme.textMuted}>
                          {`${i() + 1}.`}
                        </text>
                      </box>
                      <box backgroundColor={active() ? theme.backgroundElement : undefined}>
                        <text fg={active() ? theme.secondary : picked() ? theme.success : theme.text}>
                          {multi() ? `[${picked() ? "✓" : " "}] ${opt.label}` : opt.label}
                        </text>
                      </box>
                      <Show when={!multi()}>
                        <text fg={theme.success}>{picked() ? "✓" : ""}</text>
                      </Show>
                    </box>

                    <box paddingLeft={3}>
                      <text fg={theme.textMuted}>{opt.description}</text>
                    </box>
                  </box>
                )
              }}
            </For>
            <Show when={custom()}>
              <box
                onMouseOver={() => moveTo(options().length)}
                onMouseDown={() => moveTo(options().length)}
                onMouseUp={() => selectOption()}>
                <box flexDirection="row">
                  <box backgroundColor={other() ? theme.backgroundElement : undefined} paddingRight={1}>
                    <text fg={other() ? tint(theme.textMuted, theme.secondary, 0.6) : theme.textMuted}>
                      {`${options().length + 1}.`}
                    </text>
                  </box>
                  <box backgroundColor={other() ? theme.backgroundElement : undefined}>
                    <text fg={other() ? theme.secondary : customPicked() ? theme.success : theme.text}>
                      {multi() ? `[${customPicked() ? "✓" : " "}] Type your own answer` : "Type your own answer"}
                    </text>
                  </box>

                  <Show when={!multi()}>
                    <text fg={theme.success}>{customPicked() ? "✓" : ""}</text>
                  </Show>
                </box>
                <Show when={store.editing}>
                  <box paddingLeft={3}>
                    <textarea
                      ref={(val: TextareaRenderable) => {
                        textarea = val
                        queueMicrotask(() => {
                          val.gotoLineEnd()
                        })
                      }}
                      focused
                      initialValue={input()}
                      placeholder="Type your own answer"
                      minHeight={1}
                      maxHeight={6}
                      textColor={theme.text}
                      focusedTextColor={theme.text}
                      cursorColor={theme.primary}
                      keyBindings={bindings()}
                    />
                  </box>
                </Show>
                <Show when={!store.editing && input()}>
                  <box paddingLeft={3}>
                    <text fg={theme.textMuted}>{input()}</text>
                  </box>
                </Show>
              </box>
            </Show>
          </box>
        </box>
      </box>
      <box
        flexDirection="row"
        flexShrink={0}
        gap={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        justifyContent="space-between">
        <box flexDirection="row" gap={2}>
          <Show when={questions().length > 1}>
            <text fg={theme.text}>
              {"←→"} <span style={{ fg: theme.textMuted }}>navigate</span>
            </text>
          </Show>
          <text fg={theme.text}>
            {"↑↓"} <span style={{ fg: theme.textMuted }}>select</span>
          </text>
          <text fg={theme.text}>
            enter{" "}
            <span style={{ fg: theme.textMuted }}>{multi() ? "toggle" : isLastQuestion() ? "submit" : "next"}</span>
          </text>
          <Show when={multi()}>
            <text fg={theme.text}>
              → <span style={{ fg: theme.textMuted }}>{isLastQuestion() ? "submit" : "next"}</span>
            </text>
          </Show>
          <text fg={theme.text}>
            esc <span style={{ fg: theme.textMuted }}>dismiss</span>
          </text>
        </box>
      </box>
    </box>
  )
}
