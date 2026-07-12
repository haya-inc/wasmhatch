# Workspace Script and File Effect Contract

- Contract status: foreground implementation in WasmHatch 0.20.0
- Runtime: QuickJS Wasm inside a dedicated module Worker
- Persistent authority: explicit workspace files under `scripts/` and `workflows/`
- Runtime authority: immutable input snapshots and ephemeral declared outputs only
- Network and credential authority: none

Workspace scripts let WasmHatch preserve AI-generated logic as an inspectable
artifact without turning OPFS into a live sandbox mount. Saving a script does not
run it, running it does not persist its output, and approving one output does not
authorize any other file or connector effect.

## Implemented flow

1. The host saves JavaScript source under `scripts/` and a versioned JSON
   manifest under `workflows/<script-id>.json`.
2. The host validates the persisted manifest and snapshots the exact source,
   declared input files, script arguments, and existing output bases.
3. SHA-256 identities bind the manifest bytes, source bytes, every input, every
   output base, limits, and grants into one immutable run ID.
4. A fresh Worker receives the snapshot. QuickJS exposes a small in-memory `fs`
   object containing only declared `/inputs/...` and `/outputs/...` paths.
5. The host validates returned paths, media types, byte counts, required outputs,
   and total output size. Live OPFS is still untouched.
6. Each changed output becomes an independent immutable file-effect proposal and
   unified diff.
7. After exact approval, the executor re-hashes the manifest, source, every
   input, and the target output base. Any changed or missing dependency returns a
   conflict naming the stale path and writes nothing.
8. The approved content is written and read back. A matching hash produces a
   deterministic receipt; an ambiguous result becomes `uncertain` and requires
   reconciliation rather than automatic retry.

The current Operator integration creates this flow from an imported CSV/XLSX
snapshot. It saves a wrapper script and manifest, transforms the granted table,
and stages one JSON output. The underlying contract supports multiple declared
outputs, but each output is reviewed and committed as its own proposal. It does
not claim a multi-file atomic transaction.

## Manifest schema

```json
{
  "schemaVersion": 1,
  "id": "weekly-pipeline",
  "version": "1.0.0",
  "sourcePath": "scripts/weekly-pipeline.js",
  "inputs": [
    {
      "workspacePath": "inputs/pipeline.json",
      "mountPath": "/inputs/pipeline.json",
      "mediaType": "application/json",
      "maxBytes": 131072
    }
  ],
  "outputs": [
    {
      "workspacePath": "outputs/pipeline-report.md",
      "mountPath": "/outputs/pipeline-report.md",
      "mediaType": "text/markdown",
      "maxBytes": 65536,
      "required": true
    }
  ],
  "limits": {
    "timeoutMs": 750,
    "memoryLimitBytes": 33554432,
    "maxSourceBytes": 24576,
    "maxTotalInputBytes": 131072,
    "maxTotalOutputBytes": 65536,
    "maxResultBytes": 65536
  }
}
```

Manifest objects reject missing and unknown fields. IDs use lower-case kebab
syntax and versions use a strict three-part semantic version. Source paths must
be `.js` files under `scripts/`. Inputs may come only from `inputs/`, `work/`, or
`outputs/`; outputs must be under `outputs/`. Workspace and mount paths are
normalized, unique, traversal-free, and checked against protected credential
path patterns.

Supported text media types are `application/json`, `text/csv`, `text/markdown`,
and `text/plain`. A manifest may grant 1–32 inputs and 1–16 outputs, subject to
both per-file and aggregate limits. The default aggregate input and output limit
is 512 KB each.

## Sandbox API

The saved source evaluates to one synchronous function:

```js
({ fs, args }) => {
  const rows = JSON.parse(fs.readText("/inputs/pipeline.json"));
  fs.writeText("/outputs/pipeline-report.md", `Rows: ${rows.length}\n`);
  return { rows: rows.length };
}
```

The frozen `fs` value exposes only:

- `list(prefix)`
- `exists(path)`
- `readText(path)`
- `mediaType(path)`
- `writeText(path, content)`

There is no `fetch`, DOM, Worker host import, connector transport, OAuth token,
model client, browser storage handle, live OPFS handle, dynamic module loading,
timer, or async continuation. QuickJS receives copied strings and JSON values,
not browser capabilities.

## Effect and conflict semantics

A file proposal binds:

- run, script, and manifest identity;
- source and every input hash;
- target workspace and virtual mount paths;
- media type and exact output bytes;
- whether the target existed and its complete reviewable base content;
- the policy decision; and
- the deterministic proposal ID.

Approval names the exact proposal ID. Editing any bound field invalidates the
proposal identity. Changing the manifest, source, an input, or the output base
after preparation returns a `conflict`. A failure proven to occur before the
file changed is retryable. A write that cannot be verified, or whose observed
content matches neither the base nor approved output, is `uncertain` and must not
be retried automatically.

The current precondition strength is `recheck`, not provider-native atomicity.
OPFS does not provide a general compare-and-swap write across tabs, so audit and
UI must not describe this as an atomic transaction. Multi-tab locking and a
stronger local commit primitive remain separate work.

## Known non-goals

- a POSIX or Node.js filesystem;
- shell commands, subprocesses, packages, or arbitrary module imports;
- network access from generated code;
- credential or connector access from generated code;
- live editing of OPFS from inside QuickJS;
- asynchronous scripts;
- multi-file atomic commit;
- persisted approvals or unattended execution; and
- treating saved workflow instructions as permission grants.
