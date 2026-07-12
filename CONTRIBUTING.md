# Contributing to WasmHatch

Thanks for helping make browser-native business automation inspectable,
permissioned, and useful in real workflows.

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

Current labeled newcomer lanes target the Business Operator. Closed issues for
the retained coding workspace are historical context, not active contribution
requests. Good first issues must be reproducible with bundled synthetic data and
must preserve the same sandbox and review-before-write boundaries used in the
public demos.

## Before opening a pull request

1. Open or find an issue for non-trivial changes.
2. Keep the change focused on one observable outcome.
3. Avoid adding a runtime dependency without documenting its license, network
   behavior, browser support, bundle cost, and self-hosting implications.
4. Do not weaken review-before-write behavior or persist provider credentials.

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

WasmHatch favors a small, visible business workflow over connector count or
general automation-server parity. Prefer improvements that shorten the path from
a bounded source to a reviewable local or external effect. New connectors,
databases, background execution, and broad abstractions require pilot evidence,
a credential boundary, conflict semantics, and a domain-specific review design.

Be respectful and follow the [Code of Conduct](CODE_OF_CONDUCT.md).
