# Contributing to WasmHatch

Thanks for helping remove setup friction from open-source contribution.

## Pick and claim a starter task

The project page publishes a [contribution board](https://haya-inc.github.io/wasmhatch/#contribute)
with revision-pinned `good first issue` tasks. Before editing:

1. Open the GitHub issue and read its acceptance criteria.
2. Comment **I’m working on this** to claim the lane.
3. If another contributor already claimed it, choose another open lane.
4. Use **Open task** to start from the pinned source, then export a patch for
   local checks and your pull request.

Claims with no update for seven days may be released so another contributor can continue.

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
npm audit --audit-level=moderate
```

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

WasmHatch favors a small vertical workflow over IDE feature parity. Prefer
improvements that shorten the path from repository link to exported patch.
Large abstractions, broad provider matrices, and command emulation should follow
measured user need.

Be respectful and follow the [Code of Conduct](CODE_OF_CONDUCT.md).
