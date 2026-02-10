import { For, Show, type JSX } from "solid-js"
import type { AssistantMessage, UserMessage } from "@0x0-ai/sdk/v2"
import { SessionMessageItem } from "./session-message-item"

type SessionMessage = AssistantMessage | UserMessage

export function SessionMessages(props: {
  messages: SessionMessage[]
  revertMessageID?: string
  fallback: JSX.Element
  renderRevertMarker: () => JSX.Element
  renderUser: (message: UserMessage, index: number) => JSX.Element
  renderAssistant: (message: AssistantMessage) => JSX.Element
}) {
  return (
    <Show when={props.messages.length > 0} fallback={props.fallback}>
      <For each={props.messages}>
        {(message, index) => (
          <SessionMessageItem
            message={message}
            index={index()}
            revertMessageID={props.revertMessageID}
            renderRevertMarker={props.renderRevertMarker}
            renderUser={props.renderUser}
            renderAssistant={props.renderAssistant}
          />
        )}
      </For>
    </Show>
  )
}
