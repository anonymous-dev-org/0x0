import { For, Match, Switch, type JSX } from "solid-js"
import type { AssistantMessage, UserMessage } from "@anonymous-dev/0x0-server/server/types"

type SessionMessage = AssistantMessage | UserMessage

export function SessionMessages(props: {
  messages: SessionMessage[]
  revertMessageID?: string
  renderRevertMarker: () => JSX.Element
  renderUser: (message: UserMessage, index: number) => JSX.Element
  renderAssistant: (message: AssistantMessage, index: number) => JSX.Element
}) {
  return (
    <For each={props.messages}>
      {(message, index) => (
        <Switch>
          <Match when={message.id === props.revertMessageID}>{props.renderRevertMarker()}</Match>
          <Match when={props.revertMessageID && message.id >= props.revertMessageID}>
            <></>
          </Match>
          <Match when={message.role === "user"}>{props.renderUser(message as UserMessage, index())}</Match>
          <Match when={message.role === "assistant"}>
            {props.renderAssistant(message as AssistantMessage, index())}
          </Match>
        </Switch>
      )}
    </For>
  )
}
