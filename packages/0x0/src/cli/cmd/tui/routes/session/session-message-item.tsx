import { Match, Switch, type JSX } from "solid-js"
import type { AssistantMessage, UserMessage } from "@0x0-ai/sdk/v2"

type SessionMessage = AssistantMessage | UserMessage

export function SessionMessageItem(props: {
  message: SessionMessage
  index: number
  revertMessageID?: string
  renderRevertMarker: () => JSX.Element
  renderUser: (message: UserMessage, index: number) => JSX.Element
  renderAssistant: (message: AssistantMessage) => JSX.Element
}) {
  return (
    <Switch>
      <Match when={props.message.id === props.revertMessageID}>{props.renderRevertMarker()}</Match>
      <Match when={props.revertMessageID && props.message.id >= props.revertMessageID}>
        <></>
      </Match>
      <Match when={props.message.role === "user"}>{props.renderUser(props.message as UserMessage, props.index)}</Match>
      <Match when={props.message.role === "assistant"}>
        {props.renderAssistant(props.message as AssistantMessage)}
      </Match>
    </Switch>
  )
}
