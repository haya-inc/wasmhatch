# Typed workspace artifact workflows

- Contract status: local and connector-snapshot implementation in WasmHatch 0.26.0
- Planner output: one typed artifact proposal
- Runtime: QuickJS Wasm Worker with an ephemeral snapshot VFS
- Durable effect: one independently reviewed workspace file proposal

The artifact workflow mode lets an operator turn explicitly attached business
files into a Markdown, CSV, JSON, plain-text, or inert JavaScript artifact. It is
not a general command runner. The model proposes source and one output identity;
the host derives all filesystem authority, executes the source in the existing
bounded Worker, and stops at the existing exact file-diff review.

## Two planning modes

The Operator exposes two explicit modes:

- **Table transform** stages a function from rows to rows and can produce typed
  cell mutations or the existing normalized tabular output.
- **Artifact output** stages a workspace script that reads exact text snapshots
  and writes one declared text artifact.

Changing mode invalidates the previous plan and any pending effect. Artifact
mode requires at least one active or explicitly attached workspace file or one
explicitly loaded Google Sheets range. A Google source is re-read only if the
model calls its exact foreground grant; the host then persists a credential-free
identity-bound snapshot. It does not silently serialize the local demo or expose
a live connector to the script.

## Model proposal boundary

After bounded identity-bound reads, the model may call only
`propose_workspace_artifact` with these exact fields:

- business summary and expected effect;
- one canonical path under `outputs/`;
- a media type matching `.md`, `.markdown`, `.csv`, `.json`, `.txt`, or `.js`;
- one synchronous `({ fs, args }) => ...` function expression;
- assumptions and warnings.

The proposal does not contain a manifest, resource limits, arbitrary mount
paths, credentials, network policy, or write authority. Unknown fields,
traversal, protected paths, mismatched extensions, oversized source, and a plan
created without content inspection fail closed.

## Host-derived manifest

For each exact planned input `PATH`, the host creates this read-only mount:

```text
/inputs/workspace/PATH
```

The one output mount is derived only from its reviewed media type:

| Media type | Virtual output |
| --- | --- |
| `text/markdown` | `/outputs/result.md` |
| `text/csv` | `/outputs/result.csv` |
| `application/json` | `/outputs/result.json` |
| `text/plain` | `/outputs/result.txt` |
| `text/javascript` | `/outputs/result.js` |

The host chooses the `scripts/` source path, `workflows/` manifest path,
per-input byte caps, one required output grant, 750 ms timeout, 32 MB memory,
24 KB source limit, 512 KB aggregate input limit, and 256 KB output limit.
JavaScript output is an inert artifact under `outputs/`; it is never promoted to
the executable `scripts/` root or run automatically.

## Execution and effect checkpoints

1. The user reviews the model plan and current script, then chooses **Run &
   stage artifact diff**.
2. The host rehashes every planned input against the attachment identities.
3. The source and host-derived manifest are saved as inspectable workspace
   definitions.
4. `prepareWorkspaceScriptRun` snapshots source, manifest, inputs, output base,
   limits, and hashes. The host compares the snapshot identities to the AI plan
   again before execution.
5. QuickJS receives only copied virtual inputs and one ephemeral output. It has
   no fetch, DOM, OPFS, connector, OAuth, model, or host capability.
6. The host requires exactly one declared output and validates its UTF-8/NUL/
   byte boundary. JSON must parse and CSV must pass the bounded CSV parser;
   formula-looking CSV cells are rejected unless emitted as explicit literals.
7. The output becomes an immutable file proposal bound to the manifest, source,
   every input hash, output base, payload, and policy decision.
8. Only foreground approval after dependency/base recheck writes the output.
   Rejection writes nothing; drift returns conflict; ambiguity returns
   `uncertain` without automatic retry.

The run journal records the model reads, typed plan, saved definition, sandbox
run, policy decision, proposal, approval, and receipt as separate events.

## Current non-goals

- more than one output per AI plan;
- direct connector reads inside the script;
- binary PDF/DOCX/XLSX generation;
- HTML rendering or executing JavaScript output;
- background or unattended execution;
- model-selected permissions or resource limits; and
- automatic approval of generated source or output.

Google Sheets is the first granted connector-read input. Other connectors must
earn a resource-specific snapshot schema and review boundary; this contract does
not imply a generic authenticated network tool.
