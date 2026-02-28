import { ClaudeCodeClient } from "./client.js";

// ─── JSON-RPC 2.0 types ───────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess<T> {
  jsonrpc: "2.0";
  id: string | number;
  result: T;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcError;

function isJsonRpcError<T>(
  r: JsonRpcResponse<T>
): r is JsonRpcError {
  return "error" in r;
}

export class McpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(`MCP RPC error ${code}: ${message}`);
    this.name = "McpRpcError";
  }
}

// ─── MCP session ─────────────────────────────────────────────────────────────

/**
 * Thin wrapper around the Anthropic MCP proxy (mcp-proxy.anthropic.com).
 *
 * Sends JSON-RPC 2.0 requests to a named MCP server. The session ID is
 * forwarded via `X-Mcp-Client-Session-Id` so the proxy can route requests
 * to the correct server instance.
 */
export class McpSession {
  private nextId = 1;

  constructor(
    private readonly client: ClaudeCodeClient,
    readonly serverId: string,
    readonly sessionId: string
  ) {}

  /**
   * Send a JSON-RPC 2.0 request and return the result.
   * Throws `McpRpcError` on protocol-level errors.
   */
  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined && { params }),
    };

    const res = await this.client.postMcpProxy(
      this.serverId,
      request,
      this.sessionId
    );

    if (!res.ok) {
      throw new Error(
        `MCP proxy HTTP ${res.status} for ${this.serverId}: ${await res.text()}`
      );
    }

    const body = (await res.json()) as JsonRpcResponse<T>;

    if (isJsonRpcError(body)) {
      throw new McpRpcError(
        body.error.code,
        body.error.message,
        body.error.data
      );
    }

    return body.result;
  }

  // ─── Standard MCP lifecycle methods ────────────────────────────────────────

  /** MCP `initialize` — exchange capabilities with the server. */
  async initialize(
    clientInfo: { name: string; version: string } = {
      name: "claude-code-sdk",
      version: "0.1.0",
    }
  ): Promise<unknown> {
    return this.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo,
    });
  }

  /** MCP `tools/list` — enumerate available tools. */
  async listTools(): Promise<unknown> {
    return this.call("tools/list");
  }

  /** MCP `tools/call` — invoke a named tool. */
  async callTool(name: string, args?: Record<string, unknown>): Promise<unknown> {
    return this.call("tools/call", { name, arguments: args ?? {} });
  }

  /** MCP `resources/list` — enumerate available resources. */
  async listResources(): Promise<unknown> {
    return this.call("resources/list");
  }

  /** MCP `resources/read` — read a resource by URI. */
  async readResource(uri: string): Promise<unknown> {
    return this.call("resources/read", { uri });
  }
}
