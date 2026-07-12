# Operator artifact browser and AI attachment

- Contract status: foreground implementation in WasmHatch 0.24.0
- Storage authority: dedicated Operator workspace only
- Preview limit: 24 KB and 200 lines
- AI attachment limit: 512 KB per exact text artifact

The artifact browser makes the Operator workspace inspectable without turning it
into a coding IDE or exposing a live filesystem handle. It indexes the bounded
text roots, previews one file locally, and lets the user attach one exact file to
the next checkpointed AI plan. Listing or previewing never sends file content to
the model.

## Indexed artifact contract

The host lists only the portable workspace roots and types defined by the
[workspace portability contract](operator-workspace-portability.md):

- `inputs/`, `work/`, `outputs/`, `scripts/`, and `workflows/`;
- Markdown, CSV, JSON, JavaScript, and plain text; and
- at most 128 files, 2 MB per file, and 8 MB total.

Every index refresh validates canonical paths, protected credential names, text
content, NUL exclusion, and limits before showing any entry. Each entry records
the path, root, media type, UTF-8 byte count, line count, SHA-256, and whether it
is a strictly valid normalized tabular snapshot. Unsupported or corrupt state
fails closed instead of being silently hidden.

## Local preview

Selecting an entry re-reads and hashes it. If its identity changed after the
index was rendered, the preview is rejected and the index is refreshed. The UI
renders text through React, not as HTML, and displays at most 24 KB and 200
lines. The complete content remains in OPFS and is not copied into the run
journal or model request.

The preview is read-only. Edit, create, rename, delete, binary viewing, and
automatic script execution are outside this slice. Durable changes continue to
use the file-effect or workspace restore/clear protocols.

## Explicit AI attachment

**Attach exact file to AI plan** is a foreground disclosure action, not model
authority. The host re-reads the selected file and binds:

- canonical path;
- media type;
- UTF-8 bytes;
- SHA-256 identity; and
- normalized-tabular status.

Files over 512 KB cannot be attached to the current agent loop. The active
working table, when present, and one supplemental attachment form the complete
readable grant. Every granted path includes its reviewed SHA-256. Before a list,
read, search, or tabular tool returns anything, the host hashes the current file
and denies the call if that identity changed.

The model initially receives only the business task and the number of exact
grants. File contents cross the boundary only when the model requests a bounded
checkpointed tool. Tool output records the path, current source hash, and bytes
sent. Live OPFS handles, ungranted files, credentials, scripts, writes, and
effect approval remain unavailable.

## Journal evidence

Attachment and detachment are source events in the structured run journal. The
attachment event contains path, hash, media type, bytes, and tabular status—not
file content. Subsequent tool events independently record each bounded egress.
This distinguishes three facts that must not be conflated:

1. a file exists in the workspace;
2. the user attached one reviewed identity; and
3. a particular bounded range was actually sent to the model.

## Current non-goals

- multi-select or directory grants;
- background indexing or file watching;
- rich Markdown, spreadsheet, or code rendering;
- full-text UI search;
- editing or filesystem mutation from the browser; and
- multi-file AI attachment or output selection.

Typed single-output artifact workflows now reuse the same attachment,
tool-egress, script, and effect checkpoints; see
[Workspace Artifact Workflows](workspace-artifact-workflows.md).
