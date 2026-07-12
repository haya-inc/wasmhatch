# Fork WasmHatch and run your own

WasmHatch is a static page: forking it gives you a complete, independent
deployment with zero servers to maintain. This guide covers the two hosted
paths, bringing your own Google client ID, and the two escape hatches for
locked-down Google Workspace organizations.

## The short version (GitHub Pages)

1. Fork `haya-inc/wasmhatch` **keeping the repository name `wasmhatch`**
   (the Pages build serves from `/wasmhatch/`; if you rename the fork, edit
   the `base` branch in `vite.config.ts` to match).
2. In your fork: **Settings → Actions → General**, allow workflows to run
   (GitHub disables them on new forks).
3. **Settings → Pages**, set *Source* to **GitHub Actions**.
4. Run the **Deploy project page** workflow (Actions tab → *Run workflow*),
   or push any commit to `main`.

Your assistant is now live at `https://<you>.github.io/wasmhatch/`. Every
push to `main` runs the unit suite and redeploys.

## Vercel instead

For a root-path deployment with the production headers, see
[deploy-vercel.md](deploy-vercel.md). The repository's `vercel.json` already
carries the security headers; `npm run build` is the build command.

## Bring your own Google client ID

Google tools (create Docs, Sheets, Slides) are off until a build provides
`VITE_GOOGLE_CLIENT_ID` — the same pattern rclone uses: every deployment
brings its own OAuth identity, so forks never share quota or trust with the
upstream app.

1. Create an OAuth **Web application** client in Google Cloud Console and
   add your deployment origin (for Pages,
   `https://<you>.github.io`) to *Authorized JavaScript origins* — details
   in [google-oauth.md](google-oauth.md).
2. On GitHub Pages: add a repository **variable** (not secret — client IDs
   are public identifiers) named `VITE_GOOGLE_CLIENT_ID` under
   **Settings → Secrets and variables → Actions → Variables**, then rerun
   the deploy workflow. On Vercel: set the same name as an environment
   variable.
3. Consent-screen verification is per client ID. An unverified client works
   for up to 100 test users you list yourself; public use without warning
   screens needs Google's verification of *your* client — see
   [google-oauth-verification.md](google-oauth-verification.md).

Everything else works with no configuration: the key-free Chrome path,
bring-your-own Claude/OpenAI keys, workspace, artifacts, and backups.

## Locked-down Google Workspace organizations

Two documented escape hatches when an admin policy blocks new OAuth apps:

- **Admin allowlist.** A Workspace admin allowlists your fork's client ID
  (Admin console → Security → API controls → App access control). Users
  then connect normally; scope stays `drive.file`, so the app still only
  touches files it created or was handed.
- **Internal fork.** Deploy the fork on the organization's own domain and
  mark the OAuth client **Internal**. Internal apps skip Google's public
  verification entirely and are visible only to that Workspace.

## Staying current

Upstream ships weekly named releases with human-readable notes. Use your
fork's **Sync fork** button (or merge the release tag), and read the release
notes for anything that changes connector origins: the content security
policy is a build-time audited allowlist (`vite.config.ts`,
`scripts/check-built-security.mjs`, `vercel.json` change together), and
`npm run build` fails if the built page drifts from it.

## What a fork inherits

- No server, no accounts, no analytics — there is nothing to operate.
- The same security posture: strict page policy, sandboxed artifacts,
  credential-shaped paths excluded from AI file listings.
- Apache-2.0: rebrand, restrict, or extend it as you need.
