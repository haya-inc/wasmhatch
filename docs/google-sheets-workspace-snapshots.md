# Google Sheets workspace snapshots

- Contract status: foreground implementation in WasmHatch 0.26.0
- Connector authority: one user-loaded spreadsheet/range target
- Planner authority: one strict zero-argument read tool
- Durable local result: one credential-free content-addressed JSON input

This contract connects the Google Sheets connector to the same typed artifact
workflow used by local files. It does not give the model a general Sheets API
client. The host retains the provider resource ID and OAuth token, re-reads only
the target already selected by the user, and materializes a portable snapshot
before the model can propose a script.

## Checkpoint sequence

1. The user connects Google Sheets and explicitly reads one spreadsheet/range.
2. The Operator shows an **AI read grant ready** state for that exact range.
3. In Artifact output mode, the planner may call
   `read_google_sheets_range` with an empty argument object. There is no
   model-selected spreadsheet ID, range, scope, operation, or URL.
4. The host checks the current authority epoch, binds the credential broker to
   `read-range` and the exact spreadsheet path parameter, and performs one fresh
   GET. The connector still never receives token text.
5. The host validates the response, hashes the spreadsheet ID, serializes the
   snapshot, writes it under `inputs/`, and re-reads its bytes and SHA-256.
6. The model receives a bounded row preview plus the range, connector version,
   workspace path, virtual mount, dimensions, and snapshot SHA-256. It never
   receives the spreadsheet ID or OAuth token.
7. A typed artifact plan binds the materialized snapshot as an exact input.
   QuickJS later reads only its copied virtual mount. Script execution, output
   diff review, and durable output approval remain separate checkpoints.

The snapshot write is an explicit consequence of the foreground connector-read
grant, not an artifact-output approval. If planning stops afterward, the input
snapshot remains visible and exportable in the Operator workspace. No external
write occurs.

## Snapshot schema

The exact JSON shape is:

```json
{
  "schema": "wasmhatch.google-sheets-snapshot.v1",
  "connector": {
    "id": "google-sheets",
    "version": "1.0.0"
  },
  "target": {
    "spreadsheetIdSha256": "sha256:<64 lower-case hex characters>",
    "range": "Pipeline!A1:D20"
  },
  "rows": [["Owner", "Amount"], ["Aya", 1200]]
}
```

Unknown or missing fields, unsupported connector versions, malformed hashes,
invalid ranges, non-JSON spreadsheet values, more than 5,000 rows, or more than
200 columns fail closed. The canonical file name is derived from the serialized
content hash:

```text
inputs/google-sheets-<last 12 SHA-256 hex characters>.json
```

The whole AI-attachable artifact is limited to 512 KB. Model egress remains
independently bounded: at most 200 rows are previewed, long string cells are
truncated in the preview, the serialized result is capped at 64 KB, and the
full validated snapshot stays local for the later sandbox run.

## Authority and stale-state rules

- Editing the spreadsheet ID or range cancels planning and invalidates the
  loaded target until the user reads it again.
- Switching or revoking Google authority cancels the grant.
- The host rejects a provider response whose spreadsheet ID or normalized range
  differs from the bound target.
- The workspace agent rehashes the materialized file before sending its preview.
- The artifact workflow rehashes every input before QuickJS execution.
- The file-effect protocol rechecks the output base before an approved write.

The run journal records the connector/version, range, dimensions, local path,
bytes, and SHA-256. It excludes the provider resource ID, OAuth token, OpenAI
key, and source contents.

## Non-goals

- background refresh or reads after the tab closes;
- model-selected ranges or arbitrary Sheets URLs;
- connector writes from the planner tool loop;
- credentials, live OPFS, DOM, or network access inside QuickJS;
- treating the snapshot write as approval of a generated output; and
- generalizing this target-specific contract into one broad Microsoft Graph or
  Google Workspace connector.
