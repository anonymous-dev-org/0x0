import { useRenderer } from "@opentui/solid"
import { FormatError, FormatUnknownError } from "@/cli/error"

type Exit = ((reason?: unknown) => Promise<void>) & {
  message: {
    set: (value?: string) => () => void
    clear: () => void
    get: () => string | undefined
  }
}

let _state: Exit

export function createExit(input: { onExit?: () => Promise<void> }) {
  const renderer = useRenderer()
  let message: string | undefined
  const store = {
    set: (value?: string) => {
      const prev = message
      message = value
      return () => {
        message = prev
      }
    },
    clear: () => {
      message = undefined
    },
    get: () => message,
  }
  _state = Object.assign(
    async (reason?: unknown) => {
      // Reset window title before destroying renderer
      renderer.setTerminalTitle("")
      renderer.destroy()
      await input.onExit?.()
      if (reason) {
        const formatted = FormatError(reason) ?? FormatUnknownError(reason)
        if (formatted) {
          process.stderr.write(formatted + "\n")
        }
      }
      const text = store.get()
      if (text) process.stdout.write(text + "\n")
      process.exit(0)
    },
    {
      message: store,
    },
  )
}

export const exit: Exit = new Proxy((() => {}) as unknown as Exit, {
  get: (_, key) => (_state as any)[key],
  apply: (_target, _thisArg, argArray) => (_state as any)(...argArray),
})
