import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  VcsInfo,
  Path,
} from "@anonymous-dev/0x0-server/server/types"
import { createStore, produce, reconcile } from "solid-js/store"
import { sdk } from "@tui/state/sdk"
import { Binary } from "@anonymous-dev/0x0-util/binary"
import type { Snapshot } from "@anonymous-dev/0x0-server/snapshot"
import { exit } from "@tui/state/exit"
import { batch, onMount } from "solid-js"
import { Log } from "@anonymous-dev/0x0-server/util/log"

type SyncStore = {
  status: "loading" | "partial" | "complete"
  provider: Provider[]
  provider_default: Record<string, string>
  provider_connected: string[]
  agent: Agent[]
  command: Command[]
  permission: {
    [sessionID: string]: PermissionRequest[]
  }
  question: {
    [sessionID: string]: QuestionRequest[]
  }
  config: Config
  session: Session[]
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: Snapshot.FileDiff[]
  }
  todo: {
    [sessionID: string]: Todo[]
  }
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
  lsp: LspStatus[]
  mcp: {
    [key: string]: McpStatus
  }
  mcp_resource: {
    [key: string]: McpResource
  }
  formatter: FormatterStatus[]
  vcs: VcsInfo | undefined
  path: Path
}

type SyncState = {
  data: SyncStore
  set: ReturnType<typeof createStore<SyncStore>>[1]
  readonly status: SyncStore["status"]
  readonly ready: boolean
  session: {
    get(sessionID: string): Session | undefined
    status(sessionID: string): "idle" | "working" | "compacting"
    sync(sessionID: string): Promise<void>
  }
  bootstrap(): Promise<void> | undefined
}

let _state: SyncState

