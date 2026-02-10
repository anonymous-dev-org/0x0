import { useGlobalSync } from "@/context/global-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"

export const popularProviders = ["zeroxzero", "anthropic", "github-copilot", "openai", "google", "openrouter", "vercel"]

export function useProviders() {
  const globalSync = useGlobalSync()
  const params = useParams()
  const currentDirectory = () => decode64(params.dir) ?? ""
  const providers = () => {
    if (currentDirectory()) {
      const [projectStore] = globalSync.child(currentDirectory())
      return projectStore.provider
    }
    return globalSync.data.provider
  }
  const connected = () => providers().all.filter((p) => providers().connected.includes(p.id))
  const paid = () =>
    connected().filter((p) => p.id !== "zeroxzero" || Object.values(p.models).find((m) => m.cost?.input))
  const popular = () => providers().all.filter((p) => popularProviders.includes(p.id))
  return {
    all: () => providers().all,
    default: () => providers().default,
    popular,
    connected,
    paid,
  }
}
