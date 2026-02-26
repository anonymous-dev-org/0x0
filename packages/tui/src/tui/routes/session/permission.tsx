import { createStore } from "solid-js/store"
import { For, Match, Show, Switch } from "solid-js"
import { Portal, useKeyboard, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { keybind } from "@tui/state/keybind"
import { theme, themeState, selectedForeground } from "@tui/state/theme"
import type { PermissionRequest } from "@anonymous-dev/0x0-server/server/types"
import { sdk } from "@tui/state/sdk"
import { SplitBorder } from "../../component/border"
import { sync } from "@tui/state/sync"
import { useTextareaKeybindings } from "../../component/textarea-keybindings"
import path from "path"
import { Keybind } from "@anonymous-dev/0x0-server/util/keybind"
import { Locale } from "@anonymous-dev/0x0-server/util/locale"
import { useDialog } from "../../ui/dialog"
import { filetype, normalizePath } from "./session-tool-format"

type PermissionStage = "permission" | "always" | "always_deny" | "reject"

function EditBody(props: { request: PermissionRequest }) {
  const dimensions = useTerminalDimensions()

  const filepath = () => (props.request.metadata?.filepath as string) ?? ""
  const diff = () => (props.request.metadata?.diff as string) ?? ""

  const view = () => {
    const diffStyle = sync.data.config.tui?.diff_style
    if (diffStyle === "stacked") return "unified"
    return dimensions().width > 120 ? "split" : "unified"
  }

  const ft = () => filetype(filepath())

  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" gap={1} paddingLeft={1}>
        <text fg={theme.textMuted}>{"→"}</text>
        <text fg={theme.textMuted}>Edit {normalizePath(filepath())}</text>
      </box>
      <Show when={diff()}>
        <scrollbox height="100%">
          <diff
            diff={diff()}
            view={view()}
            filetype={ft()}
            syntaxStyle={themeState.syntax()}
            showLineNumbers={true}
            width="100%"
            wrapMode="word"
            fg={theme.text}
            addedBg={theme.diffAddedBg}
            removedBg={theme.diffRemovedBg}
            contextBg={theme.diffContextBg}
            addedSignColor={theme.diffHighlightAdded}
            removedSignColor={theme.diffHighlightRemoved}
            lineNumberFg={theme.diffLineNumber}
            lineNumberBg={theme.diffContextBg}
            addedLineNumberBg={theme.diffAddedLineNumberBg}
            removedLineNumberBg={theme.diffRemovedLineNumberBg}
          />
        </scrollbox>
      </Show>
    </box>
  )
}

function TextBody(props: { title: string; description?: string; icon?: string }) {
  return (
    <>
      <box flexDirection="row" gap={1} paddingLeft={1}>
        <Show when={props.icon}>
          <text fg={theme.textMuted} flexShrink={0}>
            {props.icon}
          </text>
        </Show>
        <text fg={theme.textMuted}>{props.title}</text>
      </box>
      <Show when={props.description}>
        <box paddingLeft={1}>
          <text fg={theme.text}>{props.description}</text>
        </box>
      </Show>
    </>
  )
}

function SearchBody(props: { input: Record<string, unknown> }) {
  const mode = () => props.input.mode as string | undefined
  return (
    <Show
      when={mode() === "files"}
      fallback={<TextBody icon="✱" title={`Search content "` + (props.input.pattern ?? "") + `"`} />}
    >
      <TextBody icon="✱" title={`Search files "` + (props.input.pattern ?? "") + `"`} />
    </Show>
  )
}

function TaskHandoffBody(props: { request: PermissionRequest; input: Record<string, unknown> }) {
  const target = () =>
    (props.request.metadata?.targetAgent as string | undefined) ??
    (props.input.agent as string | undefined) ??
    "Unknown"
  const reason = () =>
    (props.request.metadata?.reason as string | undefined) ?? (props.input.description as string | undefined)
  return (
    <TextBody icon="↪" title={`Allow handoff to ${target()}`} description={reason() ? "◉ " + reason() : undefined} />
  )
}

