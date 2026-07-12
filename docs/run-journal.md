# Run journal and policy decision envelope

- Contract status: foreground implementation in WasmHatch 0.22.0
- Schema: `wasmhatch.run-journal.v1`
- Surface: Business Operator

The run journal turns one foreground business operation into portable evidence.
It joins source access, model and tool checkpoints, sandbox execution, policy
decisions, proposals, foreground review, conflicts, uncertain outcomes, commits,
and exports without copying source rows or file contents into the journal.

This is the canonical cross-adapter audit contract for the current operator. It
does not grant a capability and it is not an effect receipt. Proposal IDs,
policy-decision IDs, source hashes, and receipt IDs link the journal to the
contracts that independently authorize and execute work.

## Event model

Each event has a monotonically increasing sequence, wall-clock time, elapsed
milliseconds from the run start, category, outcome, short summary, bounded
detail, and scalar evidence fields.

Categories are deliberately adapter-neutral:

| Category | Examples |
| --- | --- |
| `source` | Local artifact import, Google Sheets range read |
| `model` | One-shot or checkpointed plan staged |
| `tool` | Exact-path list, read, search, or tabular window |
| `script` | QuickJS source saved or sandbox run completed |
| `policy` | Host policy permits proposal staging but not commit |
| `proposal` | Immutable spreadsheet or workspace-file proposal prepared |
| `approval` | Foreground user approves or rejects one proposal |
| `effect` | Commit, conflict, uncertain result, or terminal failure |
| `export` | Value artifact or journal export |

Outcomes include `prepared`, `approved`, `rejected`, `committed`, `conflict`,
`uncertain`, `failed`, and `cancelled`. A conflict or uncertain provider result
therefore remains visible even after its pending UI disappears.

## Policy decision envelope

Before an effect proposal is prepared, the host creates a bounded v1 envelope:

```json
{
  "schemaVersion": 1,
  "decisionId": "policy_decision_<random identity>",
  "policyId": "foreground-explicit-approval-v1",
  "capability": "spreadsheet.cells.update",
  "resource": "local-spreadsheet:local-demo:Demo!A1",
  "decision": "stage",
  "actor": "host-policy",
  "reason": "Allow an immutable proposal only...",
  "decidedAt": "2026-07-12T00:00:00.000Z"
}
```

The decision ID is bound into the effect proposal. `stage` means that the host
may construct a review surface; it never means approve or commit. The user's
later approval is a separate event and remains bound to the exact proposal ID.

## Pilot metrics

Metrics are derived from structured events rather than user-entered totals:

- elapsed run time;
- model events and bounded tool calls;
- completed sandbox runs;
- proposals prepared, approvals, rejections, commits, conflicts, uncertain
  outcomes, and failures;
- time to first reviewable proposal;
- time to first committed effect.

The first five pilots should attach the exported journal when appropriate and
record human observations separately: whether the result was correct, why a
proposal was rejected, what required manual correction, and whether the same
workflow was repeated. A journal proves what the product recorded; it does not
prove business correctness or user confidence by itself.

Guided synthetic workflows, local CSV/XLSX workflows, and foreground Google
Sheets workflows also expose a smaller public Markdown report. It accepts
either the latest committed effect or the latest explicit rejection, so
declining an unsafe or incorrect proposal remains first-class pilot evidence.
That report contains only workflow metadata defined by the host and aggregate
metrics; it excludes task text, source contents, file names, sheet targets,
resource identifiers, and run ID. The action expires when source, task, script,
or proposal context changes. It does not replace the private journal for an
authorized internal pilot.

## Privacy and limits

- Export is an explicit user action and produces a local JSON download.
- API keys, OAuth tokens, authorization headers, cookies, passwords, and
  credential-named evidence fields from application state are excluded or
  rejected.
- Common key, bearer-token, JWT, and OAuth-token shapes receive defensive text
  redaction before export.
- Task text and resource identities are included because they make the run
  interpretable. Users must still inspect the JSON before sharing it.
- Source rows, cell values, file contents, generated script source, OAuth
  credentials, and provider response bodies are not included.
- Each event is limited to 16 KB, evidence to 32 scalar fields, the run to 256
  events, and the serialized journal to 512 KB. Ordinary work cannot consume the
  last four event slots; they are reserved for a pending foreground review and
  its terminal effect outcome. Journal download remains available at the
  ordinary-event limit and omits only the self-referential export event when no
  ordinary slot remains.

The redactor is defense in depth, not a general secret scanner. Connector and
model code must continue to prevent credentials from entering errors, task
text, event summaries, or evidence in the first place.

## Current non-goals

- The journal is not signed, hash-chained, or tamper-evident.
- It is not persisted automatically or uploaded to a WasmHatch service.
- It is not a substitute for provider-native audit logs or effect receipts.
- It does not contain full model messages, source contents, or generated code.
- It does not authorize replay, unattended execution, or automatic retries.

Durable journal storage, cross-session resume, organization retention, and
cryptographic attestation require separate policy and recovery designs. The
foreground alpha keeps the artifact inspectable and user-controlled first.
