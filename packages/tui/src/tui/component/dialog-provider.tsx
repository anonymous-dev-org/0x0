import { sync } from "@tui/state/sync"
import { theme } from "@tui/state/theme"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { createMemo } from "solid-js"
import { Log } from "@anonymous-dev/0x0-server/util/log"
import { Link } from "../ui/link"
import { DialogModel } from "./dialog-model"

const INSTALL_INFO: Record<string, { cmd: string; url: string }> = {
  "claude-code": {
    cmd: "npm install -g @anthropic-ai/claude-code",
    url: "https://docs.anthropic.com/claude-code",
  },
  codex: {
    cmd: "npm install -g @openai/codex",
    url: "https://github.com/openai/codex",
  },
}

export function createDialogProviderOptions() {
  const dialog = useDialog()
  Log.Default.info("1", sync.data.provider)
  Log.Default.info("2", sync.data.provider_connected)
  const options = createMemo(() => {
    const connected = new Set(sync.data.provider_connected)
    return sync.data.provider.map(provider => {
      const isConnected = connected.has(provider.id)
      return {
        title: provider.name,
        value: provider.id,
        footer: isConnected ? "Installed" : "Not installed",
        async onSelect() {
          if (isConnected) {
            dialog.show({
              title: "Select model",
              body: () => <DialogModel providerID={provider.id} />,
            })
          } else {
            dialog.show({
              title: `Install ${provider.name}`,
              body: () => <InstallGuide providerID={provider.id} />,
            })
          }
        },
      }
    })
  })
  return options
}

export function DialogProvider() {
  const options = createDialogProviderOptions()
  console.log("3", options())
  return <DialogSelect options={options()} />
}

function InstallGuide(props: { providerID: string }) {
  const info = INSTALL_INFO[props.providerID]

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <text fg={theme.text}>Run the following command to install, then restart 0x0:</text>
      <text fg={theme.primary}>{info?.cmd ?? `Install ${props.providerID}`}</text>
      {info?.url && <Link href={info.url} fg={theme.textMuted} />}
    </box>
  )
}
