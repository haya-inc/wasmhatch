# Slack

Two independent ways to connect, both set up in the sidebar's Slack panel.
Neither reads anything from Slack — the agent posts, and every post is
visible in the conversation as it happens. Credentials live only in the
tab's memory; closing the tab discards them.

## Stage 1 — Incoming Webhook (60 seconds, one channel)

1. In Slack: **Tools & settings → Manage apps → Custom integrations →
   Incoming Webhooks** (or create one inside any Slack app), pick the
   channel, and copy the webhook URL.
2. Paste the URL into **Incoming Webhook URL** and press
   **Connect Slack**.

The agent gains one tool, `post_slack_message`, that posts to the
webhook's fixed channel. The URL is a capability URL — anyone holding it
can post — so the app treats it exactly like a token: memory-only,
redacted from every tool result and error.

## Stage 2 — Bot token (list channels, post anywhere)

A tiny Slack app of your own gives the agent two more tools:
`list_slack_channels` and `send_slack_channel_message` (any public
channel, or any channel the bot is invited to). Setup is a guided
manifest install:

1. Open <https://api.slack.com/apps> → **Create New App** →
   **From a manifest** → pick your workspace.
2. Paste this manifest (JSON tab):

   ```json
   {
     "display_information": {
       "name": "WasmHatch",
       "description": "Posts updates from your WasmHatch hatchlings.",
       "background_color": "#2b2d31"
     },
     "features": {
       "bot_user": { "display_name": "WasmHatch", "always_online": false }
     },
     "oauth_config": {
       "scopes": {
         "bot": ["channels:read", "chat:write", "chat:write.public"]
       }
     },
     "settings": {
       "org_deploy_enabled": false,
       "socket_mode_enabled": false,
       "token_rotation_enabled": false
     }
   }
   ```

3. **Install to Workspace**, approve the three scopes, then copy the
   **Bot User OAuth Token** (`xoxb-…`) from *OAuth & Permissions*.
4. Paste it into **Bot token (channel tools)** and press
   **Connect bot token**. The app verifies it with `auth.test` and shows
   the workspace name.

The scopes are the whole boundary: `channels:read` lists public
channels, `chat:write` + `chat:write.public` post messages. There is no
history scope — the agent cannot read Slack messages, and the tool
descriptions say so to the model.

## How the browser reaches Slack (and the fallback)

Browsers can call Slack's Web API without a server by avoiding the CORS
preflight: form-encoded POSTs with the token in the body — an
unofficial-but-longstanding route (`src/lib/slack-connect.ts`,
re-verified 2026-07-22: `auth.test`, `chat.postMessage` and
`conversations.list` all answer readably from a page). Incoming Webhooks
are also readable over the same form-encoded route, so webhook delivery
is confirmed by Slack's own `ok`.

If Slack ever closes the body-token route, the connect probe reports it
in plain language, and the documented fallback is the bundled
single-file Cloudflare Worker relay
([workers/slack-proxy](../workers/slack-proxy/README.md)): deploy it to
your own account, then bake it into a fork's build via the
`VITE_SLACK_PROXY_URL` repository variable (its https origin joins the
audited CSP `connect-src` at build time; the app then routes Web-API
calls through `<worker>/api`). The relay is stateless and never logs or
stores tokens.

## Privacy posture

- Webhook URLs and bot tokens are memory-only; nothing Slack-related is
  ever written to storage. Revoke them in Slack at any time.
- Every message the agent sends is shown in the conversation with its
  content; Careful mode additionally gates writes behind approval.
- The direct routes send credentials only to `hooks.slack.com` /
  `slack.com` (or to your own relay origin, when a fork configures one).
