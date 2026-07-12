# WasmHatch product plan

Updated 2026-07-12. This replaces the earlier "business operator wedge" plan
in full; the roadmap of record is [ROADMAP.md](../ROADMAP.md).

## Thesis

WasmHatch is a general AI agent that runs entirely in a browser tab from a
static page. The differentiation is the form factor — no server, no Docker,
no install, no account, keys and tokens never leave the tab — not a claim of
novel capability. Features imitate the incumbent agent UX (ChatGPT with
connectors, Claude with connectors and Artifacts) and the commitment is
**not losing inside an advertised boundary**.

Three product values, in order:

1. **Connectivity that sets up easily.** Google Drive/Sheets/Docs/Slides
   through foreground OAuth and per-file Picker consent; Calendar once
   Sensitive verification clears; Slack through a webhook first and a guided
   internal-app flow next. Setup friction is measured in clicks and minutes,
   and every connector states its limits up front.
2. **Documents made in front of you.** Self-contained single-file HTML
   artifacts (reports, dashboards, slide decks) rendered in-tab in a
   sandboxed frame, downloadable, printable to PDF.
3. **A trustworthy default posture.** Everything runs foreground, writes
   stop at an exact diff behind a permission prompt (allow / always-allow /
   reject), generated code executes in the Wasm sandbox, and tokens are
   held memory-only behind the credential broker. These are quiet defaults
   like an editor's undo — load-bearing, not the headline.

## The parity boundary

"Not losing" is promised only inside this boundary, and the boundary is
advertised in the README rather than discovered by users:

- Foreground, minutes-scale, single-session work.
- Google files the user handed over via Picker or the agent created
  (drive.file scope) — read, analyze, write behind diffs, create new.
- Uploaded CSV/XLSX processed in-tab; sandboxed data transforms.
- One-file HTML artifacts on par with incumbent artifact features.
- Slack posting via webhook; reading/search with the user's own internal
  app token.
- BYOK streaming chat across Anthropic / OpenAI-compatible providers, plus
  the key-free Chrome built-in AI path on supported desktops.

Outside the boundary (stated, not hidden): whole-Drive listing or search,
Calendar until verification, arbitrary web browsing, background or
long-running autonomous jobs, MCP servers that do not opt into browser
origins, admin-managed Google Workspace accounts.

## Who it is for

Launch persona: developers and prosumers with a personal Google account and
their own API key — the Show HN / r/selfhosted / r/LocalLLaMA audience,
including people tired of maintaining Docker stacks for chat UIs. Keyless
consumers and admin-managed Workspace accounts are explicitly not the launch
target; the Chrome built-in AI path is the bridge for first contact.

## What carries over from the previous plan

- The security substrate: GIS foreground OAuth, credential broker, QuickJS
  Wasm sandbox, OPFS workspace, exact-diff previews with conflict recheck,
  protected credential paths. These are the technical proof behind the
  privacy claims.
- Evidence-gated discipline: capabilities are claimed only after they pass
  an uncut end-to-end run; launch waits for the five conditions in
  ROADMAP.md.
- Honest-limitations practice, now applied to the parity boundary itself.

What is retired: the spreadsheet-wedge GTM (pilot registries, pilot report
forms, operator ceremony vocabulary), the one-proposal-per-run and
six-call agent ceilings, and the coding-workspace surface as a product
(its history remains in git).

## Kill conditions

The direction is re-examined, with the same discipline the previous plan
applied to its wedge, if by the end of Phase 2:

- no stranger-authored issue or PR has arrived, or
- the five launch conditions cannot pass in one uncut take, or
- weekly-artifact cadence breaks for four consecutive weeks because
  platform constraints (CORS, OAuth policy, CSP) consume the solo
  maintainer's entire budget.

## Related documents

- [ROADMAP.md](../ROADMAP.md) — phases, exit conditions, standing rules.
- [agent-loop-design.md](agent-loop-design.md) — unified streaming loop.
- [landscape.md](landscape.md) — competitive map and the open niche.
- [launch-playbook.md](launch-playbook.md) — launch mechanics and cadence.
- [google-oauth-verification.md](google-oauth-verification.md) — scope
  verification package.
- [distribution.md](distribution.md) — deployment and packaging policy.
