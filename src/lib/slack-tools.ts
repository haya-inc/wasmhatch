/**
 * Slack Web API agent tools — the token stage of the staged Slack plan.
 *
 * Built on `slack-connect.ts` (form-encoded body-token calls, the CORS
 * "simple request" route re-verified 2026-07-22: auth.test, chat.postMessage
 * and conversations.list all answer readably from a browser page). The bot
 * token comes from the guided internal-app manifest install (docs/slack.md)
 * and is treated like every other credential: tab memory only, supplied per
 * call, never present in tool results or error text.
 *
 * Scope boundary, stated in the tool descriptions so the model knows it:
 * the manifest grants channels:read + chat:write(+.public) — the agent can
 * list public channels and post; it cannot read message history.
 */

import type { AgentToolDefinition, AgentToolExecutor, AgentToolOutcome } from "./agent-core/types";
import { slackApiCall } from "./slack-connect";

/** Slack rejects longer texts; stay inside the documented ceiling. */
const MAX_TEXT_LENGTH = 40_000;
const MAX_CHANNELS = 200;

/**
 * Deployment-baked relay for the day Slack closes the direct browser route:
 * VITE_SLACK_PROXY_URL points at a self-hosted workers/slack-proxy instance
 * (its origin joins the CSP at build time in vite.config.ts). Returns the
 * `baseUrl` for slack-connect calls, or undefined for the direct route.
 */
export function slackProxyBaseUrl(): string | undefined {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const raw = env?.VITE_SLACK_PROXY_URL;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return undefined;
    return `${url.origin}/api`;
  } catch {
    return undefined;
  }
}

export const SLACK_API_TOOLS: readonly AgentToolDefinition[] = [
  {
    name: "list_slack_channels",
    description:
      "List the workspace's public Slack channels (id, #name, whether the bot is a member). " +
      "Requires the user's connected Slack bot token. This connector cannot read message history.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "send_slack_channel_message",
    description:
      "Send a message to one Slack channel as the connected bot. `channel` is a channel ID from " +
      "list_slack_channels (preferred) or a #name. Text supports Slack mrkdwn " +
      "(*bold*, _italic_, <https://url|links>). This connector cannot read message history.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID (C…) or #name." },
        text: { type: "string", description: "Message text (Slack mrkdwn)." }
      },
      required: ["channel", "text"],
      additionalProperties: false
    }
  }
];

/** Maps Slack Web API error codes to sentences a user can act on. */
function describeApiError(code: string): string {
  switch (code) {
    case "invalid_auth":
    case "account_inactive":
    case "token_revoked":
    case "token_expired":
    case "not_authed":
      return `Slack rejected the bot token (${code}). Reinstall the app in Slack, copy a fresh bot token, and reconnect.`;
    case "missing_scope":
      return "The bot token is missing a required scope. Recreate the Slack app from the manifest in docs/slack.md (channels:read, chat:write, chat:write.public) and reconnect with the new token.";
    case "channel_not_found":
      return "Slack does not recognize that channel. Use a channel ID from list_slack_channels.";
    case "not_in_channel":
      return "The bot is not in that channel and may not post there. Invite it in Slack (/invite) or use a public channel.";
    case "is_archived":
      return "That Slack channel is archived, so nothing can be posted there.";
    case "msg_too_long":
    case "no_text":
      return "Slack rejected the message content. Try a shorter, simpler message.";
    case "rate_limited":
    case "ratelimited":
      return "Slack is rate-limiting the bot. Wait a minute before trying again.";
    default:
      return `Slack declined the request (${code}).`;
  }
}

interface ConversationsListBody {
  ok?: unknown;
  error?: unknown;
  channels?: unknown;
}

interface PostMessageBody {
  ok?: unknown;
  error?: unknown;
  channel?: unknown;
  ts?: unknown;
}

function fail(content: string): AgentToolOutcome {
  return { content, isError: true };
}

/**
 * Creates the executor for SLACK_API_TOOLS. `getToken` is read per call so
 * the token lives only in the caller's memory and never lands in outcomes.
 */
export function createSlackApiExecutor(
  getToken: () => string,
  options?: { fetchImpl?: typeof fetch; baseUrl?: string }
): AgentToolExecutor {
  return async (name, args, context): Promise<AgentToolOutcome> => {
    const token = getToken();
    if (!token.trim()) {
      return fail("Slack is not connected with a bot token. Ask the user to connect Slack in the sidebar.");
    }
    const callOptions = { ...options, signal: context?.signal };

    try {
      if (name === "list_slack_channels") {
        const body = await slackApiCall<ConversationsListBody>("conversations.list", token, {
          types: "public_channel",
          exclude_archived: true,
          limit: MAX_CHANNELS
        }, callOptions);
        if (body.ok !== true) {
          return fail(describeApiError(typeof body.error === "string" && body.error ? body.error : "unknown_error"));
        }
        const channels = (Array.isArray(body.channels) ? body.channels : [])
          .flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const record = entry as { id?: unknown; name?: unknown; is_member?: unknown };
            if (typeof record.id !== "string" || typeof record.name !== "string") return [];
            return [{ id: record.id, name: record.name, member: record.is_member === true }];
          });
        if (!channels.length) return { content: "No public channels are visible to the bot." };
        const lines = channels.map((channel) => `${channel.id}  #${channel.name}${channel.member ? "  (bot is a member)" : ""}`);
        return { content: `${channels.length} public channel(s):\n${lines.join("\n")}` };
      }

      if (name === "send_slack_channel_message") {
        const channel = (args as { channel?: unknown }).channel;
        const text = (args as { text?: unknown }).text;
        if (typeof channel !== "string" || !channel.trim()) {
          return fail("send_slack_channel_message requires a channel ID or #name.");
        }
        if (typeof text !== "string" || !text.trim()) {
          return fail("send_slack_channel_message requires non-empty text.");
        }
        if (text.length > MAX_TEXT_LENGTH) {
          return fail(`send_slack_channel_message text exceeds ${MAX_TEXT_LENGTH.toLocaleString()} characters. Send a shorter message.`);
        }
        const body = await slackApiCall<PostMessageBody>("chat.postMessage", token, {
          channel: channel.trim(),
          text
        }, callOptions);
        if (body.ok !== true) {
          return fail(describeApiError(typeof body.error === "string" && body.error ? body.error : "unknown_error"));
        }
        const delivered = typeof body.channel === "string" && body.channel ? ` to ${body.channel}` : "";
        return { content: `Message delivered${delivered}.` };
      }

      return fail(`Unknown Slack tool: ${name}`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      // slackApiCall never places the token in its error messages.
      return fail(error instanceof Error ? error.message : "Slack request failed.");
    }
  };
}