function SearchRemoteBody(props: { input: Record<string, unknown> }) {
  const mode = () => props.input.mode as string | undefined
  return (
    <Switch>
      <Match when={mode() === "fetch"}>
        <TextBody icon="%" title={`Fetch ` + (props.input.url ?? "")} />
      </Match>
      <Match when={mode() === "web"}>
        <TextBody icon="◈" title={`Web search "` + (props.input.query ?? "") + `"`} />
      </Match>
      <Match when={true}>
        <TextBody icon="◇" title={`Code search "` + (props.input.query ?? "") + `"`} />
      </Match>
    </Switch>
  )
}

function ExternalDirectoryBody(props: { request: PermissionRequest }) {
  const dir = () => {
    const meta = props.request.metadata ?? {}
    const parent = typeof meta["parentDir"] === "string" ? meta["parentDir"] : undefined
    const filepath = typeof meta["filepath"] === "string" ? meta["filepath"] : undefined
    const pattern = props.request.patterns?.[0]
    const derived = typeof pattern === "string" ? (pattern.includes("*") ? path.dirname(pattern) : pattern) : undefined
    return normalizePath(parent ?? filepath ?? derived)
  }
  return <TextBody icon="←" title={`Access external directory ` + dir()} />
}

function PermissionBody(props: { request: PermissionRequest; input: Record<string, unknown> }) {
  return (
    <Switch>
      <Match when={props.request.permission === "edit"}>
        <EditBody request={props.request} />
      </Match>
      <Match when={props.request.permission === "read"}>
        <TextBody icon="→" title={`Read ` + normalizePath(props.input.filePath as string)} />
      </Match>
      <Match when={props.request.permission === "search"}>
        <SearchBody input={props.input} />
      </Match>
      <Match when={props.request.permission === "glob"}>
        <TextBody icon="✱" title={`Glob "` + (props.input.pattern ?? "") + `"`} />
      </Match>
      <Match when={props.request.permission === "grep"}>
        <TextBody icon="✱" title={`Grep "` + (props.input.pattern ?? "") + `"`} />
      </Match>
      <Match when={props.request.permission === "list"}>
        <TextBody icon="→" title={`List ` + normalizePath(props.input.path as string)} />
      </Match>
      <Match when={props.request.permission === "bash"}>
        <TextBody
          icon="#"
          title={(props.input.description as string) ?? ""}
          description={("$ " + props.input.command) as string}
        />
      </Match>
      <Match when={props.request.permission === "task"}>
        <TextBody
          icon="#"
          title={`${Locale.titlecase((props.input.agent as string) ?? "Unknown")} Task`}
          description={"◉ " + props.input.description}
        />
      </Match>
      <Match when={props.request.permission === "task_handoff"}>
        <TaskHandoffBody request={props.request} input={props.input} />
      </Match>
      <Match when={props.request.permission === "search_remote"}>
        <SearchRemoteBody input={props.input} />
      </Match>
      <Match when={props.request.permission === "webfetch"}>
        <TextBody icon="%" title={`WebFetch ` + (props.input.url ?? "")} />
      </Match>
      <Match when={props.request.permission === "websearch"}>
        <TextBody icon="◈" title={`Exa Web Search "` + (props.input.query ?? "") + `"`} />
      </Match>
      <Match when={props.request.permission === "codesearch"}>
        <TextBody icon="◇" title={`Exa Code Search "` + (props.input.query ?? "") + `"`} />
      </Match>
      <Match when={props.request.permission === "external_directory"}>
        <ExternalDirectoryBody request={props.request} />
      </Match>
      <Match when={props.request.permission === "doom_loop"}>
        <TextBody icon="⟳" title="Continue after repeated failures" />
      </Match>
      <Match when={props.request.permission === "lsp"}>
        <TextBody icon="λ" title={`LSP ` + normalizePath(props.input.filePath as string)} />
      </Match>
      <Match when={true}>
        <TextBody icon="⚙" title={`Call tool ` + props.request.permission} />
      </Match>
    </Switch>
  )
}

