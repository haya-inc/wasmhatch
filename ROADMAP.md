# WasmHatch roadmap

Direction (2026-07-12): WasmHatch is a **general AI agent that runs entirely
in a browser tab** — no server, no Docker, no install, no signup. The single
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
- [ ] Chat-first UI replacing the operator wizard (transcript, streaming
      text, tool-call chips, artifact panel slot). `OperatorPage.tsx` becomes
      a parts donor and retires.
- [ ] Effect review recast as permission prompts: reads auto-allowed by
      connection grant; writes show the existing exact diff with
      Allow / Always-allow-for-this-resource / Reject. Proposal/manifest
      vocabulary disappears from UI strings.
- [ ] Remove anti-parity ceilings (one-tool-per-turn, six-call caps, egress
      caps) in favor of visible soft budgets.
- [ ] Custom domain + production OAuth client + Sensitive-scope verification
      submitted (lead time runs in parallel with development).

Exit: a real model streams, calls tools, and edits a file through a
permission prompt end-to-end with zero legacy vocabulary on screen.

## Phase 1 — Connectivity and artifacts (~6 → 12 weeks)

- [ ] Google: drive.file + Picker as an agent tool (file handover is a
      visible consent step in the conversation); create/read/write for
      Sheets, Docs, Slides via direct REST; silent token re-grant.
- [ ] HTML artifact panel: sandboxed iframe (`srcdoc`, `allow-scripts`,
      never `allow-same-origin`), self-contained single-file HTML as the
      standard output (documents, dashboards, reveal.js decks, print-to-PDF).
- [ ] Slack, staged: Incoming Webhook connector (60-second setup), then
      form-encoded body-token Web API client with guided internal-app
      manifest install; startup CORS probe with plain-language diagnostics;
      Cloudflare Worker relay template bundled as the documented fallback.
- [ ] README "What it cannot do" section: full-Drive listing/search,
      Calendar until verification clears, arbitrary web browsing, background
      runs, non-CORS MCP servers, admin-managed Workspace accounts.
- [ ] The demo GIF: one uncut 30-second take — open URL, connect Google in
      3 clicks, real AI edits a real Sheet behind a diff approval, a deck
      appears in-tab, download.

Exit — the five launch conditions, one uncut take, or no launch date:
1. Key-free path shows first tokens in under 60 seconds.
2. Google connects in 3 clicks with no warning screen.
3. A real write to a real Sheet lands behind a diff approval.
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
- [ ] Fork guide: bring-your-own Google client ID (rclone pattern); two
      documented enterprise escape hatches (admin allowlist / internal fork).

Exit: 8/8 weekly artifacts; first stranger-authored issue or PR; Sensitive
verification cleared.

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

## Standing rules

- No silent `connect-src https:` relaxation; connector origins are a
  build-time audited allowlist.
- No shared hosted relay; the only server code ever offered is a stateless
  single-purpose template users deploy themselves.
- No hidden analytics; measurement is GitHub-side metrics plus user reports.
- No empty Discord; GitHub Discussions until there are real users.
- Weekly named releases with human-readable notes; no silent version-bump
  streams.
- Decline out-of-boundary requests by pointing at the documented limits
  instead of saying "it's on the roadmap".
