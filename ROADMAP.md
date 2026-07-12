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
- [ ] Remove anti-parity ceilings (one-tool-per-turn, six-call caps, egress
      caps) in favor of visible soft budgets.
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
- [ ] Slack, staged: Incoming Webhook connector (60-second setup), then
      form-encoded body-token Web API client with guided internal-app
      manifest install; startup CORS probe with plain-language diagnostics;
      Cloudflare Worker relay template bundled as the documented fallback.
- [ ] README "What it cannot do" section: full-Drive listing/search,
      Calendar until verification clears, arbitrary web browsing, background
      runs, non-CORS MCP servers, admin-managed Workspace accounts.
- [ ] The demo GIF: one uncut 30-second take — open URL, connect Google in
      3 clicks, real AI edits a real Sheet with the diff visible in the
      transcript, a deck appears in-tab, download.

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
- No shared hosted relay; the only server code ever offered is a stateless
  single-purpose template users deploy themselves.
- No hidden analytics; measurement is GitHub-side metrics plus user reports.
- No empty Discord; GitHub Discussions until there are real users.
- Weekly named releases with human-readable notes; no silent version-bump
  streams.
- Decline out-of-boundary requests by pointing at the documented limits
  instead of saying "it's on the roadmap".
