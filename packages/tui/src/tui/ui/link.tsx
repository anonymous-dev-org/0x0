import type { JSX } from "solid-js"
import type { RGBA } from "@opentui/core"
import open from "open"
import { useToast } from "./toast"

export interface LinkProps {
  href: string
  children?: JSX.Element | string
  fg?: RGBA
}

/**
 * Link component that renders clickable hyperlinks.
 * Clicking anywhere on the link text opens the URL in the default browser.
 */
export function Link(props: LinkProps) {
  const toast = useToast()
  return (
    <text
      fg={props.fg}
      onMouseUp={() => {
        open(props.href).catch(() => {
          toast.show({
            variant: "warning",
            message: `Could not open: ${props.href}`,
            duration: 3000,
          })
        })
      }}
    >
      {props.children ?? props.href}
    </text>
  )
}
