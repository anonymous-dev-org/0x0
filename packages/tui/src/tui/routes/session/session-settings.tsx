import { createSignal, type Accessor, type Setter } from "solid-js"
import { kv } from "@tui/state/kv"
import { createSimpleContext } from "../../context/helper"

export const { use: useSessionSettings, provider: SessionSettingsProvider } = createSimpleContext({
  name: "SessionSettings",
  init: () => {

    const [sidebar, setSidebar] = kv.signal<"auto" | "hide">("sidebar", "hide")
    const [sidebarOpen, setSidebarOpen] = createSignal(false)
    const [conceal, setConceal] = createSignal(true)
    const [showThinking, setShowThinking] = kv.signal("thinking_visibility", true)
    const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
    const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
    const [showAssistantMetadata, setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
    const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", false)
    const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
    const [animationsEnabled, setAnimationsEnabled] = kv.signal("animations_enabled", true)

    const showTimestamps = () => timestamps() === "show"

    return {
      sidebar,
      setSidebar,
      sidebarOpen,
      setSidebarOpen,
      conceal,
      setConceal,
      showThinking,
      setShowThinking,
      timestamps,
      setTimestamps,
      showDetails,
      setShowDetails,
      showAssistantMetadata,
      setShowAssistantMetadata,
      showScrollbar,
      setShowScrollbar,
      diffWrapMode,
      animationsEnabled,
      setAnimationsEnabled,
      showTimestamps,
    }
  },
})
