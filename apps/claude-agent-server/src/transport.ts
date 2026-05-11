// Newline-delimited JSON-RPC 2.0 framer over a Readable/Writable pair.
// No Content-Length headers — matches what acp_transport.lua expects.

import type { RpcMessage } from "./types"

type Listener = (msg: RpcMessage) => void

export class Transport {
  private buffer = ""
  private listeners: Listener[] = []
  private writeFn: (chunk: string) => void

  constructor(writeFn: (chunk: string) => void) {
    this.writeFn = writeFn
  }

  /** Feed raw stdin bytes (as a UTF-8 string). Splits on \n; partial trailing
   * line is held until the next call. */
  feed(chunk: string): void {
    this.buffer += chunk
    let nlIdx = this.buffer.indexOf("\n")
    while (nlIdx !== -1) {
      const line = this.buffer.slice(0, nlIdx).trim()
      this.buffer = this.buffer.slice(nlIdx + 1)
      if (line.length > 0) {
        this.dispatchLine(line)
      }
      nlIdx = this.buffer.indexOf("\n")
    }
  }

  /** Emit an outbound JSON-RPC message. */
  send(msg: RpcMessage): void {
    this.writeFn(JSON.stringify(msg) + "\n")
  }

  onMessage(fn: Listener): void {
    this.listeners.push(fn)
  }

  private dispatchLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // Malformed line: drop. We can't respond because we may not know the id.
      return
    }
    if (!isMessage(parsed)) {
      return
    }
    for (const l of this.listeners) {
      l(parsed)
    }
  }
}

function isMessage(v: unknown): v is RpcMessage {
  if (!v || typeof v !== "object") return false
  const m = v as Record<string, unknown>
  return m.jsonrpc === "2.0"
}
