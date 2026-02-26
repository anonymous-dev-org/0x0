import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { Provider } from "../../provider/provider"
import { mapValues } from "remeda"
import { lazy } from "../../util/lazy"

export async function getProviderListing() {
  const allProviders = Provider.all()
  const connected = await Provider.list()
  return {
    providers: Object.values(allProviders),
    default: mapValues(connected, (item) => Provider.sort(Object.values(item.models))[0]?.id ?? ""),
    connected: Object.keys(connected),
  }
}

export const ProviderListingSchema = z.object({
  providers: Provider.Info.array(),
  default: z.record(z.string(), z.string()),
  connected: z.array(z.string()),
})

export const ProviderRoutes = lazy(() =>
  new Hono().get(
    "/",
    describeRoute({
      summary: "List providers",
      description: "Get all providers with their connection status.",
      operationId: "provider.list",
      responses: {
        200: {
          description: "List of providers",
          content: {
            "application/json": {
              schema: resolver(ProviderListingSchema),
            },
          },
        },
      },
    }),
    async (c) => c.json(await getProviderListing()),
  ),
)
