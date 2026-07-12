# Launch playbook

Updated 2026-07-12 for the general browser-agent direction. The rules this
playbook keeps from its predecessor: no hidden analytics, no fabricated
usage, no mass outreach, and no launching before the evidence gate passes.
What changed: distribution now concentrates into a 48-hour window (GitHub
trending is a velocity game), and validation happens with outside users
instead of internal pilots.

## Gate: the five launch conditions

The launch date is not set until all five pass in **one uncut screen
recording**:

1. The key-free path (Chrome built-in AI) shows first streamed tokens
   within 60 seconds of a cold page load.
2. Google connects in 3 clicks with no unverified-app warning screen
   (launch scopes are Non-sensitive `drive.file` only).
3. A real write to a real Google Sheet lands behind an exact-diff
   permission prompt.
4. An HTML artifact renders in-tab and downloads as one self-contained
   file.
5. Every error message shown along the way explains itself without
   internal vocabulary.

That recording, trimmed to 30–40 seconds, is the README hero GIF and the
launch-post demo. If it needs cuts or captions to be comprehensible, the
product is not ready.

## Pre-launch (starts now, runs in parallel)

- Participate genuinely in r/selfhosted and r/LocalLLaMA (9:1 rule,
  ~15 minutes daily) so launch posts survive moderation.
- Submit Google Sensitive-scope verification early; its 2–6 week lead time
  must not sit on the critical path.
- Seed readiness: line up the personal network for ~100–200 stars inside
  the first 24 hours (trending threshold for TypeScript is roughly
  100–300 stars/day).
- Keep weekly named releases with human-readable notes from now on; a
  silent version-bump stream reads as a ghost ship.

## Launch: one 48-hour window

- Show HN, Tuesday–Thursday 9am–12pm ET. Title names the thing plainly
  ("Show HN: a general AI agent that runs entirely in your browser tab —
  no server, no signup"). First comment: the honest pivot story, the
  architecture in three sentences, one stated limitation, and the key-free
  demo link. Reply to every comment in the first hours.
- Same window: one transparent self-post in r/selfhosted ("self-hosting
  with zero maintenance surface: fork → enable Pages → done") and a dev.to
  #showdev post. r/LocalLLaMA waits for the local-model release
  (Ollama/base-URL support) so that post has its own genuine hook.
- Product Hunt is skipped or treated as a day-two checkbox.
- Launch-day scope set is frozen to Non-sensitive; the 100-user cap must
  be unhittable during the spike.

## Post-launch: eight weeks of visible artifacts

One per week, each a release or a post someone can use: Slack full flow,
the curated browser-reachable MCP list, MCP-by-URL with CORS diagnostics,
Calendar unlock (post-verification), user-key search APIs, Ollama support,
Pyodide heavy sandbox, plus rough unedited 2-minute screen recordings.
Submit to awesome-lists and OSS newsletters in week 2, after the README
has survived first contact.

## Evidence, not vanity

- Success signals, in order: first stranger-authored issue; first external
  PR; strangers completing the Google-connect funnel without help;
  side-by-side eval runs inside the parity boundary not losing to
  ChatGPT/Claude on the same tasks.
- Failure signals acted on, not explained away: launch conditions needing
  retakes, all issues still self-authored after Phase 2, or weekly cadence
  breaking four weeks straight — see the kill conditions in
  [plan.md](plan.md).
- Measurement stays analytics-free: GitHub Insights, issue/PR provenance,
  and user-shared reports only.
