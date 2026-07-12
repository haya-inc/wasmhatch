# Deploying to Vercel (wasmhatch.com)

Decision 2026-07-12: the canonical deployment moves from GitHub Pages to
Vercel under the custom domain `wasmhatch.com`. The app stays a static
build — no server code — but Vercel gives it real response headers
(`Content-Security-Policy`, `frame-ancestors`, COOP/COEP), removes the
`/wasmhatch/` base-path split, and later hosts optional single-purpose
functions (e.g. Slack token exchange) if we ever choose to ship them.

`vercel.json` in the repo root already configures the build
(`npm run build` → `dist/`) and the headers. The header CSP mirrors the
build-time meta CSP (which stays, as defense in depth) and adds the
header-only directives GitHub Pages could not express.

## One-time setup (maintainer, ~15 minutes)

1. **Buy the domain**: Vercel Dashboard → Domains → search `wasmhatch.com`
   → buy. (All four TLD candidates were free on 2026-07-12; .com was
   chosen.)
2. **Create the project**: Dashboard → Add New → Project → import
   `haya-inc/wasmhatch` from GitHub. Framework preset: Vite. Leave build
   settings alone — `vercel.json` wins. Every push to `main` now deploys
   production; every PR gets a preview URL.
3. **Attach the domain**: Project → Settings → Domains → add
   `wasmhatch.com` (and `www.wasmhatch.com` → redirect to apex). Since the
   domain is registered at Vercel, DNS wires itself.
4. **Search Console**: verify ownership of `wasmhatch.com` (DNS record —
   one click when the domain is on Vercel DNS) so the Google OAuth consent
   screen can reference it.
5. **OAuth client**: create the production Google OAuth Web client with
   `https://wasmhatch.com` as the authorized JavaScript origin, per
   [google-oauth-verification.md](google-oauth-verification.md). Do NOT
   reuse a client created for `haya-inc.github.io` — origins are part of
   the verified identity.

## Cutover order

1. Vercel deployment live at `wasmhatch.com` and smoke-tested (CSP header
   present: `curl -sI https://wasmhatch.com | grep -i content-security`).
2. README and repository metadata links point at `wasmhatch.com`.
3. GitHub Pages keeps serving `haya-inc.github.io/wasmhatch/` during the
   transition with a banner + canonical link, then `pages.yml`, the
   `build:pages` script, and the `github-pages` base-path branch in
   `vite.config.ts` are removed in one commit.

## Invariants

- The deployment remains static. Adding any serverless function is a
  product decision recorded in ROADMAP.md, never a silent convenience.
- The header CSP and the meta CSP must stay in sync; both are audited by
  `scripts/check-built-security.mjs` (meta) and this file's curl check
  (header). When a connector origin is added, it is added in both places
  in the same commit.
- `spikes/` and `workers/` are not part of the build output and must never
  be routable on the production domain.