export function createSync() {
  const [store, setStore] = createStore<SyncStore>({
    config: {},
    status: "loading",
    agent: [],
    permission: {},
    question: {},
    command: [],
    provider: [],
    provider_default: {},
    provider_connected: [],
    session: [],
    session_status: {},
    session_diff: {},
    todo: {},
    message: {},
    part: {},
    lsp: [],
    mcp: {},
    mcp_resource: {},
    formatter: [],
    vcs: undefined,
    path: { home: "", state: "", config: "", worktree: "", directory: "" },
  })

  function upsertSorted<T extends Record<string, any>>(
    key: keyof typeof store & string,
    subKey: string,
    item: T,
    getId: (x: T) => string,
  ) {
    const list = (store as any)[key][subKey] as T[] | undefined
    if (!list) {
      setStore(key as any, subKey, [item])
      return
    }
    const result = Binary.search(list, getId(item), getId)
    if (result.found) {
      setStore(key as any, subKey, result.index, reconcile(item))
      return
    }
    setStore(
      key as any,
      subKey,
      produce((draft: T[]) => {
        draft.splice(result.index, 0, item)
      }),
    )
  }

  function removeSorted<T>(key: keyof typeof store & string, subKey: string, id: string, getId: (x: T) => string) {
    const list = (store as any)[key][subKey] as T[] | undefined
    if (!list) return
    const result = Binary.search(list, id, getId)
    if (!result.found) return
    setStore(
      key as any,
      subKey,
      produce((draft: T[]) => {
        draft.splice(result.index, 1)
      }),
    )
  }

  function upsertTopLevel<T>(key: keyof typeof store & string, item: T, getId: (x: T) => string) {
    const list = (store as any)[key] as T[]
    const result = Binary.search(list, getId(item), getId)
    if (result.found) {
      setStore(key as any, result.index, reconcile(item))
      return
    }
    setStore(
      key as any,
      produce((draft: T[]) => {
        draft.splice(result.index, 0, item)
      }),
    )
  }

  function removeTopLevel<T>(key: keyof typeof store & string, id: string, getId: (x: T) => string) {
    const list = (store as any)[key] as T[]
    const result = Binary.search(list, id, getId)
    if (!result.found) return
    setStore(
      key as any,
      produce((draft: T[]) => {
        draft.splice(result.index, 1)
      }),
    )
  }

  const getId = (x: any) => x.id as string

  const handlers: Record<string, (event: any) => void> = {
    "server.instance.disposed": () => bootstrap(),

    "permission.replied": (e) => removeSorted("permission", e.properties.sessionID, e.properties.requestID, getId),
    "permission.asked": (e) => upsertSorted("permission", e.properties.sessionID, e.properties, getId),

    "question.replied": (e) => removeSorted("question", e.properties.sessionID, e.properties.requestID, getId),
    "question.rejected": (e) => removeSorted("question", e.properties.sessionID, e.properties.requestID, getId),
    "question.asked": (e) => upsertSorted("question", e.properties.sessionID, e.properties, getId),

    "todo.updated": (e) => setStore("todo", e.properties.sessionID, e.properties.todos),
    "session.diff": (e) => setStore("session_diff", e.properties.sessionID, e.properties.diff),
    "session.status": (e) => setStore("session_status", e.properties.sessionID, e.properties.status),

    "session.deleted": (e) => removeTopLevel("session", e.properties.info.id, getId),
    "session.updated": (e) => upsertTopLevel("session", e.properties.info, getId),

    "message.updated": (e) => {
      const info = e.properties.info
      upsertSorted("message", info.sessionID, info, getId)
      const updated = store.message[info.sessionID]
      if (updated && updated.length > 100) {
        const oldest = updated[0]
        if (oldest) {
          batch(() => {
            setStore(
              "message",
              info.sessionID,
              produce((draft: any[]) => {
                draft.shift()
              }),
            )
            setStore(
              "part",
              produce((draft: any) => {
                delete draft[oldest.id]
              }),
            )
          })
        }
      }
    },
    "message.removed": (e) => removeSorted("message", e.properties.sessionID, e.properties.messageID, getId),

    "message.part.updated": (e) => upsertSorted("part", e.properties.part.messageID, e.properties.part, getId),
    "message.part.removed": (e) => removeSorted("part", e.properties.messageID, e.properties.partID, getId),

    "lsp.updated": () => {
      sdk.client.lsp.$get().then((res) => res.json()).then((data) => setStore("lsp", data as any))
    },
    "vcs.branch.updated": (e) => setStore("vcs", { branch: e.properties.branch }),
  }

  sdk.event.listen((e) => handlers[e.details.type]?.(e.details))

  const bootstrapState = {
    inFlight: undefined as Promise<void> | undefined,
    runID: 0,
    queued: false,
  }

  async function bootstrap() {
    if (bootstrapState.inFlight) {
      bootstrapState.queued = true
      return bootstrapState.inFlight
    }

    const runID = ++bootstrapState.runID
    const started = performance.now()
    const requestTiming = (stage: string, extra?: Record<string, unknown>) => {
      Log.Default.debug("startup", {
        stage,
        elapsed_ms: Math.round(performance.now() - started),
        ...extra,
      })
    }

    async function request<T>(label: string, fn: () => Promise<T>) {
      const requestStarted = performance.now()
      const value = await fn()
      requestTiming("sync.request.completed", {
        request: label,
        duration_ms: Math.round(performance.now() - requestStarted),
      })
      return value
    }

    setStore("status", "loading")
    requestTiming("sync.bootstrap.start")

    bootstrapState.inFlight = (async () => {
      try {
        const since = Date.now() - 30 * 24 * 60 * 60 * 1000

        const providersPromise = request("provider.list", () =>
          sdk.client.provider.$get(),
        )
          .then((res) => res.json())
          .then((listing: any) => {
            if (runID !== bootstrapState.runID) return
            batch(() => {
              setStore("provider", reconcile(listing.providers))
              setStore("provider_default", reconcile(listing.default))
              setStore("provider_connected", reconcile(listing.connected ?? []))
            })
          })

        const agentsPromise = request("app.agents", () => sdk.client.agent.$get())
          .then((res) => res.json())
          .then((agents: any) => {
            if (runID !== bootstrapState.runID) return
            setStore("agent", reconcile(agents ?? []))
          })

        const configPromise = request("config.get", () => sdk.client.config.$get())
          .then((res) => res.json())
          .then((config: any) => {
            if (runID !== bootstrapState.runID) return
            setStore("config", reconcile(config as Config))
          })

        const sessionListPromise = request("session.list", () =>
          sdk.client.session.$get({ query: { start: since } } as any),
        )
          .then((res) => res.json())
          .then((sessions: any) => ((sessions ?? []) as Session[]).toSorted((a, b) => a.id.localeCompare(b.id)))
          .then((sessions) => {
            if (runID !== bootstrapState.runID) return
            setStore("session", reconcile(sessions))
          })

        await Promise.all([providersPromise, agentsPromise, configPromise])

        if (runID !== bootstrapState.runID) return
        setStore("status", "partial")
        requestTiming("sync.partial")

        await Promise.all([
          sessionListPromise,
          request("command.list", () => sdk.client.command.$get()).then(async (res) => {
            if (runID !== bootstrapState.runID) return
            const data = await res.json()
            setStore("command", reconcile((data ?? []) as any))
          }),
          request("lsp.status", () => sdk.client.lsp.$get()).then(async (res) => {
            if (runID !== bootstrapState.runID) return
            const data = await res.json()
            setStore("lsp", reconcile(data as any))
          }),
          request("mcp.status", () => sdk.client.mcp.$get()).then(async (res) => {
            if (runID !== bootstrapState.runID) return
            const data = await res.json()
            setStore("mcp", reconcile(data as any))
          }),
          request("experimental.resource.list", () => sdk.client.experimental.resource.$get()).then(async (res) => {
            if (runID !== bootstrapState.runID) return
            const data = await res.json()
            setStore("mcp_resource", reconcile((data ?? {}) as any))
          }),
          request("formatter.status", () => sdk.client.formatter.$get()).then(async (res) => {
            if (runID !== bootstrapState.runID) return
            const data = await res.json()
            setStore("formatter", reconcile(data as any))
          }),
          request("session.status", () => sdk.client.session.status.$get()).then(async (res) => {
            if (runID !== bootstrapState.runID) return
            const data = await res.json()
            setStore("session_status", reconcile(data as any))
          }),
          request("vcs.get", () => sdk.client.vcs.$get()).then(async (res) => {
            if (runID !== bootstrapState.runID) return
            const data = await res.json()
            setStore("vcs", reconcile(data as any))
          }),
          request("path.get", () => sdk.client.path.$get()).then(async (res) => {
            if (runID !== bootstrapState.runID) return
            const data = await res.json()
            setStore("path", reconcile(data as any))
          }),
        ])

        if (runID !== bootstrapState.runID) return
        setStore("status", "complete")
        requestTiming("sync.complete")
      } catch (e) {
        Log.Default.error("tui bootstrap failed", {
          error: e instanceof Error ? e.message : String(e),
          name: e instanceof Error ? e.name : undefined,
          stack: e instanceof Error ? e.stack : undefined,
        })
        await exit(e)
      } finally {
        if (bootstrapState.inFlight) {
          bootstrapState.inFlight = undefined
        }
        if (bootstrapState.queued) {
          bootstrapState.queued = false
          void bootstrap()
        }
      }
    })()

    return bootstrapState.inFlight
  }

  onMount(() => {
    bootstrap()
  })

  const fullSyncedSessions = new Set<string>()
  _state = {
    data: store,
    set: setStore,
    get status() {
      return store.status
    },
    get ready() {
      return store.status !== "loading"
    },
    session: {
      get(sessionID: string) {
        const match = Binary.search(store.session, sessionID, (s) => s.id)
        if (match.found) return store.session[match.index]
        return undefined
      },
      status(sessionID: string) {
        const session = _state.session.get(sessionID)
        if (!session) return "idle"
        if (session.time.compacting) return "compacting"
        const messages = store.message[sessionID] ?? []
        const last = messages.at(-1)
        if (!last) return "idle"
        if (last.role === "user") return "working"
        return last.time.completed ? "idle" : "working"
      },
      async sync(sessionID: string) {
        if (fullSyncedSessions.has(sessionID)) return
        const [session, messages, todo, diff] = await Promise.all([
          sdk.client.session[":sessionID"].$get({ param: { sessionID } } as any).then((res: any) => res.json()),
          sdk.client.session[":sessionID"].message.$get({ param: { sessionID }, query: { limit: 100 } } as any).then((res: any) => res.json()),
          sdk.client.session[":sessionID"].todo.$get({ param: { sessionID } } as any).then((res: any) => res.json()),
          sdk.client.session[":sessionID"].diff.$get({ param: { sessionID } } as any).then((res: any) => res.json()),
        ])
        setStore(
          produce((draft) => {
            const match = Binary.search(draft.session, sessionID, (s) => s.id)
            if (match.found) draft.session[match.index] = session
            if (!match.found) draft.session.splice(match.index, 0, session)
            draft.todo[sessionID] = todo ?? []
            const serverMessages = (messages as any[]).map((x: any) => x.info) as Message[]
            const existing = draft.message[sessionID] ?? []
            const serverIds = new Set(serverMessages.map((m) => m.id))
            const kept = existing.filter((m) => !serverIds.has(m.id))
            draft.message[sessionID] = [...serverMessages, ...kept].sort((a, b) =>
              a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
            )
            for (const message of messages as any[]) {
              draft.part[message.info.id] = message.parts
            }
            draft.session_diff[sessionID] = diff ?? []
          }),
        )
        fullSyncedSessions.add(sessionID)
      },
    },
    bootstrap,
  }
}

export const sync: SyncState = new Proxy({} as SyncState, {
  get: (_, key) => (_state as any)[key],
})
