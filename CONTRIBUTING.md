# Contributing to WasmHatch

Thanks for helping build a general AI assistant that runs entirely in a
browser tab — no server, no install, no signup. The form factor is the
product: keep setup at zero and keep every effect visible.

## Pick and claim a task

Start with an unclaimed [`good first issue`](https://github.com/haya-inc/wasmhatch/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
or a focused bug that can be reproduced with public or synthetic data. Before
editing:

1. Open the GitHub issue and read its acceptance criteria.
2. Comment **I’m working on this** to claim the lane.
3. If another contributor already claimed it, choose another open lane.
4. Confirm that the issue can be validated locally without private credentials
   or Haya-only context.

Claims with no update for seven days may be released so another contributor can continue.

Newcomer lanes target the chat surface (`src/pages/ChatPage.tsx`), the
provider-abstracted agent loop (`src/lib/agent-core/`), and the workspace
libraries under `src/lib/`. The Business Operator page is legacy — a parts
donor scheduled to retire — so changes land there only when they unblock the
chat surface. Good first issues must be reproducible with bundled synthetic
data, keep every write visible and revertible, and keep the opt-in Careful
mode working for people who prefer approvals.

## One-click development environment

Open or resume a browser-based environment with
[GitHub Codespaces](https://codespaces.new/haya-inc/wasmhatch?quickstart=1).
The repository pins Node 22 on Debian 12, installs the exact lockfile, and
installs Chromium plus its Linux dependencies for the Playwright suite. Start
the app with `npm run dev`; port 5173 opens in the forwarded preview.

Codespaces requires a GitHub account and consumes the contributor's own
Codespaces quota. It is an optional development environment, not a WasmHatch
runtime service. Local development remains fully supported.

## Before opening a pull request

1. Open or find an issue for non-trivial changes.
2. Keep the change focused on one observable outcome.
3. Avoid adding a runtime dependency without documenting its license, network
   behavior, browser support, bundle cost, and self-hosting implications.
4. Keep every write visible with its exact diff and revertible in one click,
   and keep the opt-in Careful mode gating writes for users who choose it.
5. Never store credentials beyond what the user explicitly opted into
   ("Remember on this device"); keys are sent only to the provider the user
   chose, never logged, and never shipped to any WasmHatch-operated service.

## Development

```bash
npm install
npm run dev
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm audit --audit-level=moderate
```

Application TypeScript uses `verbatimModuleSyntax`; import types with
`import type` so runtime module edges stay explicit. Vitest runs only
`src/**/*.test.{ts,tsx}` in the Node environment from `vitest.config.ts`.
Component tests that need a DOM must opt into an appropriate environment rather
than changing the global default.

React Compiler is intentionally not enabled. Add it only after profiling shows
a meaningful render bottleneck and the compiler change has focused browser
coverage; component size alone is not evidence of a runtime performance issue.

The Playwright browser install is required once per development machine. The
end-to-end suite builds the production app and verifies local demo, CSV/XLSX,
Google connector fixtures, workspace recovery, legacy task-to-patch, and
effect-review paths without calling live model or business providers.

The primary development target is current desktop Chromium. Responsive layouts
must also be checked at a narrow mobile viewport, even when a browser API is not
available there.

## Pull-request checklist

- [ ] The user-visible outcome is described.
- [ ] Tests cover new pure logic or security boundaries.
- [ ] `npm test` and `npm run build` pass.
- [ ] No API keys, workspace contents, or authorization headers are logged.
- [ ] New limits and failure states are visible to the user.
- [ ] Accessibility and keyboard behavior remain usable.

## Scope and design

WasmHatch competes on form factor: a general AI agent in a browser tab with
genuinely easy setup. Features follow the incumbent agents (chat, connectors,
artifacts) as closely as the platform allows; the commitment is not losing
inside an advertised boundary, so documented limits beat surprise gaps
(see [ROADMAP.md](ROADMAP.md)). Prefer improvements that keep setup at zero
(no server, no account), make connectivity genuinely easier (Google
Workspace, Slack), or make in-tab artifacts better. New connectors and broad
abstractions still need a credential boundary, conflict semantics, and a
visible failure story — and connector origins stay a build-time audited
allowlist, never a blanket relaxation.

Be respectful and follow the [Code of Conduct](CODE_OF_CONDUCT.md).
