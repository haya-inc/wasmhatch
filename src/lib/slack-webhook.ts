/**
 * Slack Incoming Webhook connector — the 60-second Slack setup.
 *
 * The user creates an Incoming Webhook in Slack (one channel, one URL) and
 * pastes the URL into the sidebar; the agent gains one tool that posts a
 * message to that channel. Measured behavior (2026-07-22): hooks.slack.com
 * answers form-encoded CORS "simple requests" with a readable response
 * ("ok" or a plain error code), so delivery is verified, not fire-and-hope.
 * A JSON body would trigger a CORS preflight that Slack does not answer —
 * this module must keep using `payload=` form encoding.
 *
 * The webhook URL is a capability URL: anyone holding it can post to the
 * channel. It is treated like an access token — kept in tab memory, never
 * persisted, never placed in tool results or error messages.
 */

import type { AgentToolDefinition, AgentToolExecutor, AgentToolOutcome } from "./agent-core/types";

export const SLACK_WEBHOOK_URL_PREFIX = "https://hooks.slack.com/services/";

/** Slack rejects longer texts; stay inside the documented ceiling. */
const MAX_TEXT_LENGTH = 40_000;

export function isSlackWebhookUrl(value: string): boolean {
  if (!value.startsWith(SLACK_WEBHOOK_URL_PREFIX)) return false;
  try {
    const url = new URL(value);
    return url.origin === "https://hooks.slack.com" && url.pathname.startsWith("/services/") && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export const SLACK_WEBHOOK_TOOLS: readonly AgentToolDefinition[] = [
  {
    name: "post_slack_message",
    description:
      "Post a message to the user's connected Slack channel through their Incoming Webhook. " +
      "The channel is fixed by the webhook; there is no channel choice and no reading of Slack content. " +
      "Text supports Slack mrkdwn (*bold*, _italic_, <https://url|links>).",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Message text (Slack mrkdwn)." } },
      required: ["text"],
      additionalProperties: false
    }
  }
];

/** Maps Slack's terse webhook error codes to sentences a user can act on. */
function describeWebhookError(code: string): string {
  switch (code) {
    case "no_service":
    case "no_team":
    case "channel_not_found":
      return "Slack no longer accepts this webhook URL — it was likely revoked or its channel was deleted. Create a new Incoming Webhook and reconnect.";
    case "channel_is_archived":
      return "The webhook's Slack channel is archived. Unarchive it or create a webhook for another channel.";
    case "invalid_payload":
    case "no_text":
      return "Slack rejected the message content. Try a shorter, simpler message.";
    case "action_prohibited":
      return "A Slack workspace admin has blocked this webhook from posting.";
    case "rate_limited":
      return "Slack is rate-limiting this webhook. Wait a minute before posting again.";
    default:
      return `Slack declined the message (${code}).`;
  }
}

/** Redacts the secret webhook path from any text that might surface to the user or model. */
function redactWebhookUrl(text: string, url: string): string {
  return url ? text.split(url).join("[slack-webhook]") : text;
}

/**
 * Creates the executor for SLACK_WEBHOOK_TOOLS. `getUrl` is read per call so
 * the URL lives only in the caller's memory; it never appears in outcomes.
 */
export function createSlackWebhookExecutor(
  getUrl: () => string,
  options?: { fetchImpl?: typeof fetch }
): AgentToolExecutor {
  const fetchImpl = options?.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  return async (name, args, context): Promise<AgentToolOutcome> => {
    if (name !== "post_slack_message") {
      return { content: `Unknown Slack tool: ${name}`, isError: true };
    }
    const url = getUrl();
    if (!isSlackWebhookUrl(url)) {
      return { content: "Slack is not connected. Ask the user to paste their Incoming Webhook URL in the Slack panel.", isError: true };
    }
    const text = (args as { text?: unknown }).text;
    if (typeof text !== "string" || !text.trim()) {
      return { content: "post_slack_message requires non-empty text.", isError: true };
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return { content: `post_slack_message text exceeds ${MAX_TEXT_LENGTH.toLocaleString()} characters. Send a shorter message.`, isError: true };
    }

    let response: Response;
    try {
      // A CORS "simple request": form-encoded, no preflight; see module notes.
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `payload=${encodeURIComponent(JSON.stringify({ text }))}`,
        signal: context?.signal
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (error instanceof TypeError) {
        return {
          content: "The browser could not reach Slack (network problem, or the webhook route changed). The message was not delivered.",
          isError: true
        };
      }
      const detail = error instanceof Error ? error.message : String(error);
      return { content: redactWebhookUrl(`Slack delivery failed before a response arrived (${detail}).`, url), isError: true };
    }

    let body = "";
    try {
      body = (await response.text()).trim();
    } catch {
      body = "";
    }
    if (response.ok && body === "ok") {
      return { content: "Message delivered to the connected Slack channel." };
    }
    const code = body || `http_${response.status}`;
    return { content: redactWebhookUrl(describeWebhookError(code), url), isError: true };
  };
}
