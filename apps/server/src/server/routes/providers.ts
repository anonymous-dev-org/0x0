import { Hono } from "hono"
import { Config } from "@/core/config/config"
import { ProviderRegistry } from "@/provider/registry"

export function ProviderRoutes() {
  return new Hono()
    .get("/", async (c) => {
      const available = await ProviderRegistry.available()
      const config = await Config.get().catch(() => undefined)
      return c.json({
        providers: available.map((p) => ({
          id: p.id,
          name: p.name,
          supported_options: p.supportedMessageOptions,
          input_schema: p.inputSchema,
          defaults: {
            model: config?.agent?.default_model,
            permission_mode: p.id === "claude" ? config?.agent?.permission_mode : undefined,
            sandbox: p.id === "codex" ? config?.agent?.sandbox : undefined,
          },
        })),
      })
    })
}
