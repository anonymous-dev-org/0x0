import { describe, expect, it } from "bun:test"
import { Transport } from "../src/transport"
import type { RpcMessage } from "../src/types"

describe("Transport", () => {
  it("round-trips a complete request line", () => {
    const received: RpcMessage[] = []
    const t = new Transport(() => {})
    t.onMessage(m => received.push(m))
    t.feed('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n')
    expect(received).toHaveLength(1)
    const msg = received[0] as { method: string; id: number }
    expect(msg.method).toBe("initialize")
    expect(msg.id).toBe(1)
  })

  it("buffers partial lines across feed() calls", () => {
    const received: RpcMessage[] = []
    const t = new Transport(() => {})
    t.onMessage(m => received.push(m))
    t.feed('{"jsonrpc":"2.0","id":1,')
    expect(received).toHaveLength(0)
    t.feed('"method":"initialize"}\n')
    expect(received).toHaveLength(1)
  })

  it("handles two messages in one chunk", () => {
    const received: RpcMessage[] = []
    const t = new Transport(() => {})
    t.onMessage(m => received.push(m))
    t.feed(
      '{"jsonrpc":"2.0","id":1,"method":"a"}\n' + '{"jsonrpc":"2.0","method":"b/notification"}\n'
    )
    expect(received).toHaveLength(2)
  })

  it("drops malformed JSON lines silently", () => {
    const received: RpcMessage[] = []
    const t = new Transport(() => {})
    t.onMessage(m => received.push(m))
    t.feed("not valid json\n")
    t.feed('{"jsonrpc":"2.0","id":1,"method":"ok"}\n')
    expect(received).toHaveLength(1)
  })

  it("ignores objects without jsonrpc:'2.0'", () => {
    const received: RpcMessage[] = []
    const t = new Transport(() => {})
    t.onMessage(m => received.push(m))
    t.feed('{"id":1,"method":"oops"}\n')
    expect(received).toHaveLength(0)
  })

  it("writes outbound messages with a trailing newline", () => {
    const chunks: string[] = []
    const t = new Transport(c => chunks.push(c))
    t.send({ jsonrpc: "2.0", id: 1, result: { ok: true } })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].endsWith("\n")).toBe(true)
    const parsed = JSON.parse(chunks[0].trim())
    expect(parsed.id).toBe(1)
  })
})
