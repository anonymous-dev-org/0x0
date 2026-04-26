import type { ChatStreamEvent } from "@anonymous-dev/0x0-contracts"

export function createSseResponse(events: AsyncIterable<ChatStreamEvent>) {
  const iterator = events[Symbol.asyncIterator]()
  const encoder = new TextEncoder()

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next()
        if (next.done) {
          controller.close()
          return
        }

        controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`),
        )
        controller.close()
      }
    },
    async cancel() {
      if (typeof iterator.return === "function") {
        await iterator.return()
      }
    },
  })

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}