export function PermissionPrompt(props: { request: PermissionRequest }) {
  const [store, setStore] = createStore({
    stage: "permission" as PermissionStage,
  })

  const session = () => sync.session.get(props.request.sessionID)

  const input = () => {
    const tool = props.request.tool
    if (!tool) return {}
    const parts = sync.data.part[tool.messageID] ?? []
    for (const part of parts) {
      if (part.type === "tool" && part.callID === tool.callID && part.state.status !== "pending") {
        return part.state.input ?? {}
      }
    }
    return {}
  }


  return (
    <Switch>
      <Match when={store.stage === "always"}>
        <Prompt
          title="Always allow"
          body={
            <TextBody
              title={
                "This will always allow " +
                ((props.request.metadata?.tool as string) ?? props.request.permission) +
                " for this agent. This will be saved to config.yaml."
              }
            />
          }
          options={{ confirm: "Confirm", cancel: "Cancel" }}
          escapeKey="cancel"
          onSelect={(option) => {
            setStore("stage", "permission")
            if (option === "cancel") return
            sdk.client.permission[":requestID"].reply.$post({
              param: { requestID: props.request.id },
              json: { reply: "always" },
            } as any)
          }}
        />
      </Match>
      <Match when={store.stage === "always_deny"}>
        <Prompt
          title="Always deny"
          body={
            <TextBody
              title={
                "This will always deny " +
                ((props.request.metadata?.tool as string) ?? props.request.permission) +
                " for this agent. This will be saved to config.yaml."
              }
            />
          }
          options={{ confirm: "Confirm", cancel: "Cancel" }}
          escapeKey="cancel"
          onSelect={(option) => {
            setStore("stage", "permission")
            if (option === "cancel") return
            sdk.client.permission[":requestID"].reply.$post({
              param: { requestID: props.request.id },
              json: { reply: "always_deny" },
            } as any)
          }}
        />
      </Match>
      <Match when={store.stage === "reject"}>
        <RejectPrompt
          onConfirm={(message) => {
            sdk.client.permission[":requestID"].reply.$post({
              param: { requestID: props.request.id },
              json: { reply: "reject", message: message || undefined },
            } as any)
          }}
          onCancel={() => {
            setStore("stage", "permission")
          }}
        />
      </Match>
      <Match when={store.stage === "permission"}>
        <Prompt
          title="Permission required"
          body={<PermissionBody request={props.request} input={input()} />}
          options={
            props.request.permission === "task_handoff"
              ? { once: "Allow once", reject: "Deny" }
              : { once: "Accept", always: "Always accept", always_deny: "Always deny", reject: "Deny" }
          }
          escapeKey="reject"
          fullscreen
          onSelect={(option) => {
            if (option === "always") {
              setStore("stage", "always")
              return
            }
            if (option === "always_deny") {
              setStore("stage", "always_deny")
              return
            }
            if (option === "reject") {
              if (session()?.parentID) {
                setStore("stage", "reject")
                return
              }
              sdk.client.permission[":requestID"].reply.$post({
                param: { requestID: props.request.id },
                json: { reply: "reject" },
              } as any)
              return
            }
            sdk.client.permission[":requestID"].reply.$post({
              param: { requestID: props.request.id },
              json: { reply: "once" },
            } as any)
          }}
        />
      </Match>
    </Switch>
  )
}

function RejectPrompt(props: { onConfirm: (message: string) => void; onCancel: () => void }) {
  let input: TextareaRenderable
  const textareaKeybindings = useTextareaKeybindings()
  const dimensions = useTerminalDimensions()
  const narrow = () => dimensions().width < 80
  const dialog = useDialog()

  useKeyboard((evt) => {
    if (dialog.visible) return

    if (evt.name === "escape" || keybind.match("app_exit", evt)) {
      evt.preventDefault()
      props.onCancel()
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      props.onConfirm(input.plainText)
    }
  })

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.error}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <box flexDirection="row" gap={1} paddingLeft={1}>
          <text fg={theme.error}>{"△"}</text>
          <text fg={theme.text}>Reject permission</text>
        </box>
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>Tell Terminal Agent what to do differently</text>
        </box>
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.backgroundElement}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
        gap={1}
      >
        <textarea
          ref={(val: TextareaRenderable) => (input = val)}
          focused
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.primary}
          keyBindings={textareaKeybindings()}
        />
        <box flexDirection="row" gap={2} flexShrink={0}>
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>confirm</span>
          </text>
          <text fg={theme.text}>
            esc <span style={{ fg: theme.textMuted }}>cancel</span>
          </text>
        </box>
      </box>
    </box>
  )
}

