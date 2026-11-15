# Conversation-first product direction

Status: canonical UX direction
Updated: 2026-11-15

WasmHatch is built for **developers and prosumers** who value a zero-server,
DevTools-verifiable browser runtime — while insisting on **warmth and plain
human language** at every touchpoint ("hardcore architecture, friendly desk").
It is neither a spreadsheet utility nor a developer ops console: the product
is understood through the everyday outcomes a person can finish in one tab,
solo with Pip or alongside a tiny team of pixel-art **hatchlings**.

## Product promise

> Ask in plain words. Watch it happen. Keep it or undo it in one click.

The primary interaction is a calm conversation. A person opens the tab, sees
immediately that no WasmHatch server sits in the middle (bring an API key,
point at local Ollama, or use Chrome's built-in AI), drops in files or
connects a tool when helpful, watches every tool call and file diff land live,
and reverts anything in one click — or switches on Careful mode to approve
writes first.

## UX rules

1. **Hardcore underneath, warm on screen.** Architecture wins trust when
   curious users inspect DevTools or the repo, not by printing words like
   `OPFS`, `QuickJS`, `Wasm`, `sandbox`, `manifest`, or `CSP` in the UI.
   Explain guarantees in plain outcomes ("runs local code on your machine",
   "goes straight from your browser to the provider you chose").
2. **Be upfront about keys and local AI.** Developers and prosumers appreciate
   honesty: state clearly that WasmHatch runs with their API key, local
   Ollama, or Chrome's built-in AI because there is no WasmHatch server.
3. **Keep one obvious next action.** The normal entry is the chat composer,
   paired with zero-ceremony starter actions (*Add a sample spreadsheet*,
   *Try an HTML report prompt*) so first contact works in seconds.
4. **Make multi-agent approachable.** The Hatchlings office turns isolated
   per-agent workspaces, scoped tool permissions, and tab-open scheduled check-ins
   into something tactile and friendly: pixel chicks at desks, one-click
   specialist presets (*Data wrangler*, *Report builder*, *Desk runner*), a
   shared ticket board, and shareable `.agent` files.
5. **Trust through visibility, not pop-up fatigue.** Autonomous ("Fast") mode
   is the default because every workspace edit records its exact before/after
   diff with one-click revert. Careful mode remains one toggle away whenever
   explicit write approval is wanted.
6. **State limits out loud.** Only capabilities shipped and bounded by code
   appear as actions; anything outside the browser-tab boundary (tab-closed
   background daemons, unverified Google scopes, arbitrary origins) is stated
   plainly rather than papered over.

## Current surfaces

- `/` (`src/pages/BusinessLandingPage.tsx`) — the public landing page in all
  18 supported UI languages. Introduces the zero-server promise, interactive
  Hatchlings showcase, BYOK / Ollama / Chrome AI options, 30-second GitHub
  Pages forkability, and direct entry into the workspace.
- `?view=chat` (`src/pages/ChatPage.tsx`) — the primary product surface:
  streaming multi-provider chat, Hatchlings pixel office and specialist
  presets, shared ticket board, side-by-side HTML artifact preview, Google
  Picker / Docs / Sheets / Slides, Slack, cited web search, loopback MCP,
  `.agent` import/export, and run journal export.

## Acceptance checks for UX changes

- No banned internal jargon (`wasm` outside `WasmHatch`, `quickjs`, `sandbox`,
  `manifest`, `opfs`, `csp`) appears in landing-page copy across locales.
- Every new UI string is wrapped in Lingui macros and translated across all
  supported catalogs (`npm run i18n:check`).
- Desktop and `390×844` mobile viewports have zero horizontal overflow
  (`scrollWidth === 390`).
- Every write surfaces an exact diff with one-click revert in Fast mode and
  explicit approval in Careful mode.
