# Zod compatibility security backport

WasmHatch installs the official `zod@4.6.7` package once. The lockfile override
deduplicates A2UI's Zod dependency to that installation. A2UI 0.15 uses the Zod 3
schema API, so Vite aliases its `zod` imports to `zod/v3`; TypeScript resolves
the same compatibility declarations. Direct Zod 4 APIs remain available at
`zod/v4`.

The native Zod 4 parser contains the upstream fix for
[CVE-2023-54404 / GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
The bundled Zod 3 compatibility parser still needs the same behavior, tracked
in [upstream issue 6653](https://github.com/colinhacks/zod/issues/6653). Using the
new package version alone would therefore leave the A2UI execution path exposed.

`scripts/patch-zod-v3.mjs` backports the early abort from
[upstream fix a0ebf97](https://github.com/colinhacks/zod/commit/a0ebf97):

- An oversized `array().max()` or `array().length()` returns `INVALID` before
  copying the input or parsing any element.
- An oversized `set().max()` or `set().size()` also aborts before iteration.
- A fixed tuple without a rest schema aborts before copying an oversized array.
- The existing `too_big` issue, path, custom message, and normal validation for
  inputs within the bound are preserved. Outer refinements do not run after
  the abort.

The patch applies to ESM, CommonJS, and the distributed TypeScript source. It
changes four return sites per file, keeps the package identity, version, and
license headers intact, and leaves the native Zod 4 parser unchanged. No audit
advisories are excluded and no package version is relabeled.

## Installation and build checks

The root `postinstall` applies the patch. Before any write, it checks the exact
package version and SHA-256 of every original file and verifies the expected
patched output. It also verifies the unchanged native Zod 4 parser hashes.
Reapplying an already reviewed patch is safe. Unknown content or a different
Zod version stops installation and requires review.

`build`, `build:pages`, and the unit-test lifecycle run the script with `--check`.
This mode only verifies the reviewed patched hashes; it never repairs files.
Consequently, an install that skipped lifecycle scripts cannot produce a
production bundle until the security patch is applied:

```sh
npm run patch:dependencies
```

Keep Zod exactly pinned while this backport is necessary. When updating Zod,
review the upstream compatibility implementation, rerun the security and A2UI
regression tests, and update or remove this patch and its hashes together.

## Scope

This backport rejects collections that exceed a schema's declared upper bound.
As with the upstream fix, it does not impose a new global limit on unbounded
containers. A2UI's input-boundary limits independently reject oversized text,
collections, deep structures, and excessive node counts before model or MCP
content enters the compiler or schema validator. Zod 3 maps have no native
`.max()`/`.size()` API and rely on these boundary limits.
