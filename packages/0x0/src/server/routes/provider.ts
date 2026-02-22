import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { Provider } from "../../provider/provider"
import { ModelsDev } from "../../provider/models"
import { mapValues } from "remeda"
import { lazy } from "../../util/lazy"

export const ProviderRoutes = lazy(() =>
  new Hono().get(
    "/",
    describeRoute({
      summary: "List providers",
      description: "Get a list of all available AI providers, including both available and connected ones.",
      operationId: "provider.list",
      responses: {
        200: {
          description: "List of providers",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  all: ModelsDev.Provider.array(),
                  default: z.record(z.string(), z.string()),
                  connected: z.array(z.string()),
                }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      const allProviders = Provider.all()
      const connected = await Provider.list()
      return c.json({
        all: Object.values(allProviders),
        default: mapValues(connected, (item) => Provider.sort(Object.values(item.models))[0]?.id ?? ""),
        connected: Object.keys(connected),
      })
    },
  ),
)
