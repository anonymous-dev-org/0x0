import { createMemo, For, Match, Show, Switch } from "solid-js"
import { Dynamic } from "solid-js/web"
import { RGBA, TextAttributes } from "@opentui/core"
import { tint, theme, themeState } from "@tui/state/theme"
import { local } from "@tui/state/local"
import { sync } from "@tui/state/sync"
import { SplitBorder } from "@tui/component/border"
import { Locale } from "@anonymous-dev/0x0-server/util/locale"
import { useSessionContext, normalizeReasoningText } from "./session-context"
import { SessionTool } from "./session-tools"
import type {
  AssistantMessage as AssistantMessageType,
  Part,
  ToolPart as ToolPartType,
  TextPart as TextPartType,
  ReasoningPart as ReasoningPartType,
} from "@anonymous-dev/0x0-server/server/types"

const PART_MAPPING = {
  text: TextPart,
  tool: ToolPart,
  reasoning: ReasoningPart,
}

export function AssistantMessage(props: { message: AssistantMessageType; parts: Part[]; showHeader: boolean }) {
  const ctx = useSessionContext()
  const messages = () => sync.data.message[props.message.sessionID] ?? []

  const final = () => props.message.finish && !["tool-calls", "unknown"].includes(props.message.finish)

  const rail = createMemo(() => {
    const raw = local.agent.color(props.message.agent) ?? theme.primary
    const color = RGBA.fromInts(Math.round(raw.r * 255), Math.round(raw.g * 255), Math.round(raw.b * 255), 255)
    const dark = theme.text.r * 0.299 + theme.text.g * 0.587 + theme.text.b * 0.114 > 0.5
    if (dark) return color
    return tint(theme.text, color, 0.52)
  })

  const agentLabel = createMemo(() => local.agent.label(props.message.agent)?.trim() ?? "")
  const modelLabel = () => props.message.modelID?.trim() ?? ""
  const showMetadataRow = () => props.showHeader && ctx.showAssistantMetadata() && Boolean(agentLabel() || modelLabel())

  const duration = () => {
    if (!final()) return 0
    if (!props.message.time.completed) return 0
    const user = messages().find((x) => x.role === "user" && x.id === props.message.parentID)
    if (!user || !user.time) return 0
    return props.message.time.completed - user.time.created
  }

  const retryMessage = createMemo(() => {
    const status = sync.data.session_status?.[props.message.sessionID]
    if (status?.type !== "retry") return
    if (props.message.time.completed) return
    const nextInSeconds = Math.max(0, Math.ceil((status.next - Date.now()) / 1000))
    const eta = nextInSeconds > 0 ? ` Next retry in ~${nextInSeconds}s.` : ""
    const meta = `retry_meta{attempt=${status.attempt},next_unix_ms=${status.next}}`
    return `${status.message} Attempt ${status.attempt}.${eta} ${meta}`
  })

  return (
    <box border={["left"]} customBorderChars={SplitBorder.customBorderChars} borderColor={rail()}>
      <Show when={showMetadataRow()}>
        <box paddingLeft={3} marginTop={1}>
          <text>
            <span style={{ fg: rail() }}>▣ </span>
            <Show when={agentLabel()}>
              <span style={{ fg: rail() }}>{agentLabel()}</span>
            </Show>
            <Show when={agentLabel() && modelLabel()}>
              <span style={{ fg: theme.textMuted }}> · </span>
            </Show>
            <Show when={modelLabel()}>
              <span style={{ fg: theme.textMuted }}>{modelLabel()}</span>
            </Show>
            <Show when={duration()}>
              <span style={{ fg: theme.textMuted }}> · {Locale.duration(duration())}</span>
            </Show>
          </text>
        </box>
      </Show>
      <For each={props.parts}>
        {(part, index) => {
          const component = () => PART_MAPPING[part.type as keyof typeof PART_MAPPING]
          return (
            <Show when={component()}>
              <Dynamic
                last={index() === props.parts.length - 1}
                component={component()}
                part={part as never}
                message={props.message}
              />
            </Show>
          )
        }}
      </For>
      <Show when={props.message.error && props.message.error.name !== "MessageAbortedError"}>
        <box
          border={["left"]}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          marginTop={1}
          backgroundColor={theme.backgroundPanel}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.error}
        >
          <text fg={theme.textMuted}>{props.message.error?.data.message}</text>
        </box>
      </Show>
      <Show when={retryMessage()}>
        <box
          border={["left"]}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          marginTop={1}
          backgroundColor={theme.backgroundPanel}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.warning}
        >
          <text fg={theme.textMuted}>{retryMessage()}</text>
        </box>
      </Show>
    </box>
  )
}

function ReasoningPart(props: { last: boolean; part: ReasoningPartType; message: AssistantMessageType }) {
  const ctx = useSessionContext()
  const subtleSyntax = themeState.subtleSyntax
  const text = () => normalizeReasoningText(props.part.text)

  return (
    <Show when={ctx.showThinking() && text()}>
      <box paddingLeft={3} marginTop={1} flexShrink={0}>
        <text fg={theme.textMuted} attributes={TextAttributes.DIM | TextAttributes.ITALIC}>thinking</text>
        <code
          filetype="markdown"
          drawUnstyledText={false}
          streaming={true}
          syntaxStyle={subtleSyntax()}
          content={text()}
          conceal={ctx.conceal()}
          fg={theme.textMuted}
        />
      </box>
    </Show>
  )
}

function TextPart(props: { last: boolean; part: TextPartType; message: AssistantMessageType }) {
  const ctx = useSessionContext()
  const syntax = themeState.syntax
  const experimental = () => sync.data.config.experimental
  return (
    <Show when={props.part.text.trim()}>
      <box id={"text-" + props.part.id} paddingLeft={3} marginTop={1} flexShrink={0}>
        <Switch>
          <Match when={experimental()?.markdown}>
            <markdown
              syntaxStyle={syntax()}
              streaming={true}
              content={props.part.text.trim()}
              conceal={ctx.conceal()}
            />
          </Match>
          <Match when={!experimental()?.markdown}>
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={true}
              syntaxStyle={syntax()}
              content={props.part.text.trim()}
              conceal={ctx.conceal()}
              fg={theme.text}
            />
          </Match>
        </Switch>
      </box>
    </Show>
  )
}

function ToolPart(props: { last: boolean; part: ToolPartType; message: AssistantMessageType }) {
  const ctx = useSessionContext()

  const shouldHide = () => {
    if (ctx.showDetails()) return false
    if (props.part.state.status !== "completed") return false
    return true
  }

  const toolprops = {
    get ctx() {
      return ctx
    },
    get metadata() {
      return props.part.state.status === "pending" ? {} : (props.part.state.metadata ?? {})
    },
    get input() {
      return props.part.state.input ?? {}
    },
    get output() {
      return props.part.state.status === "completed" ? props.part.state.output : undefined
    },
    get permission() {
      const permissions = sync.data.permission[props.message.sessionID] ?? []
      const permissionIndex = permissions.findIndex((x) => x.tool?.callID === props.part.callID)
      return permissions[permissionIndex] ?? {}
    },
    get tool() {
      return props.part.tool
    },
    get message() {
      return props.message
    },
    get part() {
      return props.part
    },
  }

  return (
    <Show when={!shouldHide()}>
      <SessionTool {...toolprops} />
    </Show>
  )
}
