import { Component, For, Match, Show, Switch } from "solid-js"
import { FileIcon } from "@0x0-ai/ui/file-icon"
import { Icon } from "@0x0-ai/ui/icon"
import { getDirectory, getFilename } from "@0x0-ai/util/path"

export type AtOption =
  | {
      type: "agent"
      name: string
      display: string
      label: string
      description?: string
    }
  | {
      type: "model"
      providerID: string
      modelID: string
      display: string
      label: string
      description?: string
    }
  | {
      type: "thinking"
      value: string | undefined
      display: string
      label: string
      description?: string
    }

export interface SlashCommand {
  id: string
  trigger: string
  title: string
  description?: string
  keybind?: string
  type: "builtin" | "custom"
  source?: "command" | "mcp" | "skill"
}

export type SlashOption =
  | SlashCommand
  | {
      id: string
      type: "file"
      path: string
      display: string
      recent?: boolean
    }

type PromptPopoverProps = {
  popover: "at" | "slash" | null
  setSlashPopoverRef: (el: HTMLDivElement) => void
  atFlat: AtOption[]
  atActive?: string
  atKey: (item: AtOption) => string
  setAtActive: (id: string) => void
  onAtSelect: (item: AtOption) => void
  slashFlat: SlashOption[]
  slashActive?: string
  setSlashActive: (id: string) => void
  onSlashSelect: (item: SlashOption) => void
  commandKeybind: (id: string) => string | undefined
  t: (key: string) => string
}

export const PromptPopover: Component<PromptPopoverProps> = (props) => {
  const atIcon = (item: AtOption) => {
    if (item.type === "model") return "models"
    if (item.type === "thinking") return "brain"
    return "mcp"
  }

  return (
    <Show when={props.popover}>
      <div
        ref={(el) => {
          if (props.popover === "slash") props.setSlashPopoverRef(el)
        }}
        class="absolute inset-x-0 -top-3 -translate-y-full origin-bottom-left max-h-80 min-h-10
                 overflow-auto no-scrollbar flex flex-col p-2 rounded-md
                 border border-border-base bg-surface-raised-stronger-non-alpha shadow-md"
        onMouseDown={(e) => e.preventDefault()}
      >
        <Switch>
          <Match when={props.popover === "at"}>
            <Show
              when={props.atFlat.length > 0}
              fallback={<div class="text-text-weak px-2 py-1">{props.t("prompt.popover.emptyResults")}</div>}
            >
              <For each={props.atFlat.slice(0, 10)}>
                {(item) => (
                  <button
                    classList={{
                      "w-full flex items-center gap-x-2 rounded-md px-2 py-0.5": true,
                      "bg-surface-raised-base-hover": props.atActive === props.atKey(item),
                    }}
                    onClick={() => props.onAtSelect(item)}
                    onMouseEnter={() => props.setAtActive(props.atKey(item))}
                  >
                    <Icon name={atIcon(item)} size="small" class="text-icon-info-active shrink-0" />
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="text-14-regular text-text-strong whitespace-nowrap">{item.label}</span>
                      <Show when={item.description}>
                        <span class="text-14-regular text-text-weak truncate">{item.description}</span>
                      </Show>
                    </div>
                  </button>
                )}
              </For>
            </Show>
          </Match>
          <Match when={props.popover === "slash"}>
            <Show
              when={props.slashFlat.length > 0}
              fallback={<div class="text-text-weak px-2 py-1">{props.t("prompt.popover.emptyCommands")}</div>}
            >
              <For each={props.slashFlat}>
                {(cmd) => (
                  <button
                    data-slash-id={cmd.id}
                    classList={{
                      "w-full flex items-center justify-between gap-4 rounded-md px-2 py-1": true,
                      "bg-surface-raised-base-hover": props.slashActive === cmd.id,
                    }}
                    onClick={() => props.onSlashSelect(cmd)}
                    onMouseEnter={() => props.setSlashActive(cmd.id)}
                  >
                    <Show
                      when={cmd.type === "file"}
                      fallback={
                        <>
                          <div class="flex items-center gap-2 min-w-0">
                            <span class="text-14-regular text-text-strong whitespace-nowrap">
                              /{cmd.type !== "file" ? cmd.trigger : ""}
                            </span>
                            <Show when={cmd.type !== "file" && cmd.description}>
                              <span class="text-14-regular text-text-weak truncate">
                                {cmd.type !== "file" ? cmd.description : ""}
                              </span>
                            </Show>
                          </div>
                          <div class="flex items-center gap-2 shrink-0">
                            <Show when={cmd.type !== "file" && cmd.type === "custom" && cmd.source !== "command"}>
                              <span class="text-11-regular text-text-subtle px-1.5 py-0.5 bg-surface-base rounded">
                                {cmd.type !== "file" && cmd.source === "skill"
                                  ? props.t("prompt.slash.badge.skill")
                                  : cmd.type !== "file" && cmd.source === "mcp"
                                    ? props.t("prompt.slash.badge.mcp")
                                    : props.t("prompt.slash.badge.custom")}
                              </span>
                            </Show>
                            <Show when={cmd.type !== "file" && props.commandKeybind(cmd.id)}>
                              <span class="text-12-regular text-text-subtle">
                                {cmd.type !== "file" ? props.commandKeybind(cmd.id) : ""}
                              </span>
                            </Show>
                          </div>
                        </>
                      }
                    >
                      <FileIcon
                        node={{ path: cmd.type === "file" ? cmd.path : "", type: "file" }}
                        class="shrink-0 size-4"
                      />
                      <div class="flex items-center text-14-regular min-w-0">
                        <span class="text-text-weak whitespace-nowrap truncate min-w-0">
                          {cmd.type === "file" ? (cmd.path.endsWith("/") ? cmd.path : getDirectory(cmd.path)) : ""}
                        </span>
                        <Show when={cmd.type === "file" && !cmd.path.endsWith("/")}>
                          <span class="text-text-strong whitespace-nowrap">
                            {cmd.type === "file" ? getFilename(cmd.path) : ""}
                          </span>
                        </Show>
                      </div>
                      <Show when={cmd.type === "file" && cmd.recent}>
                        <span class="ml-auto text-11-regular text-text-subtle px-1.5 py-0.5 bg-surface-base rounded">
                          recent
                        </span>
                      </Show>
                    </Show>
                  </button>
                )}
              </For>
            </Show>
          </Match>
        </Switch>
      </div>
    </Show>
  )
}
