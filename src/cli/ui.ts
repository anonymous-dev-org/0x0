import z from "zod"
import { EOL } from "os"
import { NamedError } from "@/util/error"

export namespace UI {
  export const CancelledError = NamedError.create("UICancelledError", z.void())

  export const Style = {
    TEXT_HIGHLIGHT: "\x1b[96m",
    TEXT_DIM: "\x1b[90m",
    TEXT_NORMAL: "\x1b[0m",
    TEXT_WARNING: "\x1b[93m",
    TEXT_DANGER: "\x1b[91m",
    TEXT_DANGER_BOLD: "\x1b[91m\x1b[1m",
    TEXT_SUCCESS: "\x1b[92m",
  }

  export function println(...message: string[]) {
    Bun.stderr.write(message.join(" ") + EOL)
  }

  export function logo() {
    const lines = [
      " ██████╗           ██████╗ ",
      "██╔═████╗         ██╔═████╗",
      "██║██╔██║ ╚██╗██╝ ██║██╔██║",
      "████╔╝██║   ███╝  ████╔╝██║",
      "╚██████╔╝  ██╝██╗ ╚██████╔╝",
      " ╚═════╝           ╚═════╝ ",
    ]
    return lines.join(EOL)
  }

  export function error(message: string) {
    println(Style.TEXT_DANGER_BOLD + "Error: " + Style.TEXT_NORMAL + message)
  }
}
