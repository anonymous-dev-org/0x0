import { ClaudeCodeClient } from "./client.js";
import type {
  FeatureFlags,
  GroveStatus,
  McpServer,
  PenguinModeStatus,
  StartupContext,
} from "./types.js";

// ─── Individual startup calls ─────────────────────────────────────────────────

async function fetchFeatureFlags(
  client: ClaudeCodeClient
): Promise<FeatureFlags> {
  try {
    // The flag endpoint is a POST with an SDK identifier in the path.
    // The exact slug doesn't matter for auth — we use a stable placeholder.
    const result = await client.post<{ flags: FeatureFlags }>(
      "/api/eval/sdk-claude-code",
      { version: "2.1.63" }
    );
    return result.flags ?? {};
  } catch {
    return {};
  }
}

async function fetchGroveStatus(
  client: ClaudeCodeClient
): Promise<GroveStatus> {
  try {
    return await client.get<GroveStatus>("/api/claude_code_grove");
  } catch {
    return {
      grove_enabled: false,
      domain_excluded: false,
      notice_is_grace_period: false,
      notice_reminder_frequency: 0,
    };
  }
}

async function fetchAccountSettings(
  client: ClaudeCodeClient
): Promise<Record<string, unknown>> {
  try {
    return await client.get<Record<string, unknown>>(
      "/api/oauth/account/settings"
    );
  } catch {
    return {};
  }
}

async function fetchPenguinMode(
  client: ClaudeCodeClient
): Promise<PenguinModeStatus> {
  try {
    return await client.get<PenguinModeStatus>(
      "/api/claude_code_penguin_mode"
    );
  } catch {
    return { enabled: false, disabled_reason: null };
  }
}

async function fetchClientData(
  client: ClaudeCodeClient
): Promise<Record<string, unknown>> {
  try {
    return await client.get<Record<string, unknown>>(
      "/api/oauth/claude_cli/client_data"
    );
  } catch {
    return {};
  }
}

async function fetchMcpServers(
  client: ClaudeCodeClient
): Promise<McpServer[]> {
  try {
    const result = await client.get<{ data: McpServer[] }>(
      "/v1/mcp_servers?limit=1000"
    );
    return result.data ?? [];
  } catch {
    return [];
  }
}

/**
 * Probe whether the token has quota by sending a minimal inference call.
 * Returns true if the response is 200, false on 429/402/other errors.
 */
async function probeQuota(client: ClaudeCodeClient): Promise<boolean> {
  try {
    const res = await client.postMessagesStream({
      model: "claude-haiku-4-5",
      max_tokens: 1,
      stream: true,
      messages: [{ role: "user", content: "quota" }],
    });
    // Drain the body so the connection is released cleanly
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run all startup calls in parallel and return the aggregated context.
 *
 * Mirrors the burst of requests Claude Code fires on launch. All calls are
 * best-effort — individual failures return safe defaults so the session can
 * continue without every flag endpoint being reachable.
 */
export async function startup(
  client: ClaudeCodeClient
): Promise<StartupContext> {
  const [
    featureFlags,
    grove,
    accountSettings,
    penguinMode,
    clientData,
    mcpServers,
    quotaOk,
  ] = await Promise.all([
    fetchFeatureFlags(client),
    fetchGroveStatus(client),
    fetchAccountSettings(client),
    fetchPenguinMode(client),
    fetchClientData(client),
    fetchMcpServers(client),
    probeQuota(client),
  ]);

  return {
    featureFlags,
    grove,
    penguinMode,
    mcpServers,
    accountSettings,
    clientData,
    quotaOk,
  };
}
