# CSV/XLSX Tabular Artifact Boundary

- Contract status: foreground implementation in WasmHatch 0.19.0
- Runtime: dedicated module Worker
- Source authority: local user-selected file only
- Network and credential authority: none

CSV and XLSX are local artifact formats, not connectors. The adapter accepts
untrusted file bytes, produces one bounded value snapshot with provenance, and
feeds the same typed spreadsheet mutation path used by Google Sheets. It never
receives an OAuth credential, connector transport, model client, DOM handle, or
ambient network capability.

## Implemented flow

1. The user explicitly selects a `.csv` or `.xlsx` file.
2. A fresh Worker validates and parses the file under an eight-second deadline.
3. The Worker returns literal spreadsheet values plus source hash, format,
   worksheet inventory, dimensions, formula/link counts, and warnings.
4. The host writes an inspectable `wasmhatch.tabular-snapshot.v1` JSON file to
   `inputs/` in the existing browser workspace. The original workbook bytes are
   not persisted or mounted into script execution.
5. QuickJS receives the normalized rows as JSON. The existing immutable typed
   mutation proposal drives review. Approval rechecks the current rows, writes
   the exact result as a content-addressed `work/` snapshot, reads and strictly
   validates it, and only then updates the visible working data. The original
   normalized `inputs/` snapshot remains unchanged.
6. Subsequent AI grants, workspace scripts, and portable exports bind the active
   verified `work/` snapshot rather than silently returning to the imported
   source rows.
7. Explicit export creates either a formula-neutralized UTF-8 CSV or a minimal
   value-only XLSX in the Worker.

Multiple visible XLSX worksheets are listed in the UI and can be selected. Each
selected worksheet receives a separate normalized workspace path bound to the
same original source hash.

## Hard limits

| Boundary | Limit |
| --- | ---: |
| Compressed source file | 8 MB |
| Total declared ZIP expansion | 32 MB |
| Individual ZIP entry | 16 MB |
| ZIP entries | 512 |
| Worksheets | 64 |
| Rows in selected table | 5,000 |
| Columns | 200 |
| Cells | 200,000 |
| Characters per cell | 32,767 |
| Shared strings | 200,000 |
| Worker wall clock | 8 seconds |

ZIP metadata is checked before accepted parts are inflated. Unsafe paths,
duplicate or case-ambiguous paths, invalid sizes, excessive expansion, malformed
XML, document types, processing instructions, invalid relationships, duplicate
cells, and unsupported cell types fail closed.

## Value and formula semantics

CSV has no reliable type metadata, so every imported CSV field remains a literal
string. Quotes, doubled quotes, commas, CRLF/LF, embedded line breaks, and a
UTF-8 BOM are supported. Invalid UTF-8 and malformed quoting are rejected rather
than guessed.

XLSX imports strings, finite numbers, booleans, ISO date strings already encoded
with the OOXML `d` cell type, error text, and empty cells. Styling and number
formats are not interpreted, so formatted date serials remain their numeric
values.

Formula source is never evaluated or copied into the normalized table. When a
formula cell has a cached value, only that value is imported and the provenance
warns that it may be stale. A missing cached value becomes empty. Formula-looking
text stored as an ordinary XLSX string remains literal text.

Macro parts cause the entire import to be rejected. External workbook parts and
relationships are ignored and disclosed. Hidden worksheets are excluded from
selection; cells in hidden rows or columns are omitted from the normalized
snapshot and counted in the warnings.

CSV export prefixes strings beginning with `=`, `+`, `-`, or `@` (after spaces or
tabs) with an apostrophe and records how many cells were neutralized. XLSX export
writes every string as `inlineStr`, never as a formula. It emits no macro,
external-link, hidden-sheet, comment, chart, style, or relationship payload from
the source workbook.

## Provenance record

Every normalized snapshot records:

- original filename, MIME type, byte count, and SHA-256;
- format and selected worksheet;
- visible worksheet inventory and hidden worksheet count;
- row, column, and cell counts;
- formula-cell and external-link counts; and
- all lossy-boundary warnings.

The source hash and selected worksheet become part of the local spreadsheet
target identity. A later script proposal still binds the exact base-value hash,
typed mutations, policy decision, and connector version through the common
spreadsheet effect protocol.

An approved local effect uses the same normalized schema under `work/`. Its file
name contains the full SHA-256 of the serialized snapshot. Persistence and
read-back validation happen inside the connector commit; a write or verification
failure is not reported as committed. The original `inputs/` artifact remains
available for provenance and comparison, while the active artifact pointer moves
to the verified working snapshot.

The most recent approved local table effect can be reversed during the active
session. WasmHatch does not mutate the pointer or copy an older file directly.
It verifies that the active rows, content-addressed path, durable bytes, original
proposal, and commit receipt still agree; derives the exact inverse mutation
bundle from that receipt; and stages a new proposal. Undo and redo each require
their own cell preview, current-source recheck, explicit approval, receipt, and
new verified `work/` snapshot. A reload currently discards the in-memory receipt
chain, so cross-session history and general workspace-file undo are not claimed.

## Dependency decision

WasmHatch evaluated [SheetJS Community Edition](https://docs.sheetjs.com/) and
[ExcelJS](https://github.com/exceljs/exceljs), but deliberately does not embed a
full spreadsheet editor or broad workbook conversion library for P0. Those
libraries support many formats and rendering features that this value-only
boundary must reject or ignore. This is a scope and attack-surface decision, not
a license objection: SheetJS CE is Apache-2.0 and ExcelJS is MIT.

The adapter uses the already-shipped [`fflate`](https://github.com/101arrowz/fflate)
ZIP implementation (MIT) and the small
[`saxes`](https://github.com/lddubeau/saxes) streaming XML parser (ISC, with
MIT-licensed `xmlchars`). The
supported OOXML subset is implemented and tested in this repository. This keeps
the accepted parts, bounds, and loss semantics reviewable and keeps the parser
out of the main UI bundle; import and export code exists only in the Worker.

## Known non-goals

- preserving workbook formatting or layout;
- calculating formulas;
- round-tripping macros, links, charts, comments, or hidden data;
- supporting `.xls`, `.xlsm`, `.xlsb`, ODS, or password-protected workbooks;
- inferring CSV numbers, booleans, dates, encodings, or delimiters;
- rendering more than the first 100 rows in the operator preview; and
- sending an oversized table to the model or QuickJS when their narrower egress
  and JSON limits apply.

These constraints are visible behavior, not temporary silent fallbacks. A
future richer workbook adapter must remain behind the same provenance and effect
contracts and must document any expanded authority separately.
