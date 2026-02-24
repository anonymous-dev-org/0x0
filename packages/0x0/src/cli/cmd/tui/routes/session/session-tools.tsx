import path from "path"
import stripAnsi from "strip-ansi"
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { Dynamic } from "solid-js/web"
import { BoxRenderable, RGBA, TextAttributes } from "@opentui/core"
import { useRenderer, type JSX } from "@opentui/solid"
import type { Tool } from "@/tool/tool"
import type { ReadTool } from "@/tool/read"
import type { WriteTool } from "@/tool/write"
import { BashTool } from "@/tool/bash"
import type { SearchTool } from "@/tool/search"
import type { SearchRemoteTool } from "@/tool/search_remote"
import type { GlobTool } from "@/tool/glob"
import { TodoWriteTool } from "@/tool/todo"
import type { GrepTool } from "@/tool/grep"
import type { ListTool } from "@/tool/ls"
import type { EditTool } from "@/tool/edit"
import type { ApplyPatchTool } from "@/tool/apply_patch"
import type { WebFetchTool } from "@/tool/webfetch"
import type { TaskTool } from "@/tool/task"
import type { QuestionTool } from "@/tool/question"
import type { SkillTool } from "@/tool/skill"
import type { LspTool } from "@/tool/lsp"
import type { AssistantMessage, ToolPart } from "@/server/types"
import { theme, themeState } from "@tui/state/theme"
import { sync } from "@tui/state/sync"
import { route } from "@tui/state/route"
import { local } from "@tui/state/local"
import { keybind } from "@tui/state/keybind"
import { SplitBorder } from "@tui/component/border"
import { Spinner } from "@tui/component/spinner"
import { TodoItem } from "../../component/todo-item"
import { Locale } from "@/util/locale"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { normalizePath, toolInput, filetype } from "./session-tool-format"

export type SessionToolContext = {
  width: number
  sessionID: string
  diffWrapMode: () => "word" | "none"
  sync: typeof sync
}

type ToolProps<T extends Tool.Info> = {
  input: Partial<Tool.InferParameters<T>>
  metadata: Partial<Tool.InferMetadata<T>>
  permission: Record<string, unknown>
  tool: string
  output?: string
  part: ToolPart
  message: AssistantMessage
  ctx: SessionToolContext
}

const TOOL_COMPONENTS: Record<string, (props: ToolProps<Tool.Info>) => JSX.Element> = {
  bash: Bash,
  search: Search,
  glob: Glob,
  read: Read,
  grep: Grep,
  list: List,
  webfetch: WebFetch,
  search_remote: SearchRemote,
  codesearch: CodeSearch,
  websearch: WebSearch,
  write: Write,
  edit: Edit,
  task: Task,
  apply_patch: ApplyPatch,
  todowrite: TodoWrite,
  question: Question,
  lsp: Lsp,
  skill: Skill,
}

export function SessionTool(props: ToolProps<Tool.Info>) {
  const Component = () => TOOL_COMPONENTS[props.tool] ?? GenericTool
  return <Dynamic component={Component()} {...props} />
}

