import type { ClaudeCodeClientOptions } from "./types.js";

// Beta flags sent on every real inference call — mirrors what Claude Code 2.1.63 sends
export const INFERENCE_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "effort-2025-11-24",
  "adaptive-thinking-2026-01-28",
].join(",");

// Beta flags for non-inference authed calls
const OAUTH_BETA = "oauth-2025-04-20";

export class ClaudeCodeClient {
  readonly oauthToken: string;
  readonly baseUrl: string;
  readonly mcpProxyBaseUrl: string;

  constructor(opts: ClaudeCodeClientOptions) {
    this.oauthToken = opts.oauthToken;
    this.baseUrl = opts.baseUrl ?? "https://api.anthropic.com";
    this.mcpProxyBaseUrl =
      opts.mcpProxyBaseUrl ?? "https://mcp-proxy.anthropic.com";
  }

  // ─── Raw HTTP helpers ───────────────────────────────────────────────────────

  private authHeaders(extraBetas?: string): Record<string, string> {
    // OAuth tokens start with sk-ant-oat; API keys use x-api-key header
    const isOAuth = this.oauthToken.startsWith("sk-ant-oat");
    const authHeader: Record<string, string> = isOAuth
      ? { Authorization: `Bearer ${this.oauthToken}` }
      : { "x-api-key": this.oauthToken };

    return {
      ...authHeader,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": extraBetas ?? OAUTH_BETA,
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      "User-Agent": "claude-code/2.1.63",
    };
  }

  async get<T>(path: string, betas?: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: this.authHeaders(betas),
    });
    if (!res.ok) {
      throw new ApiError(res.status, await res.text(), path);
    }
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown, betas?: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.authHeaders(betas),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new ApiError(res.status, await res.text(), path);
    }
    return res.json() as Promise<T>;
  }

  /**
   * POST to the messages endpoint with streaming SSE.
   * Returns the raw Response so the caller can read the body as a stream.
   */
  async postMessagesStream(body: unknown, abort?: AbortSignal): Promise<Response> {
    const res = await fetch(`${this.baseUrl}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        ...this.authHeaders(INFERENCE_BETAS),
        Accept: "application/json",
        "anthropic-dangerous-direct-browser-access": "true",
        "x-app": "cli",
        "X-Stainless-Lang": "js",
        "X-Stainless-Package-Version": "0.74.0",
        "X-Stainless-Runtime": "node",
      },
      body: JSON.stringify(body),
      signal: abort,
    });
    if (!res.ok) {
      throw new ApiError(res.status, await res.text(), "/v1/messages");
    }
    return res;
  }

  /**
   * POST to the MCP proxy (JSON-RPC 2.0 over HTTP).
   */
  async postMcpProxy(
    serverId: string,
    body: unknown,
    sessionId: string
  ): Promise<Response> {
    return fetch(`${this.mcpProxyBaseUrl}/v1/mcp/${serverId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.oauthToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "User-Agent": "claude-code/2.1.63 (cli)",
        "X-Mcp-Client-Session-Id": sessionId,
      },
      body: JSON.stringify(body),
    });
  }
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly path: string
  ) {
    super(`HTTP ${status} from ${path}: ${body.slice(0, 200)}`);
    this.name = "ApiError";
  }
}
