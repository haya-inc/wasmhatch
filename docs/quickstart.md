# WasmHatch quickstart

The fastest way to understand WasmHatch is the key-free local loop. It runs in
the browser, makes no network request, and stops before a durable change.

## 60-second local demo

Open the [guided local demo](https://haya-inc.github.io/wasmhatch/?view=operator&demo=local).

1. Select **Run bounded transform**. The preset synchronous function executes in
   the QuickJS Wasm Worker against the four copied demo rows.
2. Inspect the 12 typed before/after cells. The working data is still unchanged.
3. Select **Approve and apply locally**, or reject the proposal. Approval changes
   only the in-tab demo state.

No account, API key, OAuth client, upload, or server is involved. The guide is a
product walkthrough, not an authorization shortcut: script execution and effect
approval remain separate actions. On a narrow screen, the current source remains
visible while connector and credential settings stay collapsed behind
**Change** until needed.

## Invoice reconciliation sample

Open the [guided reconciliation sample](https://haya-inc.github.io/wasmhatch/?view=operator&demo=reconciliation).

1. Review the bundled synthetic ERP and payout values. One invoice differs and
   one payout is missing.
2. Select **Run bounded transform**. QuickJS derives only the variance and status
   fields; source identifiers and amounts remain unchanged.
3. Inspect the seven typed changes, including `REVIEW` and `MISSING`, then approve
   or reject the local effect.

This path exercises the same snapshot, sandbox, immutable proposal, approval,
and source-free pilot-report boundaries as the normalization demo. It makes no
network request and contains no real invoice or customer data.

## Try a local workbook

1. Select **CSV / XLSX** and choose a bounded workbook.
2. Review the detected sheet, dimensions, source hash, formula count, external
   link count, and warnings.
3. Edit or run the local transformation script.
4. Review the typed cell proposal before applying it to the working snapshot.
5. Export a safe CSV/value-only XLSX, or save a manifest-bound workspace output.

The source workbook bytes are parsed in a Worker and are not retained in the
Operator workspace. Macros are rejected, formulas do not execute, and generated
scripts receive copied values rather than browser or connector capabilities.

## Try the Google Sheets artifact loop

This path requires a Google OAuth Web client ID configured for the deployment
origin and a memory-only OpenAI API key.

1. Connect Google Sheets and load one exact range.
2. Confirm **AI read grant ready** for the displayed range.
3. Choose **Artifact output**, enter the task, and start the AI plan.
4. If requested, the host re-reads only that range and materializes a
   credential-free content-addressed JSON input.
5. Review the generated script and output identity, run it in QuickJS, inspect
   the file diff, and approve or reject the exact output.

The model never receives the OAuth token or provider spreadsheet ID. See the
[Google Sheets workspace snapshot contract](google-sheets-workspace-snapshots.md)
for the complete authority and stale-state rules.

## Pilot evidence

After the guided demo commits, select **Copy pilot report**. WasmHatch derives a
Markdown summary from aggregate run metrics only; it excludes source rows, task
text, resource identifiers, and the run ID. Inspect the copied text, add only
feedback you choose, then open the
[sanitized pilot report form](https://github.com/haya-inc/wasmhatch/issues/new?template=pilot_report.yml).

For a real consented workflow, export the private run journal only to the
approved internal system and record the result with the
[pilot evidence template](pilot-evidence-template.md). Public sanitized results
are indexed from [pilot registry issue #12](https://github.com/haya-inc/wasmhatch/issues/12).