function GenericTool(props: ToolProps<Tool.Info>) {
  return (
    <InlineTool icon="⚙" pending="Writing command..." complete={true} part={props.part} ctx={props.ctx}>
      {props.tool} {toolInput(props.input as Record<string, unknown>)}
    </InlineTool>
  )
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  complete: unknown
  pending: string
  children: JSX.Element
  part: ToolPart
  ctx: SessionToolContext
}) {
  const [margin, setMargin] = createSignal(0)
  const permission = () => {
    const callID = sync.data.permission[props.ctx.sessionID]?.at(0)?.tool?.callID
    if (!callID) return false
    return callID === props.part.callID
  }

  const fg = () => {
    if (permission()) return theme.warning
    if (props.complete) return theme.textMuted
    return theme.text
  }

  const error = () => (props.part.state.status === "error" ? props.part.state.error : undefined)

  const denied = () =>
    error()?.includes("rejected permission") ||
    error()?.includes("specified a rule") ||
    error()?.includes("user dismissed")

  return (
    <box
      marginTop={margin()}
      paddingLeft={3}
      renderBefore={function () {
        const el = this as BoxRenderable
        const parent = el.parent
        if (!parent) {
          return
        }
        if (el.height > 1) {
          setMargin(1)
          return
        }
        const children = parent.getChildren()
        const index = children.indexOf(el)
        const previous = children[index - 1]
        if (!previous) {
          setMargin(0)
          return
        }
        if (previous.height > 1 || previous.id.startsWith("text-")) {
          setMargin(1)
          return
        }
      }}
    >
      <text paddingLeft={3} fg={fg()} attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}>
        <Show fallback={<>~ {props.pending}</>} when={props.complete}>
          <span style={{ fg: props.iconColor }}>{props.icon}</span> {props.children}
        </Show>
      </text>
      <Show when={error() && !denied()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

function BlockTool(props: {
  title: string
  children: JSX.Element
  onClick?: () => void
  part?: ToolPart
  spinner?: boolean
}) {
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const error = () => (props.part?.state.status === "error" ? props.part.state.error : undefined)
  return (
    <box
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      marginTop={1}
      gap={1}
      backgroundColor={hover() ? theme.backgroundMenu : theme.backgroundPanel}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.background}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <Show
        when={props.spinner}
        fallback={
          <text paddingLeft={3} fg={theme.textMuted}>
            {props.title}
          </text>
        }
      >
        <Spinner color={theme.textMuted}>{props.title.replace(/^# /, "")}</Spinner>
      </Show>
      {props.children}
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

function Bash(props: ToolProps<typeof BashTool>) {
  const isRunning = () => props.part.state.status === "running"
  const output = () => stripAnsi(props.metadata.output?.trim() ?? "")
  const [expanded, setExpanded] = createSignal(false)
  const lines = () => output().split("\n")
  const overflow = () => lines().length > 10
  const limited = () => {
    if (expanded() || !overflow()) return output()
    return [...lines().slice(0, 10), "…"].join("\n")
  }

  const workdirDisplay = () => {
    const workdir = props.input.workdir
    if (!workdir || workdir === ".") return undefined

    const base = sync.data.path.directory
    if (!base) return undefined

    const absolute = path.resolve(base, workdir)
    if (absolute === base) return undefined

    const home = Global.Path.home
    if (!home) return absolute

    const match = absolute === home || absolute.startsWith(home + path.sep)
    return match ? absolute.replace(home, "~") : absolute
  }

  const title = () => {
    const desc = props.input.description ?? "Shell"
    const wd = workdirDisplay()
    if (!wd) return `# ${desc}`
    if (desc.includes(wd)) return `# ${desc}`
    return `# ${desc} in ${wd}`
  }

  return (
    <Switch>
      <Match when={props.metadata.output !== undefined}>
        <BlockTool
          title={title()}
          part={props.part}
          spinner={isRunning()}
          onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
        >
          <box gap={1}>
            <text fg={theme.text}>$ {props.input.command}</text>
            <Show when={output()}>
              <text fg={theme.text}>{limited()}</text>
            </Show>
            <Show when={overflow()}>
              <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="$"
          pending="Writing command..."
          complete={props.input.command}
          part={props.part}
          ctx={props.ctx}
        >
          {props.input.command}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Write(props: ToolProps<typeof WriteTool>) {
  const syntax = themeState.syntax
  const code = () => {
    if (!props.input.content) return ""
    return props.input.content
  }

  const diagnostics = createMemo(() => {
    const filePath = Filesystem.normalizePath(props.input.filePath ?? "")
    return props.metadata.diagnostics?.[filePath] ?? []
  })

  return (
    <Switch>
      <Match when={props.metadata.diagnostics !== undefined}>
        <BlockTool title={"# Wrote " + normalizePath(props.input.filePath!)} part={props.part}>
          <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={theme.text}
              filetype={filetype(props.input.filePath!)}
              syntaxStyle={syntax()}
              content={code()}
            />
          </line_number>
          <Show when={diagnostics().length}>
            <For each={diagnostics()}>
              {(diagnostic) => (
                <text fg={theme.error}>
                  Error [{diagnostic.range.start.line}:{diagnostic.range.start.character}]: {diagnostic.message}
                </text>
              )}
            </For>
          </Show>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="←"
          pending="Preparing write..."
          complete={props.input.filePath}
          part={props.part}
          ctx={props.ctx}
        >
          Write {normalizePath(props.input.filePath!)}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps<typeof GlobTool>) {
  return (
    <InlineTool icon="✱" pending="Finding files..." complete={props.input.pattern} part={props.part} ctx={props.ctx}>
      Glob "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
      <Show when={props.metadata.count}>
        ({props.metadata.count} {props.metadata.count === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function Search(props: ToolProps<typeof SearchTool>) {
  return (
    <Show
      when={props.input.mode === "files"}
      fallback={
        <InlineTool
          icon="✱"
          pending="Searching content..."
          complete={props.input.pattern}
          part={props.part}
          ctx={props.ctx}
        >
          Search content "{props.input.pattern}"{" "}
          <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
          <Show when={props.input.include}>include={props.input.include} </Show>
          <Show when={props.metadata.matches !== undefined}>
            ({props.metadata.matches} {props.metadata.matches === 1 ? "match" : "matches"})
          </Show>
        </InlineTool>
      }
    >
      <InlineTool icon="✱" pending="Finding files..." complete={props.input.pattern} part={props.part} ctx={props.ctx}>
        Search files "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
        <Show when={props.metadata.count !== undefined}>
          ({props.metadata.count} {props.metadata.count === 1 ? "match" : "matches"})
        </Show>
      </InlineTool>
    </Show>
  )
}

function Read(props: ToolProps<typeof ReadTool>) {
  const loaded = () => {
    if (props.part.state.status !== "completed") return []
    if (props.part.state.time.compacted) return []
    const value = props.metadata.loaded
    if (!value || !Array.isArray(value)) return []
    return value.filter((p): p is string => typeof p === "string")
  }
  return (
    <>
      <InlineTool icon="→" pending="Reading file..." complete={props.input.filePath} part={props.part} ctx={props.ctx}>
        Read {normalizePath(props.input.filePath!)} {toolInput(props.input as Record<string, unknown>, ["filePath"])}
      </InlineTool>
      <For each={loaded()}>
        {(filepath) => (
          <box paddingLeft={3}>
            <text paddingLeft={3} fg={theme.textMuted}>
              ↳ Loaded {normalizePath(filepath)}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

function Grep(props: ToolProps<typeof GrepTool>) {
  return (
    <InlineTool
      icon="✱"
      pending="Searching content..."
      complete={props.input.pattern}
      part={props.part}
      ctx={props.ctx}
    >
      Grep "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
      <Show when={props.metadata.matches}>
        ({props.metadata.matches} {props.metadata.matches === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function List(props: ToolProps<typeof ListTool>) {
  const dir = () => {
    if (props.input.path) {
      return normalizePath(props.input.path)
    }
    return ""
  }
  return (
    <InlineTool
      icon="→"
      pending="Listing directory..."
      complete={props.input.path !== undefined}
      part={props.part}
      ctx={props.ctx}
    >
      List {dir()}
    </InlineTool>
  )
}

function WebFetch(props: ToolProps<typeof WebFetchTool>) {
  const url = () => (props.input as { url?: string }).url
  return (
    <InlineTool icon="%" pending="Fetching from the web..." complete={url()} part={props.part} ctx={props.ctx}>
      WebFetch {url()}
    </InlineTool>
  )
}

function SearchRemote(props: ToolProps<typeof SearchRemoteTool>) {
  const mode = () => props.input.mode
  const complete = () => (mode() === "fetch" ? props.input.url : props.input.query)

  return (
    <InlineTool icon="◈" pending="Searching remote..." complete={complete()} part={props.part} ctx={props.ctx}>
      <Show when={mode() === "fetch"}>Fetch {props.input.url}</Show>
      <Show when={mode() === "web"}>Web search "{props.input.query}"</Show>
      <Show when={mode() === "code"}>Code search "{props.input.query}"</Show>
      <Show when={!mode()}>Search remote</Show>
    </InlineTool>
  )
}

function CodeSearch(props: ToolProps<Tool.Info>) {
  const input = () => props.input as { query?: string }
  const metadata = () => props.metadata as { results?: number }
  return (
    <InlineTool icon="◇" pending="Searching code..." complete={input().query} part={props.part} ctx={props.ctx}>
      Exa Code Search "{input().query}" <Show when={metadata().results}>({metadata().results} results)</Show>
    </InlineTool>
  )
}

function WebSearch(props: ToolProps<Tool.Info>) {
  const input = () => props.input as { query?: string }
  const metadata = () => props.metadata as { numResults?: number }
  return (
    <InlineTool icon="◈" pending="Searching web..." complete={input().query} part={props.part} ctx={props.ctx}>
      Exa Web Search "{input().query}" <Show when={metadata().numResults}>({metadata().numResults} results)</Show>
    </InlineTool>
  )
}

function Task(props: ToolProps<typeof TaskTool>) {
  const { navigate } = route
  const mode = () => props.input.mode
  const handoff = () =>
    (
      props.metadata as {
        handoff?: {
          switched?: boolean
          sourceAgent?: string
          targetAgent?: string
          reason?: string
        }
      }
    ).handoff
  const targetAgent = () => handoff()?.targetAgent ?? props.input.agent

  const tools = createMemo(() => {
    const sessionID = props.metadata.sessionId
    const msgs = sync.data.message[sessionID ?? ""] ?? []
    return msgs.flatMap((msg) =>
      (sync.data.part[msg.id] ?? [])
        .filter((part): part is ToolPart => part.type === "tool")
        .map((part) => ({ tool: part.tool, state: part.state })),
    )
  })

  const current = () => tools().findLast((x) => x.state.status !== "pending")

  const isRunning = () => props.part.state.status === "running"

  return (
    <Switch>
      <Match when={props.input.description || props.input.agent}>
        <BlockTool
          title={
            mode() === "handoff"
              ? "# Handoff to " + Locale.titlecase(targetAgent() ?? "unknown")
              : "# " + Locale.titlecase(props.input.agent ?? "unknown") + " Task"
          }
          onClick={
            props.metadata.sessionId
              ? () => navigate({ type: "session", sessionID: props.metadata.sessionId! })
              : undefined
          }
          part={props.part}
          spinner={isRunning()}
        >
          <box>
            <Show
              when={mode() === "handoff"}
              fallback={
                <text style={{ fg: theme.textMuted }}>
                  {props.input.description} ({tools().length} toolcalls)
                </text>
              }
            >
              <text style={{ fg: theme.textMuted }}>
                ↪ Handed off to {Locale.titlecase(targetAgent() ?? "unknown")}
              </text>
              <Show when={handoff()?.reason ?? props.input.description}>
                <text style={{ fg: theme.textMuted }}>◉ {handoff()?.reason ?? props.input.description}</text>
              </Show>
            </Show>
            <Show when={mode() !== "handoff" && current()}>
              {(item) => {
                const state = item().state
                const title =
                  state.status === "completed" && typeof (state as Record<string, unknown>).title === "string"
                    ? ((state as Record<string, unknown>).title as string)
                    : ""
                return (
                  <text style={{ fg: state.status === "error" ? theme.error : theme.textMuted }}>
                    └ {Locale.titlecase(item().tool)} {title}
                  </text>
                )
              }}
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="#" pending="Delegating..." complete={props.input.agent} part={props.part} ctx={props.ctx}>
          <Show
            when={mode() === "handoff"}
            fallback={
              <>
                {props.input.agent} Task {props.input.description}
              </>
            }
          >
            Handoff to {props.input.agent} {props.input.description}
          </Show>
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Edit(props: ToolProps<typeof EditTool>) {
  const syntax = themeState.syntax

  const view = () => {
    const diffStyle = props.ctx.sync.data.config.tui?.diff_style
    if (diffStyle === "stacked") return "unified"
    return props.ctx.width > 120 ? "split" : "unified"
  }

  const ft = () => filetype(props.input.filePath)

  const diffContent = () => props.metadata.diff

  const diagnostics = createMemo(() => {
    const filePath = Filesystem.normalizePath(props.input.filePath ?? "")
    const arr = props.metadata.diagnostics?.[filePath] ?? []
    return arr.filter((x) => x.severity === 1).slice(0, 3)
  })

  return (
    <Switch>
      <Match when={props.metadata.diff !== undefined}>
        <BlockTool title={"← Edit " + normalizePath(props.input.filePath!)} part={props.part}>
          <box paddingLeft={1}>
            <diff
              diff={diffContent()}
              view={view()}
              filetype={ft()}
              syntaxStyle={syntax()}
              showLineNumbers={true}
              width="100%"
              wrapMode={props.ctx.diffWrapMode()}
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
          </box>
          <Show when={diagnostics().length}>
            <box>
              <For each={diagnostics()}>
                {(diagnostic) => (
                  <text fg={theme.error}>
                    Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]{" "}
                    {diagnostic.message}
                  </text>
                )}
              </For>
            </box>
          </Show>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="←"
          pending="Preparing edit..."
          complete={props.input.filePath}
          part={props.part}
          ctx={props.ctx}
        >
          Edit {normalizePath(props.input.filePath!)} {toolInput({ replaceAll: props.input.replaceAll })}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps<typeof ApplyPatchTool>) {
  const syntax = themeState.syntax

  const files = () => props.metadata.files ?? []

  const view = () => {
    const diffStyle = props.ctx.sync.data.config.tui?.diff_style
    if (diffStyle === "stacked") return "unified"
    return props.ctx.width > 120 ? "split" : "unified"
  }

  function Diff(p: { diff: string; filePath: string }) {
    return (
      <box paddingLeft={1}>
        <diff
          diff={p.diff}
          view={view()}
          filetype={filetype(p.filePath)}
          syntaxStyle={syntax()}
          showLineNumbers={true}
          width="100%"
          wrapMode={props.ctx.diffWrapMode()}
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
      </box>
    )
  }

  function title(file: { type: string; relativePath: string; filePath: string; deletions: number }) {
    if (file.type === "delete") return "# Deleted " + file.relativePath
    if (file.type === "add") return "# Created " + file.relativePath
    if (file.type === "move") return "# Moved " + normalizePath(file.filePath) + " → " + file.relativePath
    return "← Patched " + file.relativePath
  }

  return (
    <Switch>
      <Match when={files().length > 0}>
        <For each={files()}>
          {(file) => (
            <BlockTool title={title(file)} part={props.part}>
              <Show
                when={file.type !== "delete"}
                fallback={
                  <text fg={theme.diffRemoved}>
                    -{file.deletions} line{file.deletions !== 1 ? "s" : ""}
                  </text>
                }
              >
                <Diff diff={file.diff} filePath={file.filePath} />
              </Show>
            </BlockTool>
          )}
        </For>
      </Match>
      <Match when={true}>
        <InlineTool icon="%" pending="Preparing apply_patch..." complete={false} part={props.part} ctx={props.ctx}>
          apply_patch
        </InlineTool>
      </Match>
    </Switch>
  )
}

function TodoWrite(props: ToolProps<typeof TodoWriteTool>) {
  return (
    <Switch>
      <Match when={props.metadata.todos?.length}>
        <BlockTool title="# Todos" part={props.part}>
          <box>
            <For each={props.input.todos ?? []}>
              {(todo) => <TodoItem status={todo.status} content={todo.content} />}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="⚙" pending="Updating todos..." complete={false} part={props.part} ctx={props.ctx}>
          Updating todos...
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps<typeof QuestionTool>) {
  const count = () => props.input.questions?.length ?? 0

  function format(answer?: string[]) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={props.metadata.answers}>
        <BlockTool title="# Questions" part={props.part}>
          <box gap={1}>
            <For each={props.input.questions ?? []}>
              {(q, i) => (
                <box flexDirection="column">
                  <text fg={theme.textMuted}>{q.question}</text>
                  <text fg={theme.text}>{format(props.metadata.answers?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="Asking questions..." complete={count()} part={props.part} ctx={props.ctx}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Lsp(props: ToolProps<typeof LspTool>) {
  return (
    <InlineTool
      icon="λ"
      pending="Querying language server..."
      complete={props.input.operation}
      part={props.part}
      ctx={props.ctx}
    >
      {props.input.operation} {normalizePath(props.input.filePath)}:{props.input.line}:{props.input.character}
    </InlineTool>
  )
}

function Skill(props: ToolProps<typeof SkillTool>) {
  return (
    <InlineTool icon="→" pending="Loading skill..." complete={props.input.name} part={props.part} ctx={props.ctx}>
      Skill "{props.input.name}"
    </InlineTool>
  )
}
