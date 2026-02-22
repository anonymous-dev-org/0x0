import { onCleanup } from "solid-js"
import { useCommandDialog } from "../dialog-command"

type Mode = "normal" | "shell"

export function usePromptCommands(props: {
  command: ReturnType<typeof useCommandDialog>
  sessionID?: string
  status: () => { type: string }
  promptInput: () => string
  stashCount: () => number
  mode: () => Mode
  interrupt: () => number
  inputFocused: () => boolean
  autocompleteVisible: () => boolean
  setMode: (mode: Mode) => void
  setInterrupt: (value: number) => void
  abortSession: (sessionID: string) => void
  clear: () => void
  submit: () => void
  paste: () => Promise<void>
  edit: () => Promise<void>
  skills: () => void
  stashPush: () => void
  stashPop: () => void
  stashList: () => void
}) {
  let interruptTimeout: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    if (interruptTimeout) clearTimeout(interruptTimeout)
  })
  props.command.register(() => {
    return [
      {
        title: "Clear prompt",
        value: "prompt.clear",
        category: "Prompt",
        hidden: true,
        onSelect: (dialog) => {
          props.clear()
          dialog.clear()
        },
      },
      {
        title: "Submit prompt",
        value: "prompt.submit",
        keybind: "input_submit",
        category: "Prompt",
        hidden: true,
        onSelect: (dialog) => {
          if (!props.inputFocused()) return
          props.submit()
          dialog.clear()
        },
      },
      {
        title: "Paste",
        value: "prompt.paste",
        keybind: "input_paste",
        category: "Prompt",
        hidden: true,
        onSelect: async () => {
          await props.paste()
        },
      },
      {
        title: "Interrupt session",
        value: "session.interrupt",
        keybind: "session_interrupt",
        category: "Session",
        hidden: true,
        enabled: props.status().type !== "idle",
        onSelect: (dialog) => {
          if (props.autocompleteVisible()) return
          if (!props.inputFocused()) return
          if (props.mode() === "shell") {
            props.setMode("normal")
            return
          }
          if (!props.sessionID) return

          props.setInterrupt(props.interrupt() + 1)
          if (interruptTimeout) clearTimeout(interruptTimeout)
          interruptTimeout = setTimeout(() => {
            props.setInterrupt(0)
          }, 5000)

          if (props.interrupt() >= 2) {
            props.abortSession(props.sessionID)
            props.setInterrupt(0)
          }
          dialog.clear()
        },
      },
      {
        title: "Open editor",
        category: "Session",
        keybind: "editor_open",
        value: "prompt.editor",
        slash: {
          name: "editor",
        },
        onSelect: async (dialog) => {
          dialog.clear()
          await props.edit()
        },
      },
      {
        title: "Skills",
        value: "prompt.skills",
        category: "Prompt",
        slash: {
          name: "skills",
        },
        onSelect: () => {
          props.skills()
        },
      },
    ]
  })

  props.command.register(() => [
    {
      title: "Stash prompt",
      value: "prompt.stash",
      category: "Prompt",
      enabled: !!props.promptInput(),
      onSelect: (dialog) => {
        props.stashPush()
        dialog.clear()
      },
    },
    {
      title: "Stash pop",
      value: "prompt.stash.pop",
      category: "Prompt",
      enabled: props.stashCount() > 0,
      onSelect: (dialog) => {
        props.stashPop()
        dialog.clear()
      },
    },
    {
      title: "Stash list",
      value: "prompt.stash.list",
      category: "Prompt",
      enabled: props.stashCount() > 0,
      onSelect: () => {
        props.stashList()
      },
    },
  ])
}
