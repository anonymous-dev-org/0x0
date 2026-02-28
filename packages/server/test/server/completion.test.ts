import { describe, expect, test, mock, beforeEach } from "bun:test"
import type { CompletionEvent } from "../../src/provider/sdk/claude-code"

// ─── Mock completionStream ──────────────────────────────────────────────────

type StreamCall = {
  model: string
  prompt: string
  systemPrompt?: string
  stopSequences?: string[]
}
const streamCalls: StreamCall[] = []
let mockEvents: CompletionEvent[] = []

mock.module("../../src/provider/sdk/claude-code", () => ({
  completionStream: async function* (input: StreamCall) {
    streamCalls.push(input)
    for (const event of mockEvents) {
      yield event
    }
  },
  // Other exports consumed elsewhere in the server — stub them out so imports resolve
  claudeStream: async function* () {},
}))

// Import after mocking
const { Server } = await import("../../src/server/server")
const { Instance } = await import("../../src/project/instance")
const { tmpdir } = await import("../fixture/fixture")
const { Log } = await import("../../src/util/log")

Log.init({ print: false })

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse SSE text into an array of data payloads */
function parseSSE(text: string): unknown[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice("data:".length).trim()))
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("completion routes", () => {
  beforeEach(() => {
    streamCalls.length = 0
    mockEvents = []
  })

  test("POST /completion sends prefix+suffix context and streams deltas", async () => {
    await using tmp = await tmpdir()

    mockEvents = [
      { type: "delta", text: "console.log" },
      { type: "delta", text: '("hello")' },
      { type: "done" },
    ]

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/completion", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prefix: "function greet() {\n  ",
            suffix: "\n}",
            language: "typescript",
            filename: "src/greet.ts",
          }),
        })

        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain("text/event-stream")

        const body = await response.text()
        const events = parseSSE(body) as CompletionEvent[]

        // Verify we received all three events
        expect(events).toEqual([
          { type: "delta", text: "console.log" },
          { type: "delta", text: '("hello")' },
          { type: "done" },
        ])

        // Verify the context was correctly constructed in the prompt
        expect(streamCalls).toHaveLength(1)
        const call = streamCalls[0]
        expect(call.prompt).toContain("<code_before_cursor>")
        expect(call.prompt).toContain("function greet() {\n  ")
        expect(call.prompt).toContain("</code_before_cursor>")
        expect(call.prompt).toContain("<code_after_cursor>")
        expect(call.prompt).toContain("\n}")
        expect(call.prompt).toContain("</code_after_cursor>")
        expect(call.prompt).toContain("Language: typescript")
        expect(call.prompt).toContain("File: src/greet.ts")

        // Verify system prompt and stop sequences
        expect(call.systemPrompt).toContain("code completion engine")
        expect(call.stopSequences).toEqual(["\n\n\n"])
      },
    })
  })

  test("POST /completion uses default model when none specified", async () => {
    await using tmp = await tmpdir()

    mockEvents = [{ type: "done" }]

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        await app.request("/completion", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prefix: "x",
            suffix: "",
          }),
        })

        expect(streamCalls).toHaveLength(1)
        expect(streamCalls[0].model).toBe("claude-haiku-4-5-20251001")
      },
    })
  })

  test("POST /completion uses custom model when specified", async () => {
    await using tmp = await tmpdir()

    mockEvents = [{ type: "done" }]

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        await app.request("/completion", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prefix: "x",
            suffix: "",
            model: "claude-sonnet-4-6",
          }),
        })

        expect(streamCalls).toHaveLength(1)
        expect(streamCalls[0].model).toBe("claude-sonnet-4-6")
      },
    })
  })

  test("POST /completion defaults language to 'text' and filename to 'untitled'", async () => {
    await using tmp = await tmpdir()

    mockEvents = [{ type: "done" }]

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        await app.request("/completion", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prefix: "hello",
            suffix: " world",
          }),
        })

        expect(streamCalls).toHaveLength(1)
        expect(streamCalls[0].prompt).toContain("Language: text")
        expect(streamCalls[0].prompt).toContain("File: untitled")
      },
    })
  })

  test("POST /completion returns 400 for missing prefix", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/completion", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ suffix: "}" }),
        })

        expect(response.status).toBe(400)
        expect(streamCalls).toHaveLength(0)
      },
    })
  })

  test("POST /completion/text streams text generation", async () => {
    await using tmp = await tmpdir()

    mockEvents = [
      { type: "delta", text: "The answer is " },
      { type: "delta", text: "42." },
      { type: "done" },
    ]

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/completion/text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "What is the meaning of life?",
            system: "You are a philosopher.",
          }),
        })

        expect(response.status).toBe(200)

        const body = await response.text()
        const events = parseSSE(body) as CompletionEvent[]

        expect(events).toEqual([
          { type: "delta", text: "The answer is " },
          { type: "delta", text: "42." },
          { type: "done" },
        ])

        expect(streamCalls).toHaveLength(1)
        const call = streamCalls[0]
        expect(call.prompt).toBe("What is the meaning of life?")
        expect(call.systemPrompt).toBe("You are a philosopher.")
        expect(call.model).toBe("claude-haiku-4-5-20251001")
        // text endpoint does NOT set stopSequences
        expect(call.stopSequences).toBeUndefined()
      },
    })
  })

  // ─── Realistic code examples ──────────────────────────────────────────────

  test("completes a TypeScript async function body mid-edit", async () => {
    await using tmp = await tmpdir()

    const prefix = `import { readFile } from "fs/promises"

interface Config {
  port: number
  host: string
  debug: boolean
}

export async function loadConfig(path: string): Promise<Config> {
  const raw = await readFile(path, "utf-8")
  `
    const suffix = `
  if (!parsed.port) throw new Error("missing port")
  return parsed as Config
}`

    mockEvents = [
      { type: "delta", text: "const parsed = JSON.parse(raw)" },
      { type: "done" },
    ]

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/completion", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prefix,
            suffix,
            language: "typescript",
            filename: "src/config/loader.ts",
          }),
        })

        expect(response.status).toBe(200)

        const body = await response.text()
        const events = parseSSE(body) as CompletionEvent[]

        // Mock returned our expected completion
        expect(events).toEqual([
          { type: "delta", text: "const parsed = JSON.parse(raw)" },
          { type: "done" },
        ])

        // Verify full prompt structure
        const call = streamCalls[0]
        expect(call.prompt).toContain("Language: typescript")
        expect(call.prompt).toContain("File: src/config/loader.ts")
        // prefix is inside <code_before_cursor>
        expect(call.prompt).toContain('const raw = await readFile(path, "utf-8")')
        // suffix is inside <code_after_cursor>
        expect(call.prompt).toContain('if (!parsed.port) throw new Error("missing port")')
      },
    })
  })

  test("completes a Python class method", async () => {
    await using tmp = await tmpdir()

    const prefix = `class UserRepository:
    def __init__(self, db: Database):
        self.db = db

    async def find_by_email(self, email: str) -> User | None:
        `
    const suffix = `

    async def create(self, user: User) -> User:
        return await self.db.insert("users", user.dict())`

    mockEvents = [
      { type: "delta", text: 'result = await self.db.query_one("SELECT * FROM users WHERE email = $1", email)' },
      { type: "delta", text: "\n        " },
      { type: "delta", text: "return User(**result) if result else None" },
      { type: "done" },
    ]

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/completion", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prefix,
            suffix,
            language: "python",
            filename: "app/repositories/user.py",
          }),
        })

        expect(response.status).toBe(200)

        const body = await response.text()
        const events = parseSSE(body) as CompletionEvent[]

        expect(events).toHaveLength(4) // 3 deltas + done
        expect(events[events.length - 1]).toEqual({ type: "done" })

        // Collect all delta text
        const completed = events
          .filter((e): e is { type: "delta"; text: string } => (e as any).type === "delta")
          .map((e) => e.text)
          .join("")
        expect(completed).toContain("SELECT * FROM users WHERE email")
        expect(completed).toContain("return User(**result) if result else None")

        const call = streamCalls[0]
        expect(call.prompt).toContain("Language: python")
        expect(call.prompt).toContain("File: app/repositories/user.py")
        expect(call.prompt).toContain("async def find_by_email")
        expect(call.prompt).toContain("async def create")
      },
    })
  })

  test("completes a Rust match arm with multi-chunk streaming", async () => {
    await using tmp = await tmpdir()

    const prefix = `use std::io::{self, Read};

enum Command {
    Get { key: String },
    Set { key: String, value: String },
    Delete { key: String },
}

fn execute(cmd: Command) -> Result<String, io::Error> {
    match cmd {
        Command::Get { key } => {
            `
    const suffix = `
        }
        Command::Set { key, value } => {
            store.insert(key, value);
            Ok("OK".to_string())
        }
        Command::Delete { key } => {
            store.remove(&key);
            Ok("OK".to_string())
        }
    }
}`

    // Simulate realistic multi-chunk streaming
    mockEvents = [
      { type: "delta", text: "let value = store" },
      { type: "delta", text: ".get(&key)" },
      { type: "delta", text: "\n                .ok_or_else(|| " },
      { type: "delta", text: 'io::Error::new(io::ErrorKind::NotFound, "key not found"))?' },
      { type: "delta", text: ";\n            " },
      { type: "delta", text: "Ok(value.clone())" },
      { type: "done" },
    ]

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/completion", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prefix,
            suffix,
            language: "rust",
            filename: "src/store/handler.rs",
          }),
        })

        expect(response.status).toBe(200)

        const body = await response.text()
        const events = parseSSE(body) as CompletionEvent[]

        // 6 deltas + 1 done
        expect(events).toHaveLength(7)

        const deltas = events.filter((e): e is { type: "delta"; text: string } => (e as any).type === "delta")
        expect(deltas).toHaveLength(6)

        const completed = deltas.map((e) => e.text).join("")
        expect(completed).toContain("store.get(&key)")
        expect(completed).toContain("Ok(value.clone())")

        const call = streamCalls[0]
        expect(call.prompt).toContain("Language: rust")
        expect(call.prompt).toContain("File: src/store/handler.rs")
        // Both prefix and suffix context is in the prompt
        expect(call.prompt).toContain("Command::Get { key } =>")
        expect(call.prompt).toContain("Command::Set { key, value } =>")
        expect(call.prompt).toContain("Command::Delete { key } =>")
      },
    })
  })

  test("completes Go error handling at end of function", async () => {
    await using tmp = await tmpdir()

    const prefix = `package api

import (
	"encoding/json"
	"net/http"
)

func (s *Server) HandleCreateUser(w http.ResponseWriter, r *http.Request) {
	var req CreateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		`
    const suffix = `
	}

	user, err := s.userService.Create(r.Context(), req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(user)
}`

    mockEvents = [
      { type: "delta", text: "http.Error(w, " },
      { type: "delta", text: '"bad request: "+err.Error(), ' },
      { type: "delta", text: "http.StatusBadRequest)\n\t\treturn" },
      { type: "done" },
    ]

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/completion", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prefix,
            suffix,
            language: "go",
            filename: "internal/api/handler.go",
          }),
        })

        expect(response.status).toBe(200)

        const body = await response.text()
        const events = parseSSE(body) as CompletionEvent[]

        expect(events).toHaveLength(4) // 3 deltas + done
        const completed = events
          .filter((e): e is { type: "delta"; text: string } => (e as any).type === "delta")
          .map((e) => e.text)
          .join("")
        expect(completed).toContain("http.Error(w,")
        expect(completed).toContain("http.StatusBadRequest)")
        expect(completed).toContain("return")

        const call = streamCalls[0]
        expect(call.prompt).toContain("Language: go")
        expect(call.prompt).toContain("File: internal/api/handler.go")
        expect(call.prompt).toContain("json.NewDecoder(r.Body).Decode(&req)")
        expect(call.prompt).toContain("s.userService.Create(r.Context(), req)")
      },
    })
  })

  test("all code examples round-trip correctly (summary)", async () => {
    const scenarios = [
      {
        name: "TypeScript: async config loader",
        input: {
          prefix: 'import { readFile } from "fs/promises"\n\nexport async function loadConfig(path: string): Promise<Config> {\n  const raw = await readFile(path, "utf-8")\n  ',
          suffix: '\n  if (!parsed.port) throw new Error("missing port")\n  return parsed as Config\n}',
          language: "typescript",
          filename: "src/config/loader.ts",
        },
        events: [
          { type: "delta" as const, text: "const parsed = JSON.parse(raw)" },
          { type: "done" as const },
        ],
      },
      {
        name: "Python: repository query",
        input: {
          prefix: "class UserRepository:\n    async def find_by_email(self, email: str):\n        ",
          suffix: '\n\n    async def create(self, user):\n        return await self.db.insert("users", user.dict())',
          language: "python",
          filename: "app/repositories/user.py",
        },
        events: [
          { type: "delta" as const, text: 'result = await self.db.query("SELECT * FROM users WHERE email = $1", email)' },
          { type: "delta" as const, text: "\n        return User(**result) if result else None" },
          { type: "done" as const },
        ],
      },
      {
        name: "Rust: match arm",
        input: {
          prefix: "fn execute(cmd: Command) -> Result<String, io::Error> {\n    match cmd {\n        Command::Get { key } => {\n            ",
          suffix: '\n        }\n        Command::Set { key, value } => {\n            Ok("OK".to_string())\n        }\n    }\n}',
          language: "rust",
          filename: "src/store/handler.rs",
        },
        events: [
          { type: "delta" as const, text: "let value = store.get(&key)" },
          { type: "delta" as const, text: '.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "key not found"))?;' },
          { type: "delta" as const, text: "\n            Ok(value.clone())" },
          { type: "done" as const },
        ],
      },
      {
        name: "Go: HTTP error handler",
        input: {
          prefix: "func (s *Server) HandleCreateUser(w http.ResponseWriter, r *http.Request) {\n\tvar req CreateUserRequest\n\tif err := json.NewDecoder(r.Body).Decode(&req); err != nil {\n\t\t",
          suffix: "\n\t}\n\tuser, err := s.userService.Create(r.Context(), req)\n\tjson.NewEncoder(w).Encode(user)\n}",
          language: "go",
          filename: "internal/api/handler.go",
        },
        events: [
          { type: "delta" as const, text: 'http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)' },
          { type: "delta" as const, text: "\n\t\treturn" },
          { type: "done" as const },
        ],
      },
    ]

    await using tmp = await tmpdir()

    for (const scenario of scenarios) {
      streamCalls.length = 0
      mockEvents = scenario.events as CompletionEvent[]

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const app = Server.App()
          const response = await app.request("/completion", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(scenario.input),
          })

          expect(response.status).toBe(200)

          const body = await response.text()
          const events = parseSSE(body) as CompletionEvent[]

          const deltas = events.filter((e: any) => e.type === "delta") as { type: "delta"; text: string }[]
          const completed = deltas.map((e) => e.text).join("")

          const call = streamCalls[0]

          console.log(`  ${scenario.name}`)
          console.log(`    status=200  events=${events.length}  deltas=${deltas.length}`)
          console.log(`    prompt has prefix=${call.prompt.includes(scenario.input.prefix.slice(-20))}  suffix=${call.prompt.includes(scenario.input.suffix.slice(0, 20))}`)
          console.log(`    lang=${call.prompt.includes("Language: " + scenario.input.language)}  file=${call.prompt.includes("File: " + scenario.input.filename)}`)
          console.log(`    output: ${JSON.stringify(completed.length > 70 ? completed.slice(0, 70) + "…" : completed)}`)

          // Assertions
          expect(events[events.length - 1]).toEqual({ type: "done" })
          expect(call.prompt).toContain("Language: " + scenario.input.language)
          expect(call.prompt).toContain("File: " + scenario.input.filename)
          expect(call.prompt).toContain("<code_before_cursor>")
          expect(call.prompt).toContain("<code_after_cursor>")
          expect(completed.length).toBeGreaterThan(0)
        },
      })
    }
  })

  test("POST /completion streams error events from completionStream", async () => {
    await using tmp = await tmpdir()

    mockEvents = [
      { type: "delta", text: "partial" },
      { type: "error", error: "API rate limit exceeded" },
    ]

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/completion", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prefix: "let x = ",
            suffix: "",
            language: "javascript",
          }),
        })

        expect(response.status).toBe(200)

        const body = await response.text()
        const events = parseSSE(body) as CompletionEvent[]

        expect(events).toEqual([
          { type: "delta", text: "partial" },
          { type: "error", error: "API rate limit exceeded" },
        ])
      },
    })
  })
})
