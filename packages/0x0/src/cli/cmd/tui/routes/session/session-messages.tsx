import { For, Match, Show, Switch, type JSX } from "solid-js"
import type { AssistantMessage, UserMessage } from "@0x0-ai/sdk/v2"

type SessionMessage = AssistantMessage | UserMessage

export function SessionMessages(props: {
  messages: SessionMessage[]
  revertMessageID?: string
  fallback: JSX.Element
  renderRevertMarker: () => JSX.Element
  renderUser: (message: UserMessage, index: number) => JSX.Element
  renderAssistant: (message: AssistantMessage, index: number) => JSX.Element
}) {
  return (
    <Show when={props.messages.length > 0} fallback={props.fallback}>
      <For each={props.messages}>
        {(message, index) => {
          const i = index()
          return (
            <Switch>
              <Match when={message.id === props.revertMessageID}>{props.renderRevertMarker()}</Match>
              <Match when={props.revertMessageID && message.id >= props.revertMessageID}>
                <></>
              </Match>
              <Match when={message.role === "user"}>{props.renderUser(message as UserMessage, i)}</Match>
              <Match when={message.role === "assistant"}>{props.renderAssistant(message as AssistantMessage, i)}</Match>
            </Switch>
          )
        }}
      </For>
    </Show>
  )
}