function Prompt<const T extends Record<string, string>>(props: {
  title: string
  body: JSX.Element
  options: T
  escapeKey?: keyof T
  fullscreen?: boolean
  onSelect: (option: keyof T) => void
}) {
  const dimensions = useTerminalDimensions()
  const keys = Object.keys(props.options) as (keyof T)[]
  const [store, setStore] = createStore({
    selected: keys[0],
    expanded: false,
  })
  const diffKey = Keybind.parse("ctrl+f")[0]
  const narrow = () => dimensions().width < 80
  const dialog = useDialog()

  useKeyboard((evt) => {
    if (dialog.visible) return

    if (evt.name === "left" || evt.name == "h") {
      evt.preventDefault()
      if (store.selected === undefined) return
      const idx = keys.indexOf(store.selected)
      const next = keys[(idx - 1 + keys.length) % keys.length]
      if (next !== undefined) setStore("selected", next)
    }

    if (evt.name === "right" || evt.name == "l") {
      evt.preventDefault()
      if (store.selected === undefined) return
      const idx = keys.indexOf(store.selected)
      const next = keys[(idx + 1) % keys.length]
      if (next !== undefined) setStore("selected", next)
    }

    if (evt.name === "return") {
      evt.preventDefault()
      if (store.selected !== undefined) props.onSelect(store.selected)
    }

    if (props.escapeKey && (evt.name === "escape" || keybind.match("app_exit", evt))) {
      evt.preventDefault()
      props.onSelect(props.escapeKey)
    }

    if (props.fullscreen && diffKey && Keybind.match(diffKey, keybind.parse(evt))) {
      evt.preventDefault()
      evt.stopPropagation()
      setStore("expanded", (v) => !v)
    }
  })

  const hint = () => (store.expanded ? "minimize" : "fullscreen")
  const renderer = useRenderer()

  const content = () => (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.warning}
      customBorderChars={SplitBorder.customBorderChars}
      {...(store.expanded
        ? { top: dimensions().height * -1 + 1, bottom: 1, left: 2, right: 2, position: "absolute" }
        : {
            top: 0,
            maxHeight: 15,
            bottom: 0,
            left: 0,
            right: 0,
            position: "relative",
          })}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1} flexGrow={1}>
        <box flexDirection="row" gap={1} paddingLeft={1} flexShrink={0}>
          <text fg={theme.warning}>{"△"}</text>
          <text fg={theme.text}>{props.title}</text>
        </box>
        {props.body}
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        gap={1}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.backgroundElement}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
      >
        <box flexDirection="row" gap={1} flexShrink={0}>
          <For each={keys}>
            {(option) => (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={option === store.selected ? theme.warning : theme.backgroundMenu}
                onMouseOver={() => setStore("selected", option)}
                onMouseUp={() => {
                  setStore("selected", option)
                  props.onSelect(option)
                }}
              >
                <text fg={option === store.selected ? selectedForeground(theme, theme.warning) : theme.textMuted}>
                  {props.options[option]}
                </text>
              </box>
            )}
          </For>
        </box>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <Show when={props.fullscreen}>
            <text fg={theme.text}>
              {"ctrl+f"} <span style={{ fg: theme.textMuted }}>{hint()}</span>
            </text>
          </Show>
          <text fg={theme.text}>
            {"⇆"} <span style={{ fg: theme.textMuted }}>select</span>
          </text>
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>confirm</span>
          </text>
        </box>
      </box>
    </box>
  )

  return (
    <Show when={!store.expanded} fallback={<Portal>{content()}</Portal>}>
      {content()}
    </Show>
  )
}
