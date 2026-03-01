# @anonymous-dev/0x0-sdk

TypeScript SDK for embedding 0x0 programmatically. Spawn a server, connect a client, and interact with sessions from your own code.

## Prerequisites

- [0x0](https://github.com/anonymous-dev-org/0x0) CLI installed and on PATH (the SDK spawns it as a child process)
- `ANTHROPIC_API_KEY` environment variable set

## Installation

```bash
npm i @anonymous-dev/0x0-sdk
```

## Quick Start

```ts
import { createZeroxzero } from "@anonymous-dev/0x0-sdk"

// Starts a server on port 4096 and returns a connected client
const { client, server } = await createZeroxzero()

// Use the client to interact with sessions
const sessions = await client.session.list()

// Clean up
server.close()
```

## API

### `createZeroxzero(options?)`

Convenience function that starts a server and returns a connected client.

### `createZeroxzeroServer(options?)`

Starts a headless 0x0 server process.

```ts
import { createZeroxzeroServer } from "@anonymous-dev/0x0-sdk/server"

const server = await createZeroxzeroServer({
  hostname: "127.0.0.1",  // default
  port: 4096,             // default
  timeout: 5000,          // startup timeout in ms
  signal: controller.signal,
})

console.log(server.url) // http://127.0.0.1:4096
server.close()
```

### `createZeroxzeroClient(config?)`

Creates an HTTP client for an existing server.

```ts
import { createZeroxzeroClient } from "@anonymous-dev/0x0-sdk/client"

const client = createZeroxzeroClient({
  baseUrl: "http://127.0.0.1:4096",
  directory: "/path/to/project",  // optional, sets x-zeroxzero-directory header
})
```

### `createZeroxzeroTui(options?)`

Spawns the TUI in a child process with `stdio: "inherit"`.

```ts
import { createZeroxzeroTui } from "@anonymous-dev/0x0-sdk/server"

const tui = createZeroxzeroTui({
  project: "/path/to/project",
  model: "claude-sonnet-4-6",
  session: "session-id",
  agent: "builder",
})

tui.close()
```

## Exports

| Entry point | Description |
|-------------|-------------|
| `@anonymous-dev/0x0-sdk` | `createZeroxzero`, plus re-exports from client and server |
| `@anonymous-dev/0x0-sdk/client` | `createZeroxzeroClient`, generated types |
| `@anonymous-dev/0x0-sdk/server` | `createZeroxzeroServer`, `createZeroxzeroTui` |
| `@anonymous-dev/0x0-sdk/v2` | v2 API (client + server) |
| `@anonymous-dev/0x0-sdk/v2/client` | v2 client |
| `@anonymous-dev/0x0-sdk/v2/server` | v2 server |
