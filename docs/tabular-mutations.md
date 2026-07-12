# WasmHatch Tabular Mutations

> One immutable payload for spreadsheet preview, approval, commit, and receipt.

- Contract status: experimental public API in WasmHatch 0.17.0
- Proposal schema: 2
- Mutation bundle schema: 1
- Source: [`src/lib/spreadsheet-mutation.ts`](../src/lib/spreadsheet-mutation.ts)

## The invariant

A spreadsheet proposal must not store one representation for review and another
for execution. WasmHatch stores the approved base snapshot plus an ordered typed
mutation bundle. It derives all of these from that bundle:

- changed-cell preview;
- changed-cell and formula summary;
- the values passed to the connector;
- content-addressed proposal identity; and
- inverse mutation metadata in a successful receipt.

Editing any coordinate, before-value, after-value, kind, target, base version,
connector version, or policy decision changes the proposal identity. Approval
for the previous identity cannot be reused.

## Bundle shape

```ts
interface SpreadsheetMutationBundle {
  readonly schemaVersion: 1;
  readonly operation: "tabular.cells.update";
  readonly mutations: readonly SpreadsheetCellMutation[];
}

interface SpreadsheetCellMutation {
  readonly kind: "cell.set" | "cell.set-formula";
  readonly row: number;       // zero based
  readonly column: number;    // zero based
  readonly before: SpreadsheetCell;
  readonly after: SpreadsheetCell;
}
```

Mutations are sorted by row and column and each coordinate appears once. The
bundle is deeply frozen. It contains no credential, connector transport, DOM
handle, function, or mutable UI state.

## Preparing and applying

```ts
const bundle = createSpreadsheetMutationBundle(baseRows, desiredRows, "RAW");
const preview = bundle.mutations;
const connectorValues = applySpreadsheetMutationBundle(baseRows, bundle, "RAW");
```

`createSpreadsheetMutationBundle` copies and validates both tables before
discarding the completed table. `applySpreadsheetMutationBundle` validates the
bundle again and checks every mutation's `before` value against the approved
base. Connector values are reconstructed only after proposal verification.

The validator rejects:

- unknown or missing fields;
- unsupported schema or operation IDs;
- negative, duplicate, unordered, or out-of-shape coordinates;
- stale `before` values and no-op mutations;
- mutation kinds inconsistent with the input mode;
- non-JSON spreadsheet cell values; and
- more than 100,000 mutations in one effect.

## Structural and formula boundaries

The current operation is cell-only. A changed row count or row width returns a
typed `structural_change` error. It is not silently converted into a whole-range
replacement because provider APIs differ on append, delete, clear, and resize
semantics. Future operations must name those effects separately.

Under `USER_ENTERED`, a string beginning with `=` is classified as
`cell.set-formula`. Ordinary proposals reject it with
`formula_write_requires_capability`. Formula execution requires a future
high-risk policy capability and a review that exposes the formula source. Under
`RAW`, the same text remains a literal string.

The bundled Google Sheets path uses `RAW` by default so reviewed values are not
reinterpreted as numbers, dates, or formulas. Conceptual `null` cells are sent
as empty strings because the Sheets
[`ValueRange` contract](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values)
skips JSON nulls rather than clearing cells.

## Receipt and inverse metadata

After a confirmed commit, the receipt records the accepted mutation count and
an inverse bundle with before/after values swapped. This is recovery metadata,
not permission to undo. Applying an inverse is a new durable effect: read the
current source, prepare a new proposal, review it, and approve it independently.

Uncertain writes do not produce inverse metadata as proof of rollback. The
target must be reconciled first because the provider may already have applied
the original request.

## Connector and contributor rules

1. A connector operation must deterministically translate the reconstructed
   values or define a different typed operation. It must not reinterpret this
   bundle as append, clear-range, or structural edit.
2. Preview components consume `bundle.mutations`; they do not recompute a diff
   from an independently stored desired table.
3. Summary and receipt fields are validated against the bundle before commit.
4. Provider-native preconditions remain separate. A mutation bundle does not
   turn a `recheck` connector into an atomic one.
5. Add adversarial tests for unknown fields, stale before-values, formula
   classification, structural rejection, exact provider payload, and inverse
   round-trip behavior.

This small headless contract follows the useful action-bundle and command versus
mutation separation found in Grist and Univer without importing either document
model or renderer.
