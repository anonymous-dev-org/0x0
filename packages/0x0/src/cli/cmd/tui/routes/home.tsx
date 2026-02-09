import { Prompt, type PromptRef } from "@tui/component/prompt"
import { createSignal, onMount, Show } from "solid-js"
import { Logo } from "../component/logo"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useRouteData } from "@tui/context/route"
import { usePromptRef } from "../context/prompt"

// TODO: what is the best way to do this?
let once = false

export function Home() {
  const route = useRouteData("home")
  const promptRef = usePromptRef()

  let prompt: PromptRef
  const args = useArgs()
  onMount(() => {
    if (once) return
    if (route.initialPrompt) {
      prompt.set(route.initialPrompt)
      once = true
    } else if (args.prompt) {
      prompt.set({ input: args.prompt, parts: [] })
      once = true
      prompt.submit()
    }
  })

  return (
    <box flexGrow={1} paddingBottom={1} paddingTop={1} paddingLeft={2} paddingRight={2} gap={1}>
      <box flexGrow={1} justifyContent="center" alignItems="center"></box>
      <box flexShrink={0}>
        <box width="100%" zIndex={1000}>
          <Prompt
            ref={(r) => {
              prompt = r
              promptRef.set(r)
            }}
          />
        </box>
      </box>
      <Toast />
    </box>
  )
}
