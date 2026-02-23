import { createMemo, createSignal } from "solid-js"
import { local } from "@tui/state/local"
import { sync } from "@tui/state/sync"
import { DialogSelect, type DialogSelectRef } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { DialogProvider } from "./dialog-provider"
import { keybind } from "@tui/state/keybind"
import * as fuzzysort from "fuzzysort"

export function useConnected() {
  return () => sync.data.provider_connected.length > 0
}

export function DialogModel(props: { providerID?: string }) {
  const dialog = useDialog()
  const [, setRef] = createSignal<DialogSelectRef<unknown>>()
  const [query, setQuery] = createSignal("")

  const connected = useConnected()

  type ModelValue = { providerID: string; modelID: string }

  function selectModel(value: ModelValue) {
    dialog.clear()
    local.model.set(value, { recent: true })
  }

  const options = createMemo(() => {
    const needle = query().trim()
    const isConnected = connected()
    const showSections = isConnected && !props.providerID && needle.length === 0
    const favorites = isConnected ? local.model.favorite() : []
    const recents = local.model.recent()
    const connectedSet = new Set(sync.data.provider_connected)

    const isFavorite = (v: ModelValue) =>
      favorites.some((f) => f.providerID === v.providerID && f.modelID === v.modelID)
    const isRecent = (v: ModelValue) =>
      recents.some((r) => r.providerID === v.providerID && r.modelID === v.modelID)

    // Build favorite options
    const favoriteOptions = !showSections
      ? []
      : favorites.flatMap((item) => {
          const provider = sync.data.provider.find((x) => x.id === item.providerID)
          const model = provider?.models[item.modelID]
          if (!provider || !model) return []
          const value = { providerID: provider.id, modelID: model.id }
          return [{ value, title: model.name ?? item.modelID, description: provider.name, category: "Favorites", onSelect: () => selectModel(value) }]
        })

    // Build recent options (excluding favorites)
    const recentOptions = !showSections
      ? []
      : recents
          .filter((item) => !isFavorite(item))
          .flatMap((item) => {
            const provider = sync.data.provider.find((x) => x.id === item.providerID)
            const model = provider?.models[item.modelID]
            if (!provider || !model) return []
            const value = { providerID: provider.id, modelID: model.id }
            return [{ value, title: model.name ?? item.modelID, description: provider.name, category: "Recent", onSelect: () => selectModel(value) }]
          })

    // Build all model options
    const modelOptions = sync.data.provider
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .flatMap((provider) =>
        Object.entries(provider.models)
          .filter(([, info]) => (props.providerID ? info.providerID === props.providerID : true))
          .filter(([modelID]) => {
            if (!showSections) return true
            const v = { providerID: provider.id, modelID }
            return !isFavorite(v) && !isRecent(v)
          })
          .map(([modelID, info]) => {
            const value = { providerID: provider.id, modelID }
            const providerConnected = connectedSet.has(provider.id)
            return {
              value,
              title: info.name ?? modelID,
              description: !providerConnected ? "(Not installed)" : isFavorite(value) ? "(Favorite)" : undefined,
              category: isConnected ? provider.name : undefined,
              onSelect: () => selectModel(value),
            }
          })
          .toSorted((a, b) => a.title.localeCompare(b.title)),
      )

    // Fuzzy search
    if (needle) {
      return fuzzysort.go(needle, modelOptions, { keys: ["title", "category"] }).map((x) => x.obj)
    }

    return [...favoriteOptions, ...recentOptions, ...modelOptions]
  })

  return (
    <DialogSelect
      keybind={[
        {
          keybind: keybind.all.model_provider_list?.[0],
          title: "Providers",
          onTrigger() {
            dialog.show({ title: "Providers", body: () => <DialogProvider /> })
          },
        },
        {
          keybind: keybind.all.model_favorite_toggle?.[0],
          title: "Favorite",
          disabled: !connected(),
          onTrigger: (option) => {
            local.model.toggleFavorite(option.value as ModelValue)
          },
        },
      ]}
      ref={setRef}
      onFilter={setQuery}
      skipFilter={true}
      current={local.model.current()}
      options={options()}
    />
  )
}
