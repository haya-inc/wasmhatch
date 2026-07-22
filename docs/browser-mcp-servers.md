# Browser-reachable remote MCP servers

WasmHatch's MCP client runs inside a web page, so a remote MCP server is
usable only when **the server's CORS policy lets a browser talk to it**.
That is the vendor's call, not ours — no proxy, no relay, no exception.
This page is the measured answer to "which ones actually work?".

Out of the box the app reaches MCP servers on your own machine (loopback,
any port). Remote origins must be baked into a deployment's audited
allowlist via `VITE_EXTRA_MCP_SERVERS` — see
[the fork guide](fork-guide.md) and the deployment notes below.

## How this was measured

Probed 2026-07-22 from a plain browser page (not from Node — CORS only
exists in browsers): one Streamable-HTTP `initialize` POST per endpoint
(`content-type: application/json`, `accept: application/json,
text/event-stream`), then a second pass adding an `Authorization: Bearer`
header to confirm the CORS preflight also allows credentials. Servers
change their policies; treat every row as "as of the probe date".

## Works with no account or key

CORS open, `initialize` succeeds anonymously — paste-and-go once the
origin is in a deployment's allowlist:

| Server | Endpoint | Notes |
| --- | --- | --- |
| Hugging Face | `https://huggingface.co/mcp` | Model/dataset/Space search |
| DeepWiki | `https://mcp.deepwiki.com/mcp` | Ask questions about public GitHub repos |
| Context7 | `https://mcp.context7.com/mcp` | Up-to-date library docs |
| Cloudflare Docs | `https://docs.mcp.cloudflare.com/mcp` | Cloudflare docs search |
| Exa | `https://mcp.exa.ai/mcp` | Web search (richer plans need a key) |

## Works with a token

CORS open — including the `Authorization` header in the preflight — but
`initialize` requires a bearer token. The app's per-server access-token
field carries it; the token stays in tab memory.

| Server | Endpoint | Token reality |
| --- | --- | --- |
| GitHub | `https://api.githubcopilot.com/mcp/` | A classic PAT works as the bearer token — the practical browser path today |
| Linear | `https://mcp.linear.app/mcp` | OAuth-issued token (no static API-key path) |
| Notion | `https://mcp.notion.com/mcp` | OAuth-issued token |
| Atlassian | `https://mcp.atlassian.com/v1/mcp` | OAuth-issued token |
| Asana | `https://mcp.asana.com/sse` | OAuth-issued token |
| Intercom | `https://mcp.intercom.com/mcp` | OAuth-issued token |
| monday.com | `https://mcp.monday.com/mcp` | OAuth-issued token |
| Globalping | `https://mcp.globalping.dev/mcp` | Token raises rate limits |

The OAuth rows share one honest caveat: those vendors issue tokens
through an OAuth flow (often with dynamic client registration) that
WasmHatch does not run yet. If you can mint a token elsewhere, the
client works; a built-in OAuth flow is future work.

## CORS open, but the Authorization header is refused

The anonymous probe passes, yet the preflight rejects the
`Authorization` header — so authenticated use from a browser fails until
the vendor allows the header:

| Server | Endpoint |
| --- | --- |
| PayPal | `https://mcp.paypal.com/mcp` |
| Square | `https://mcp.squareup.com/sse` |

## Not browser-reachable (CORS refused)

The servers respond over the network, but their CORS policy rejects
browser requests outright. These need the vendor to change policy — or a
relay you host yourself:

| Server | Endpoint probed |
| --- | --- |
| Sentry | `https://mcp.sentry.dev/mcp` |
| Zapier | `https://mcp.zapier.com/api/mcp/mcp` |
| Webflow | `https://mcp.webflow.com/sse` |
| Stripe | `https://mcp.stripe.com/` |
| Vercel | `https://mcp.vercel.com/` |

## Using a browser-reachable server in your deployment

Remote origins are a build-time decision (the same audited-allowlist
posture as model providers — see the standing rules in
[ROADMAP.md](../ROADMAP.md)). In a fork, set the `VITE_EXTRA_MCP_SERVERS`
repository variable, for example:

```json
[
  { "id": "deepwiki", "label": "DeepWiki", "url": "https://mcp.deepwiki.com/mcp", "auth": "none" },
  { "id": "github", "label": "GitHub", "url": "https://api.githubcopilot.com/mcp/", "auth": "bearer" }
]
```

The build regenerates the CSP `connect-src` from this registry
(`src/lib/mcp-servers.ts`), and `scripts/check-built-security.mjs` audits
the result. At runtime every hatchling shares the connected servers'
tools, namespaced `mcp_<id>_<tool>`.

For a server on this page's "not reachable" list, the documented
fallback is a relay on infrastructure you control (e.g. a Cloudflare
Worker that adds CORS and forwards to the vendor) — that relay's origin
then goes into the allowlist instead.
