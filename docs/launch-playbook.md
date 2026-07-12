# Business pilot and OSS adoption playbook

This playbook turns WasmHatch from a working foundation into evidence-backed
open-source adoption. It avoids hidden analytics, fabricated usage, mass
outreach, and connector-count vanity metrics.

The legacy repository-to-patch registry in GitHub issue #9 is archived. Its
history remains useful for the retained surface, but it no longer accepts or
counts adoption evidence. Current public evidence belongs in business pilot
registry issue #12.

## Stage A: five Haya business pilots

The first gate is complete when:

- five real business workflows have been attempted;
- three reach an approved durable local or external effect;
- two are repeated by a pilot user in a later session;
- median task-to-reviewed-proposal time is under five minutes;
- at least one rejected proposal, stale conflict, or uncertain outcome is
  captured rather than silently retried;
- no credential appears in model messages, script input, storage, logs, or an
  exported run journal; and
- at least one post-P0 architecture candidate is promoted or rejected with a
  written alternative.

### Pilot selection

Choose five workflows, not five people clicking the same demo. Include at least
one local CSV/XLSX flow and one Google Sheets flow. Prefer bounded recurring
work where the result is easy for the domain owner to verify:

1. Normalize a weekly pipeline or operational tracker.
2. Turn a selected export into a reviewed Markdown or CSV report.
3. Reconcile two extracts and publish only the exceptions or approved updates.
4. Convert source data into a schedule proposal without creating calendar
   events yet.
5. Produce a repeatable weekly summary with its script and output artifact.

Use sampled, anonymized, or synthetic data when the real data is not appropriate
for a browser BYOK alpha. Do not paste customer data, credentials, private file
links, or exported journals into Slack.

### Session protocol

1. The pilot owner states the desired business outcome and how they currently
   verify it.
2. The facilitator records the start time and source kind, then lets the owner
   operate the product whenever possible.
3. The owner inspects any local workspace preview and explicit AI attachment,
   chooses table-transform or artifact-output mode, then inspects the AI plan,
   generated script, output path/type, and exact effect preview.
4. The owner approves or rejects based on business correctness—not because the
   facilitator expects a successful demo.
5. The owner explicitly exports the run journal if they consent to sharing its
   metadata with the project team.
6. Record corrections, first blocker, trust concerns, and whether the output was
   useful. The journal supplies event timing; human observations remain separate.
7. Ask for a repeat only after the first workflow is useful. A second session is
   evidence of repeatability, not a scripted acceptance test.

Use [the pilot evidence template](pilot-evidence-template.md). Store completed
internal records in the approved Haya system, not in this public repository.

### Architecture gate

After each session, classify missing capability without immediately committing
to a connector:

- workspace/recovery;
- tabular operation;
- document access;
- calendar proposal;
- task-system proposal;
- local SQL/large-data analysis;
- background/server requirement;
- review or conflict semantics; or
- model/tool quality.

Promote a candidate only when repeated workflow evidence names the same missing
boundary. The decision record must include demand, requested scopes,
browser/server feasibility, review design, conflict model, bundle/runtime cost,
rejected alternative, and an exit condition.

## Stage B: public operator pilots

Begin public recruitment only after the local demo, CSV/XLSX import/export,
bounded workspace preview/attachment, reviewed workspace export/restore, and
run-journal export are working on the public project page. Recruit individual
operators or maintainers who already handle a suitable bounded workflow; do not
send bulk messages.

Use this message as a starting point and personalize it:

> I’m testing WasmHatch, an Apache-2.0 browser-native AI operator for bounded
> spreadsheet work. It can import CSV/XLSX without an account, run generated
> JavaScript in a QuickJS Wasm Worker, and stop at an exact cell or file diff.
> Would you try one real 10-minute workflow and tell me where the data boundary,
> review, or handoff fails? Successful and rejected runs are equally useful.
>
> Project: https://haya-inc.github.io/wasmhatch/
> Source: https://github.com/haya-inc/wasmhatch

Ask permission before publishing a workflow summary. Never upload a pilot's
source artifact or run journal. A public report should contain only the workflow
shape, source kind, result, timing totals, first blocker, and links the reporter
already chose to make public.

Opt-in sanitized reports use the
[public pilot report form](https://github.com/haya-inc/wasmhatch/issues/new?template=pilot_report.yml).
The guided demo can copy a source-free aggregate summary for that form. The
[business operator pilot registry issue #12](https://github.com/haya-inc/wasmhatch/issues/12)
indexes notable reports and architecture decisions.

## Stage C: OSS contribution loop

The contribution surface should follow the product architecture. Prefer focused
issues for:

- connector manifests, fixtures, and typed effect schemas;
- sandbox conformance and adversarial boundary tests;
- artifact codecs and safe export formats;
- recovery, export, and restore fixtures;
- redaction and model-egress tests;
- example workflow manifests with deterministic sample data; and
- accessibility and internationalization of approval surfaces.

Keep at least three unclaimed tasks with independent acceptance criteria. Do not
publish issues that require private credentials, undocumented Haya context, or
access to a hosted service. A new contributor must be able to validate a change
locally with `npm test`, `npm run build`, and the relevant E2E test.

## Public launch gate

A broad launch is warranted only when:

- Stage A has passed;
- at least three public operators have tried a real non-demo workflow;
- the project can show one rejection or conflict as a safety success;
- a fresh browser can complete the local-file path without an account or key;
- the maintainer can respond to security and data-loss reports; and
- the project page accurately distinguishes shipped, pilot-gated, and research
  capabilities.

Use one community where the maintainer already participates. Post once, answer
questions directly, and do not coordinate votes or duplicate comments. The
launch message should state the hard boundary: WasmHatch is foreground-only,
does not persist OAuth tokens, does not run a host shell, and does not perform
unreviewed writes.

## Response loop

For seven days after each public post:

1. Acknowledge reproducible security, data-loss, and incorrect-effect reports
   within one working day.
2. Turn confirmed defects into focused issues without copying private business
   data.
3. Prioritize any blocker seen twice, and any credential exposure, silent data
   loss, or wrong-target write seen once.
4. Publish a minimal sanitized reproduction and regression test when fixed.
5. Keep roadmap promotions tied to repeated workflows rather than request count.

## Stop conditions

Pause pilot distribution immediately for confirmed credential persistence or
egress, silent workspace loss, incorrect proposal identity, wrong-target write,
sandbox escape, or an import-validation bypass. Document the mitigation and add
a regression test before resuming.

Do not broaden the product into a general automation server, cloud IDE, or
connector marketplace to make a launch look larger. The differentiator is a
small, inspectable foreground runtime with explicit effects.
