# Hatchlings — a swarm of small agents in one tab

Status: accepted · Owner decision 2026-07-22 · Implementation tracked in ROADMAP.md

## Vision

WasmHatch grows from one chat thread into a small swarm of agents —
**hatchlings** — that keep doing useful work for as long as the tab is open.
Each hatchling has its own name, its own isolated workspace, and its own
thread of conversation. They share one ticket board (a lightweight work
queue), can be put on an interval loop ("check the board every 10 minutes"),
and can reach outside systems through MCP servers. A pixel-art office
visualizes the swarm: every hatchling is a small character at a desk, and
what it is doing right now is readable at a glance.

The form-factor promise does not change: no server, no account, no install.
Everything below runs inside the static page.

## Decisions (settled)

1. **CSP stays a build-time audited allowlist. No wildcard relaxation.**
   MCP endpoints join the same registry pattern as model providers: the
   origins in `connect-src` are generated from an audited registry at build
   time. Out of the box that means loopback MCP servers
   (`http://localhost:*` / `http://127.0.0.1:*` — Streamable HTTP, e.g. any
   stdio server behind a local proxy) plus any remote MCP origins a
   deployment bakes in via `VITE_EXTRA_MCP_SERVERS`. A user of the hosted
   site cannot point the page at an arbitrary remote origin at runtime —
   that is the same posture as CONTRIBUTING.md's "connector origins stay a
   build-time audited allowlist, never a blanket relaxation."

2. **Loops run only while the tab is open, and say so.**
   The scheduler is an in-tab interval (minimum 1 minute) driven by a Web
   Worker timer so background-tab throttling of main-thread timers does not
   stall it; a frozen or closed tab still stops everything. Copy never
   claims background execution. Guardrails, all mandatory:
   - a cumulative auto-run cap per hatchling (default 20 runs; the user can
     raise or reset it — soft-budget philosophy, visible, never hidden);
   - exponential backoff on consecutive failures, and the schedule turns
     itself off after 4 consecutive failures with a visible notice;
   - scheduled runs execute only in autonomous mode (careful mode has a
     human in the loop by definition, and nobody is there to approve);
   - one global "pause all" switch.

3. **Every hatchling works in its own workspace.** Thread = workspace pair
   (working tree + revert baseline) = character. No shared working tree, so
   there is no cross-agent write conflict by construction (the same reason
   coding agents use git worktrees, without needing git). The existing
   single workspace becomes hatchling `main`, so nothing an existing user
   stored moves or changes meaning. The shared surfaces are the ticket
   board and the chat-visible artifacts.

4. **Tickets are a work queue, not a project-management product.**
   Statuses: `todo / doing / done / blocked`. A ticket has a title, detail,
   optional assignee (a hatchling), and a latest note. Users manage them in
   a side panel; hatchlings manage them through three tools
   (`list_tickets`, `create_ticket`, `update_ticket`). The default loop
   prompt is "check the board, claim what's ready, do it, write down what
   you did."

5. **The office is decorative supplement, not the only surface.** The
   pixel office is canvas-drawn, dependency-free, and mirrors state that is
   also available as text (status list, transcript). Screen readers get the
   text; the canvas carries an aria-label summary.

6. **Transcripts move to OPFS.** localStorage held one thread under a 1 MB
   cap; several concurrent threads would blow the origin's localStorage
   budget. Per-thread transcripts persist under the OPFS meta directory
   with the same drop-whole-oldest-turns trimming, falling back to
   localStorage where OPFS is unavailable.

## Architecture

New modules, all under `src/lib/` unless noted:

| Module | Responsibility |
| --- | --- |
| `opfs-kv.ts` | Tiny async text store on OPFS (`wasmhatch-meta/`), localStorage fallback. Shared by threads registry, transcripts, tickets. |
| `agent-threads.ts` | Hatchling registry: id, name, sprite species, per-thread schedule config. Migration: absent registry ⇒ one `main` hatchling over the legacy workspace roots. |
| `workspace.ts` | (extended) Root names become parameters; `main` keeps the legacy roots, new threads get `wasmhatch-ws-<id>` / `wasmhatch-bl-<id>`. |
| `chat-transcript-store.ts` | (extended) Same trim semantics, now per-thread and async over `opfs-kv`; one-time migration of the legacy localStorage thread into `main`. |
| `tickets.ts` | Ticket board: pure ops + async store + agent tools + change events. Single writer queue per tab (ops are serialized) so concurrent hatchlings cannot lose updates. |
| `agent-scheduler.ts` | Pure schedule math (due/next-run/backoff) + the worker-driven ticker. |
| `scheduler-tick.worker.ts` | `setInterval(postMessage)` heartbeat that keeps ticking in a hidden tab. |
| `mcp-servers.ts` | MCP server registry (loopback built-in + `VITE_EXTRA_MCP_SERVERS`), feeds the CSP `connect-src` list exactly like `chat-providers.ts`. |
| `mcp-client.ts` | Minimal Streamable-HTTP MCP client: `initialize` / `tools/list` / `tools/call`, JSON or SSE responses, session header handling. Tools surface to the loop as `mcp_<server>_<tool>`; results are data, never instructions. |
| `agent-session.ts` | The swarm runtime: per-hatchling state (workspace, permissions, transcript, run loop, mood), shared ticket board and MCP connections, scheduler wiring, subscribe/snapshot for React. |
| `pixel-office.ts` | Sprite sheets + office layout + canvas renderer (pure data in, pixels out). |
| `src/pages/HatchlingOffice.tsx` | Canvas component: renders the office, forwards clicks to select a hatchling. |

`ChatPage.tsx` becomes a view over `agent-session.ts`: the transcript and
composer show the selected hatchling; the sidebar gains Hatchlings, Tickets,
and MCP panels. Provider/key/model settings stay page-level and are read at
run start, shared by every hatchling.

## Safety model (unchanged rules, wider surface)

- Writes remain visible-diff + one-click revert per hatchling; careful mode
  still gates manual runs. Protected credential paths stay invisible.
- Scheduled runs are autonomous-only and never prompt; anything requiring
  an approval simply is not reachable in a scheduled run.
- MCP tool results and ticket contents are data, never instructions — the
  same framing the system prompt already applies to files and tool output.
- MCP bearer tokens follow the API-key rule: tab memory by default, and
  they are sent only to the server the user configured.
- Budgets stay soft and visible: per-run loop budgets are unchanged; the
  scheduler adds a cumulative auto-run cap the user can see and raise.

## Honest limits (must stay in copy)

- Hatchlings work **only while the tab is open**. Closing the tab, the
  browser deciding to freeze the page, or the machine sleeping stops them.
- Interval minimum is 1 minute; ticks can arrive late under throttling —
  the loop is late-tolerant polling, not a real-time cron.
- Remote MCP servers must both allow browser CORS and be baked into the
  deployment's allowlist. Out of the box, MCP means local servers.

## Delivery order

1. Thread foundation (registry + per-thread workspaces + transcript move)
2. Ticket board + tools
3. Scheduler (worker ticker + guardrails + UI)
4. MCP client + registry + CSP wiring
5. Session manager + ChatPage integration
6. Pixel office
