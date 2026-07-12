# Landscape

Updated 2026-07-12. Facts below were verified against GitHub APIs, vendor
docs, and live CORS probes on this date; re-check quarterly.

WasmHatch's positioning: an open-source general AI agent that is **just a
static page** — no server, no Docker, BYOK, with real app connectors and
in-tab document creation. This file maps who else is near that spot.

## The incumbents whose UX we imitate

| Product | What sets the bar | Structural difference |
| --- | --- | --- |
| ChatGPT + connectors | Connector setup in a few clicks; drive/calendar/slack integrations; canvas documents | Cloud-side agent; data and tokens transit vendor servers; closed |
| Claude + connectors + Artifacts | MCP connector directory; artifacts rendered beside chat | Same: confidential-client OAuth on vendor infrastructure |
| Gemini in Workspace / Excel Copilot | Lives inside the target documents | Bound to one suite; nothing self-hostable |

The setup bar to match: connect Google in ~3 clicks, artifacts appear
in-tab. The claim they cannot match: nothing leaves the tab, verifiable
with DevTools, Apache-2.0.

## Server-required OSS chat/agent UIs (the Docker-fatigue pool)

| Project | Traction (2026-07) | Why users complain |
| --- | --- | --- |
| Open WebUI | ~145k stars | Docker/Python container required; license controversy ongoing |
| LibreChat | ~40k stars | Node + MongoDB + Meilisearch multi-service setup |
| LobeHub (LobeChat) | large, rebranding | Moving toward server-orchestrated multi-agent |
| AnythingLLM, Jan, Cherry Studio | significant | Desktop installs or servers |

These projects prove demand for self-hosted agent UIs; their maintenance
surface is the pain WasmHatch's static form factor removes ("fork → enable
Pages → done").

## Static/BYOK neighbors (closest to the niche)

| Project | Status | Gap versus WasmHatch's claim |
| --- | --- | --- |
| NextChat | ~88k stars, slowed | Static-deployable chat, but MCP/connectors are server-bound; one release away from squatting the niche |
| TypingMind | Closed-source, paid | Has static BYOK + connectors via its own relay; not OSS |
| BetterChatGPT, chatcraft.org, hollama | small–mid | Chat only: no connectors, no artifacts, no sandbox |

Conclusion from the 2026-07 sweep: **no established project combines
static-page deployment + real connectors + artifacts + sandboxed code
execution.** The niche is open; the moats that compound with calendar time
are (1) a verified Google OAuth client and (2) a curated list of
browser-reachable connectors/MCP servers. NextChat shipping in-page MCP is
the main preemption risk.

## Physics that shape the design

- Slack Web API: browser calls work only via form-encoded body-token
  requests (no Authorization header survives preflight; verified live).
  OAuth token exchange requires a client secret — impossible purely
  in-page; hence webhook → internal-app token → optional self-deployed
  relay, in that order.
- Google: drive.file + Picker is the no-verification lane; spreadsheets /
  documents / presentations / calendar are Sensitive (verification weeks);
  full drive is Restricted (CASA, ~$500–1,000/yr) — traction-gated.
- Remote MCP from a page: technically fine (Streamable HTTP + PKCE), but
  per-server CORS opt-in decides reachability; Google's and Slack's own MCP
  servers require confidential clients and are unreachable from a static
  page. Curated first-party connectors come first; "MCP by URL" is a lane,
  not the headline.
- WebMCP (Chrome origin trial) is the standards track where an in-tab agent
  is structurally the correct consumer; track it, demo when Chrome ships
  native support.
- In-tab artifacts: sandboxed iframe via srcdoc with allow-scripts and
  never allow-same-origin; script-executing artifacts eventually want a
  second origin (reserved: the wasmhatch-usercontent GitHub org, following
  the claudeusercontent.com naming pattern; a separate registrable domain
  is the endgame).

## Standing conclusions

- Do not compete on connector count, spreadsheet-agent depth (Shortcut,
  Endex, Copilot), or general automation-server parity (n8n, Windmill,
  Activepieces).
- Do not add a required server. The only server code ever shipped is a
  stateless template the user deploys.
- The browser-Wasm runtime references that informed the sandbox
  (QuickJS-emscripten today; Pyodide as the traction-gated heavy runner)
  remain valid and live in git history with the previous version of this
  file.
