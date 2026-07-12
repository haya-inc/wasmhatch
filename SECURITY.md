# Security policy

WasmHatch handles business artifacts, source files, and optional model and OAuth
credentials in a browser. We
treat reports involving credential exposure, path traversal, unintended data
egress, destructive writes, archive bombs, and sandbox escape as security
issues.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not
open a public issue containing exploit details, credentials, or private source
code.

Include:

- the affected revision and browser;
- a minimal reproduction;
- the expected and observed trust boundary;
- whether any credential or file content left the device.

We will acknowledge a report within seven days and coordinate disclosure after
a fix or documented mitigation is available.

## Supported versions

Until the first stable release, only the latest commit on `main` receives
security fixes.

## Current boundaries

- Browser BYOK is opt-in and not equivalent to a hardware-backed secret store.
- Model providers receive file content returned through approved read tools.
- Common credential paths are hidden from agent listings and rejected by read
  and proposal tools. This path-based control can have false negatives and does
  not replace user review or content-level secret scanning.
- The workspace displays a per-run ledger for user data attached to model requests.
- File reads are limited to 200 lines and 50 KB per call. Runs are bounded by
  request count, cumulative serialized payload, and provider-reported token usage.
- The production HTML applies a default-deny meta CSP and restricts network
  connections to the explicit GitHub, Google, OpenAI, and Anthropic endpoints
  used by the current legacy and business-operator surfaces.
- GitHub Pages supplies HTTPS/HSTS but does not allow this project to configure
  response headers. Meta CSP cannot enforce header-only directives such as
  `frame-ancestors`; this remains a documented hosting limitation.
- OPFS data can be deleted when users clear site data.
- Imported text files are untrusted input.
- ZIP central-directory metadata is validated before inflation; malformed,
  traversing, duplicate-path, oversized, and excessive-file archives are rejected.
- CSV/XLSX import and export run in a dedicated Worker with an eight-second
  deadline. Inputs are limited to 8 MB compressed, 32 MB declared expansion,
  512 ZIP entries, 64 sheets, 5,000 rows, 200 columns, and 200,000 cells.
- Macro-bearing workbooks are rejected. Formulas are never evaluated, external
  links and hidden cells are excluded, and exports contain values only. CSV
  formula prefixes are neutralized before download.
- Original XLSX bytes are not persisted or mounted into generated scripts. The
  OPFS workspace receives a JSON value snapshot with SHA-256 provenance.
- Approved local table effects preserve that imported `inputs/` snapshot and
  write a content-addressed normalized snapshot under `work/`. The host reads
  back and strictly validates the exact file before reporting the effect as
  committed or using it for later AI, script, export, or restore operations.
- Workspace script source and its versioned manifest are persisted as inspectable
  files, but QuickJS receives copied input snapshots and an in-memory virtual
  mount only. Generated code has no live OPFS, DOM, network, connector, OAuth,
  model-client, timer, async, or dynamic-module capability.
- Workspace manifests grant exact input and output paths with per-file and
  aggregate bounds. Traversal, duplicate mounts, protected credential paths,
  undeclared reads or writes, missing required outputs, and unsupported media
  types fail closed.
- A workspace output is not durable until its exact file proposal is approved.
  Commit re-hashes the persisted manifest, script source, every input, and the
  output base. Conflicts write nothing. Unverifiable writes are terminally
  `uncertain` and are never automatically retried.
- Workspace file commit currently provides a `recheck` precondition, not an
  atomic compare-and-swap guarantee across browser tabs. Multi-file output is
  one proposal per file and is not described as a transaction.
- The checkpointed workspace planner grants only explicitly named paths. Model
  calls cannot enumerate or read other OPFS content, and protected credential
  paths remain denied even if included in a malformed grant or tool call.
- Artifact listing and the 24 KB / 200-line preview remain local. An AI
  attachment is capped at 512 KB and binds canonical path, media type, bytes,
  tabular status, and SHA-256. Every model tool rehashes before egress and denies
  a file changed after foreground attachment review.
- Workspace planning uses strict single function calls with `store: false`.
  Every list/read/search/tabular result sent to the model records path, source
  hash, and byte count. Missing provider usage, repeated calls, malformed output,
  or request/token/tool/egress budget exhaustion stops before further reads.
- Workspace data remains untrusted when returned as a tool result. It cannot
  expand host policy, run the proposed script, or authorize its output. Planning,
  sandbox execution, and durable effect approval are separate checkpoints.
- Artifact-workflow plans name one output path/type and synchronous script but
  cannot provide a manifest or resource grants. The host derives exact mounts
  and limits, rechecks planned input hashes before QuickJS execution, validates
  JSON/CSV/text output, and stages one immutable file diff. Generated `.js`
  output remains inert under `outputs/` and is never executed automatically.
- The Operator run journal stores bounded structured metadata, not source rows,
  file contents, generated script source, model messages, or provider bodies.
  Credential-named evidence keys are rejected and common key/token shapes are
  redacted before an explicit JSON export. This is defense in depth and does not
  replace preventing credentials from entering task text or errors.
- Run journal exports are neither signed nor tamper-evident. They link policy,
  proposal, source, run, and receipt identities for inspection but do not grant
  authority, prove business correctness, or replace provider-native audit logs.
- Local table undo/redo does not directly restore an old file. The host verifies
  the current rows, content-addressed path, durable bytes, committed proposal,
  receipt identity, and inverse mutations, then stages a new effect. It still
  requires exact cell review, current-source recheck, explicit approval, and a
  verified `work/` write. The receipt chain is session-only at present.
- The guided public pilot report is derived from aggregate counts and timings
  only. It excludes source contents, task text, resource identities, and run ID;
  the user must still inspect the copied Markdown before posting it publicly.
- Operator artifacts use a dedicated OPFS/localStorage namespace separate from
  the retained coding workspace. Operator export, restore, and clear never list
  or mutate the legacy namespace.
- Portable Operator ZIPs accept at most 128 bounded UTF-8 text files under the
  documented artifact roots. Paths, types, pre-inflation sizes, expanded bytes,
  manifest fields, active artifact provenance, and every SHA-256 are validated
  before a restore proposal can be staged.
- Restore and clear are immutable reviewed effects bound to a host policy
  decision and the current workspace identity. Approval rechecks that base,
  verifies the resulting files, and rolls back a proven failure. An unverifiable
  rollback is terminally `uncertain`; OPFS replacement is not described as an
  atomic cross-tab transaction.
- Browser command execution is not yet enabled.
