# WasmHatch roadmap

Direction (2026-07-13): WasmHatch is a **general AI agent that runs entirely
in a browser tab** — no Docker, no install, and no signup for standalone or
BYOK use. An optional hosted catalog publishes portable agents, while the OSS
runtime and agent format remain useful without that service. The single
differentiation point is the form factor. Features imitate the incumbent
agents (ChatGPT + connectors, Claude + connectors + Artifacts) as closely as
the platform allows; the commitment is **not losing inside an advertised
boundary**, not novelty. Connectivity (Google Workspace, Slack) with genuinely
easy setup, and in-tab HTML document creation, are the value axes.

The advertised boundary — what we say the agent can and cannot do — is a
feature. Un-advertised capability gaps kill agents; documented limits do not.

## Phase 0 — Agent foundation (now → ~6 weeks)

- [x] Unified provider-abstracted streaming loop core
      (`src/lib/agent-core/`: SSE decoder, Anthropic adapter,
      OpenAI-compatible adapter covering OpenAI/OpenRouter/Gemini/Ollama/
      LM Studio, parallel tool dispatch, soft budgets, cancellation).
      See `docs/agent-loop-design.md`.
- [x] Chrome built-in AI tool-call emulation spike (`builtin-ai-loop.ts`) —
      the key-free first-run path.
- [x] Chat-first UI (transcript, streaming text, tool-call chips, artifact
      panel) shipped as `ChatPage.tsx` at `?view=chat`, the advertised entry
      point.
- [ ] Retire `OperatorPage.tsx` once its remaining flows (guided demos,
      Google Sheets range effects, run journal) have chat-side homes; until
      then it stays a parts donor.
- [x] Autonomy by default: writes apply immediately with the exact diff
      surfaced in the transcript and one-click revert; the opt-in Careful
      mode gates writes behind Allow / Always-allow / Reject. Proposal and
      manifest vocabulary disappears from UI strings. Approval is a mode,
      never the message.
- [x] Remove anti-parity ceilings (one-tool-per-turn, six-call caps, egress
      caps) in favor of visible soft budgets. The chat loop (`agent-core`)
      always had resumable soft budgets; the legacy planner loops now allow
      parallel tool calls and carry generous visible budgets instead of
      6-call/8-turn/256 KB ceilings.
- [ ] Custom domain + production OAuth client + Sensitive-scope verification
      submitted (lead time runs in parallel with development). Done so far:
      wasmhatch.com is live and the production OAuth client is provisioned;
      the verification submission is the open step.

Exit: a real model streams, calls tools, and edits a file end-to-end —
autonomously with a visible, revertible diff — with zero legacy
vocabulary on screen.

## Phase 1 — Connectivity and artifacts (~6 → 12 weeks)

- [ ] Google: drive.file + Picker as an agent tool (file handover is a
      visible consent step in the conversation); create/read/write for
      Sheets, Docs, Slides via direct REST; silent token re-grant.
      Shipped so far: the agent creates Docs, Sheets, and Slides and edits
      the ones it created (`google-connectors.ts`); Picker handover and
      silent re-grant remain.
- [x] HTML artifact panel: sandboxed iframe (`srcdoc`, `allow-scripts`,
      never `allow-same-origin`) with an injected frame policy;
      self-contained single-file HTML renders beside the chat and downloads
      instantly (`ArtifactPanel.tsx`, `artifact.ts`).
- [x] Slack, staged: Incoming Webhook connector (60-second setup), then
      form-encoded body-token Web API client with guided internal-app
      manifest install; startup CORS probe with plain-language diagnostics;
      Cloudflare Worker relay template bundled as the documented fallback.
      All stages shipped: webhook connector (`slack-webhook.ts`), bot-token
      channel tools (`slack-tools.ts` over `slack-connect.ts` — list public
      channels, post to any; the connect probe classifies invalid-token /
      cors-blocked / network with plain-language copy), the guided manifest
      in `docs/slack.md`, and the bundled relay wired via the build-time
      `VITE_SLACK_PROXY_URL` (its https origin joins the audited CSP).
      Post-only by scope design — no history read.
- [x] README "What it cannot do" section: full-Drive listing/search,
      Calendar until verification clears, arbitrary web browsing (provider
      web search with cited sources is the documented exception), background
      runs, non-CORS MCP servers, admin-managed Workspace accounts.
- [ ] The demo GIF: one uncut 30-second take — open URL, connect Google in
      3 clicks, real AI edits a real Sheet with the diff visible in the
      transcript, a deck appears in-tab, download.
      `scripts/record-demo.mjs` records the non-Google beats (open URL →
      key → visible diff → in-tab artifact) with a real model; the Google
      consent beats need a human take.

Exit — the five launch conditions, one uncut take, or no launch date:
1. Key-free path shows first tokens in under 60 seconds.
2. Google connects in 3 clicks with no warning screen.
3. A real write to a real Sheet lands with its diff visible in the
   transcript.
4. An artifact renders in-tab and downloads as a single HTML file.
5. Every error message explains itself without jargon.

## Phase 2 — Launch + 8 weekly artifacts (week 12+)

