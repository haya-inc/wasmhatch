# WasmHatch quickstart

The fastest way to understand WasmHatch is the key-free local loop. It runs in
the browser, makes no network request, and stops before a durable change.

## 60-second local demo

Open the [guided local demo](https://haya-inc.github.io/wasmhatch/?view=work&demo=local).

1. Select **Prepare changes**. The preset synchronous function executes in
   the QuickJS Wasm Worker against the four copied demo rows.
2. Activity opens automatically. Inspect the 12 typed before/after cells. The
   working data is still unchanged.
3. Select **Approve and apply locally**, or reject the proposal. Approval changes
   only the in-tab demo state.
4. Copy the source-free result shown in the conversation and, if you choose,
   open the public feedback form.

No account, API key, OAuth client, upload, or server is involved. The guide is a
product walkthrough, not an authorization shortcut: script execution and effect
approval remain separate actions. On a narrow screen, the current source remains
visible while connector and credential settings stay collapsed behind
**Change** until needed.

## Invoice reconciliation sample

Open the [guided reconciliation sample](https://haya-inc.github.io/wasmhatch/?view=work&demo=reconciliation).

1. Review the bundled synthetic ERP and payout values. One invoice differs and
   one payout is missing.
2. Select **Prepare changes**. QuickJS derives only the variance and status
   fields; source identifiers and amounts remain unchanged.
3. Inspect the seven typed changes, including `REVIEW` and `MISSING`, then approve
   or reject the local effect.

This path exercises the same snapshot, sandbox, immutable proposal, approval,
and source-free pilot-report boundaries as the normalization demo. It makes no
network request and contains no real invoice or customer data.

## Weekly brief to report sample

Open the [guided report sample](https://haya-inc.github.io/wasmhatch/?view=work&example=report).

1. Read the bundled synthetic Markdown operations brief in the conversation.
2. Inspect the already-staged deterministic artifact plan and expand **View
   execution details** if you want to read its script.
3. Select **Prepare file**. The script reads one exact copied Markdown input in
   QuickJS and writes one transient Markdown decision report.
4. Inspect the unified file diff in Activity, then approve or reject it.
5. Copy the source-free result from the conversation if you want to share
   feedback.

No spreadsheet, account, API key, OAuth, upload, or WasmHatch server is involved.
The sample proves that the workspace and effect model applies to ordinary text
artifacts as well as tables; it does not count as a real business pilot.

## Try a local workbook

Open the [real-file entry](https://haya-inc.github.io/wasmhatch/?view=work&start=upload)
to start with the local source picker instead of a synthetic demo.

1. Select **CSV / XLSX** and choose a bounded workbook. If you do not have a
   suitable file ready, select **Load sample CSV** first. The bundled four-row
   file goes through the same CSV import Worker, normalized workspace snapshot,
   QuickJS sandbox, typed review, and safe export path as a user-selected CSV.
2. Review the detected sheet, dimensions, source hash, formula count, external
   link count, and warnings.
3. On a compatible Chrome desktop, keep **Chrome built-in AI** selected under
   **Context**, enter the task, and choose **Ask WasmHatch**. Chrome may first download its
   model, but the task and rows stay on the device. On other browsers, select
   the OpenAI session planner or edit the script manually.
4. Expand **View execution details** if you want to inspect or edit the staged
   script, then prepare the changes in the QuickJS Wasm Worker.
5. Review the typed cell proposal before applying it to the working snapshot.
6. Export a safe CSV/value-only XLSX, or save a manifest-bound workspace output.

The source workbook bytes are parsed in a Worker and are not retained in the
Operator workspace. Macros are rejected, formulas do not execute, and generated
scripts receive copied values rather than browser or connector capabilities.
The bundled CSV is synthetic onboarding evidence, not a real business pilot;
replace it with an authorized sample or anonymized export before recording a
workflow toward the five-pilot gate.
The built-in planner currently handles only the active table; workspace
attachments and artifact-output planning still require the OpenAI bounded tool
loop. See [Chrome built-in AI planner](chrome-built-in-ai.md).

## Try the Google Sheets artifact loop

This path requires a Google OAuth Web client ID configured for the deployment
origin and a memory-only OpenAI API key.

1. Connect Google Sheets and load one exact range.
2. Confirm **AI read grant ready** for the displayed range.
3. Choose **Create a file**, enter the task, and start the AI plan.
4. If requested, the host re-reads only that range and materializes a
   credential-free content-addressed JSON input.
5. Review the generated script and output identity, run it in QuickJS, inspect
   the file diff, and approve or reject the exact output.

The model never receives the OAuth token or provider spreadsheet ID. See the
[Google Sheets workspace snapshot contract](google-sheets-workspace-snapshots.md)
for the complete authority and stale-state rules.

## Pilot evidence

After a guided demo, local CSV/XLSX workflow, or foreground Google Sheets
workflow commits—or you reject its proposal—select **Copy source-free result**
in the conversation. The same action remains available in **Activity** beside
**Export JSON**. WasmHatch derives a Markdown summary from
host-defined workflow metadata and aggregate run metrics only. It excludes
source rows, file names, sheet targets, task text, resource identifiers, and the
run ID. A rejected report states that no effect occurred from that proposal and
preserves the rejection as useful safety evidence. Starting new work expires
the action so an older result cannot be submitted as the current one. Inspect
the copied text, add only feedback you choose, then open the
[sanitized pilot report form](https://github.com/haya-inc/wasmhatch/issues/new?template=pilot_report.yml).

For deeper internal diagnosis, export the private run journal only to the
approved internal system and record the result with the [pilot evidence
template](pilot-evidence-template.md). Public sanitized results are indexed from
[pilot registry issue #12](https://github.com/haya-inc/wasmhatch/issues/12).
