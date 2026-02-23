import { hcWithType, type Client } from "@/server/client"
import type { Event } from "@/bus/bus-event"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, onCleanup, onMount } from "solid-js"

export type EventSource = {
  on: (handler: (event: Event) => void) => () => void
}

type SDKState = {
  client: Client
  event: ReturnType<typeof createGlobalEmitter<{ [key in Event["type"]]: Extract<Event, { type: key }> }>>
  url: string
}

let _state: SDKState

export function createSDK(props: {
  url: string
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
  events?: EventSource
}) {
  const client = hcWithType(props.url, {
    fetch: props.fetch,
    headers: props.headers as Record<string, string> | undefined,
  })

  const emitter = createGlobalEmitter<{
    [key in Event["type"]]: Extract<Event, { type: key }>
  }>()

  let queue: Event[] = []
  let timer: Timer | undefined
  let last = 0

  const flush = () => {
    if (queue.length === 0) return
    const events = queue
    queue = []
    timer = undefined
    last = Date.now()
    // Batch all event emissions so all store updates result in a single render
    batch(() => {
      for (const event of events) {
        emitter.emit(event.type, event)
      }
    })
  }

  const handleEvent = (event: Event) => {
    queue.push(event)
    const elapsed = Date.now() - last

    if (timer) return
    // If we just flushed recently (within 16ms), batch this with future events
    // Otherwise, process immediately to avoid latency
    if (elapsed < 16) {
      timer = setTimeout(flush, 16)
      return
    }
    flush()
  }

  onMount(async () => {
    // Use the provided event source
    if (props.events) {
      const unsub = props.events.on(handleEvent)
      onCleanup(unsub)
      return
    }
  })

  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })

  _state = { client, event: emitter, url: props.url }
}

export const sdk: SDKState = new Proxy({} as SDKState, {
  get: (_, key) => (_state as any)[key],
})
