# slack-proxy

A single-file, dependency-free Cloudflare Worker that relays Slack Web API calls for wasmhatch.

## Why it exists

The app talks to Slack directly from the browser via `src/lib/slack-connect.ts`, which relies on an unofficial-but-longstanding CORS quirk: sending the token as a `token` field in a form-encoded POST body (a CORS "simple request" that needs no preflight). If Slack ever closes that route, the app reports `cors-blocked` and this Worker is the documented fallback: it accepts the same form-encoded calls, attaches the token as a proper `Authorization: Bearer` header server-side (where CORS does not apply), and returns Slack's JSON to the browser with CORS headers.

## Deploy

One command from this directory (a Cloudflare account and `wrangler login` are the only prerequisites):

```sh
npx wrangler deploy worker.js --name wasmhatch-slack-proxy --compatibility-date 2026-07-01
```

Wrangler prints the Worker URL, e.g. `https://wasmhatch-slack-proxy.<your-account>.workers.dev`.

## Restrict the allowed origin

The Worker reads the `ALLOWED_ORIGIN` environment variable for its `Access-Control-Allow-Origin` header. It defaults to `*` so a first deploy works anywhere, but you should pin it to your app's origin before real use so other sites cannot relay tokens through your Worker:

```sh
npx wrangler deploy worker.js --name wasmhatch-slack-proxy --compatibility-date 2026-07-01 \
  --var ALLOWED_ORIGIN:https://your-app.example.com
```

(Or set it under Workers → Settings → Variables in the Cloudflare dashboard.)

## Point the app at it

Both functions in `src/lib/slack-connect.ts` accept a `baseUrl` option. The Worker serves `POST /api/{method}`, so the base URL is the Worker URL plus `/api`:

```ts
const baseUrl = "https://wasmhatch-slack-proxy.<your-account>.workers.dev/api";

await probeSlackConnectivity(token, { baseUrl });
await slackApiCall("conversations.list", token, { limit: 200 }, { baseUrl });
```

No other client change is needed: the app keeps sending the token in the form body, and the Worker upgrades it to an `Authorization` header before forwarding to `https://slack.com/api/{method}`.

Note: the Worker's origin must also be present in the app's CSP `connect-src` (see the policy in `vite.config.ts`) for the browser to be allowed to reach it.

## Security posture

- **Stateless.** The Worker is a pure pass-through. It never persists tokens or request bodies anywhere — no KV, no Durable Objects, no caches — and it never logs them. A token exists only in the memory of the single request that carries it.
- Accepts only `POST /api/{method}` (plus CORS `OPTIONS`); everything else is rejected, and `{method}` must match Slack's dotted method-name shape, which blocks path traversal.
- The token is read from the `Authorization: Bearer` header or the `token` form field, stripped from the forwarded body, and sent upstream only as the `Authorization` header on the request to `slack.com`.
