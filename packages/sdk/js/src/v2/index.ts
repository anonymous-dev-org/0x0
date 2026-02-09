export * from "./client.js"
export * from "./server.js"

import { createZeroxzeroClient } from "./client.js"
import { createZeroxzeroServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createZeroxzero(options?: ServerOptions) {
  const server = await createZeroxzeroServer({
    ...options,
  })

  const client = createZeroxzeroClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