- [ ] Seed 100–200 stars from the network, then a 48-hour concentrated
      launch: Show HN (Tue–Thu morning ET, honest pivot story + one stated
      limitation in the first comment), r/selfhosted ("self-hosting with
      zero maintenance surface: fork → enable Pages → done"), dev.to.
      Launch-day scopes stay Non-sensitive only (drive.file) — never risk
      the 100-user cap during the spike.
- [ ] One visible artifact per week for 8 weeks: Slack full flow, curated
      "browser-reachable MCP servers" list, MCP-by-URL client with CORS
      diagnostics, Calendar (post-verification), search APIs (user-key
      Tavily/Brave), Ollama localhost CSP exception, Pyodide heavy sandbox.
- [x] Fork guide (`docs/fork-guide.md`): fork → enable Pages → done,
      bring-your-own Google client ID (rclone pattern), and two documented
      enterprise escape hatches (admin allowlist / internal fork); the Pages
      workflow feeds a fork's `VITE_GOOGLE_CLIENT_ID` repository variable
      into the build.

Exit: 8/8 weekly artifacts; first stranger-authored issue or PR; Sensitive
verification cleared.

## Parallel track — Hatchling swarm (shipped 2026-07-22)

A small team of agents that keeps doing useful work for as long as the tab
is open — the serverless answer to the incumbents' multi-agent and
scheduled-run features. Design record: `docs/hatchlings-design.md`.

- [x] Multi-thread agents: up to eight hatchlings, each with its own name,
      conversation, and isolated workspace pair; the legacy workspace became
      hatchling `main` with nothing moved (`agent-threads.ts`,
      `agent-session.ts`; transcripts moved to OPFS via `opfs-kv.ts`).
- [x] Shared ticket board as the coordination surface — a work queue, not a
      PM tool: `todo / doing / done / blocked`, atomic claims, user panel
      plus three agent tools (`tickets.ts`).
- [x] Interval "auto work" while the tab is open: worker-timer ticks,
      immediate first run, cumulative visible run budget, exponential
      failure backoff with auto-off, autonomous-mode only, global pause
      (`agent-scheduler.ts`). Copy never claims background execution.
- [x] Browser MCP client, Streamable HTTP: loopback servers out of the box
      (any port), remote origins only via the build-time
      `VITE_EXTRA_MCP_SERVERS` allowlist feeding the same audited CSP as
      model providers (`mcp-client.ts`, `mcp-servers.ts`). The curated
      reachable-server list is measured and published
      (`docs/browser-mcp-servers.md`, probed 2026-07-22: five keyless
      servers work, eight token servers pass CORS preflight incl.
      Authorization, five vendors block browsers). CORS diagnostics in-app
      remain a Phase 2 artifact.
- [x] Pixel office: dependency-free canvas, one chick per hatchling with
      mood glyphs, click-to-select, and an aria-label that says everything
      the pixels do (`pixel-office.ts`, `HatchlingOffice.tsx`).

## Parallel track — Portable agent distribution

- [x] Versioned `wasmhatch.agent` ZIP contract with exact file hashes, bounded
      extraction, protected credential paths, declared capabilities, and a
      registry-neutral HTTPS loader (`src/lib/agent-package.ts`).
- [ ] Add a plain-language publish preview that lists included files,
      requested capabilities, compatibility, and sample prompts before any
      upload.
- [ ] Load a selected portable agent into the chat runtime without allowing
      package instructions or scripts to access provider credentials.
- [ ] Connect an optional official Registry adapter for publish, unpublish,
      and immutable revision lookup; keep local file and arbitrary HTTPS
      sources first-class.
- [ ] Add a one-click public trial route using the visitor's existing BYOK
      configuration, with an example-output fallback for visitors without a
      provider key.

## Phase 3 — Traction-gated expansion

- Restricted Drive scope + CASA assessment (~$500–1,000/yr) only when usage
  justifies it — unlocks whole-Drive search.
- Second-origin artifact viewer for script-executing artifacts,
  claudeusercontent.com-style. The `wasmhatch-usercontent` GitHub org is
  reserved as the free interim origin (the name itself signals "untrusted
  generated content, not the product"); the endgame is a separate
  registrable domain. The plain `wasmhatch` org is reserved for brand
  protection and as a possible neutral future home for the repository.
- WebMCP consumer experiment when Chrome ships native support — the
  standards track where an in-tab agent is structurally the right consumer.
- Browser MCP client layer published as a standalone OSS library.
- Passkey-protected key storage (WebAuthn PRF): the remembered API key is
  encrypted at rest and unlocked with a fingerprint — still no server.
- Local-first optional sync: an encrypted settings-and-connections blob in
  the user's own Google Drive appDataFolder gives cross-device continuity
  without a first-party server or token vault.

## Standing rules

- No silent `connect-src https:` relaxation; connector origins are a
  build-time audited allowlist.
- No shared credential relay in the OSS runtime. The separate optional hosted
  service may provide catalog APIs and, on a paid plan, an explicit managed
  inference gateway; standalone BYOK traffic still goes directly from the
  browser to the selected provider.
- No hidden analytics in the OSS runtime. The hosted service may measure its
  own publish and download events under a documented privacy policy.
- No empty Discord; GitHub Discussions until there are real users.
- Weekly named releases with human-readable notes; no silent version-bump
  streams.
- Decline out-of-boundary requests by pointing at the documented limits
  instead of saying "it's on the roadmap".
