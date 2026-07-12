# Operator workspace portability and recovery

- Contract status: foreground implementation in WasmHatch 0.23.0
- Bundle schema: `wasmhatch.operator-workspace` version 1
- Working namespace: `wasmhatch-operator-workspace-v1`
- Legacy coding namespace: separate and never cleared by this contract

The Operator workspace can be exported, reviewed, cleared, restored, verified,
and resumed without giving generated code a live OPFS handle. The portable ZIP
contains bounded text artifacts and a manifest; it does not contain OAuth/model
credentials, original XLSX bytes, run-journal task text, or hidden browser state.

## Dedicated storage namespace

Earlier foundation builds wrote Operator artifacts into the same OPFS root used
by the retained coding workspace. That made a safe Operator-only clear or exact
restore impossible. The Operator now uses a dedicated working and baseline root,
with separate localStorage fallback keys. Legacy workspace data is neither
listed, exported, replaced, nor cleared by Operator recovery actions.

Operator artifacts created by versions 0.20–0.22 remain in the earlier shared
workspace and are intentionally not migrated automatically: that namespace may
also contain coding-workspace files that the Operator must not copy by guess.
Re-import the original business input into 0.23 or later, then create a new
portable export. Operator clear never removes the earlier shared data.

The portable roots are:

- `inputs/`
- `work/`
- `outputs/`
- `scripts/`
- `workflows/`

Only `.json`, `.csv`, `.md`, `.markdown`, `.js`, and `.txt` text files are
portable. Traversal, non-canonical paths, unsupported roots and extensions, NUL
bytes, and common credential paths such as `.env`, private keys, and cloud
credential directories fail closed.

## ZIP layout

```text
wasmhatch-operator-workspace/
├── manifest.json
└── files/
    ├── inputs/...
    ├── work/...
    ├── outputs/...
    ├── scripts/...
    └── workflows/...
```

The manifest records:

- schema and kind;
- export time;
- the active normalized tabular artifact, if any;
- canonical path, media type, byte count, and SHA-256 for every file; and
- total uncompressed text bytes.

Files are sorted by canonical path. Restore rejects missing, extra, duplicate,
case-ambiguous, oversized, non-UTF-8, or hash-mismatched entries before touching
the current workspace.

## Limits

| Boundary | Limit |
| --- | ---: |
| ZIP input/output | 8 MB |
| Expanded text | 8 MB |
| One workspace file | 2 MB |
| Manifest | 128 KB |
| Files | 128 |
| UTF-8 path | 512 bytes |

These portability limits are distinct from the smaller per-tool and per-script
egress/runtime limits. A file can be portable while still requiring a narrower
range or another workflow before the model or sandbox may read it.

## Restore effect

Selecting a ZIP does not replace files. Preparation:

1. copies and validates the complete archive;
2. hashes every restored file and the archive;
3. snapshots and hashes the current dedicated Operator workspace;
4. binds the archive, manifest, current base, and policy-decision ID into an
   immutable restore proposal; and
5. shows every restored path, byte count, and hash suffix for review.

Approval names only that proposal. Execution revalidates the proposal identity,
archive hash, manifest, and current workspace base. A changed current file
returns `conflict` and replaces nothing.

After recheck, the host snapshots the previous workspace, replaces the complete
dedicated namespace, and verifies the resulting path set and every file body.
On a proven replacement or verification failure it restores and verifies the
previous snapshot. If rollback cannot be verified, the outcome is terminally
`uncertain` and the UI does not claim either version is authoritative.

This is a verified foreground replacement, not an atomic OPFS transaction.
Another tab can still race between checks because OPFS does not expose a general
cross-tab compare-and-swap directory replacement.

## Clear effect

Clear is also a staged effect. Its proposal lists the exact current files and
binds their aggregate identity plus the policy decision. Approval rechecks that
identity, clears only the dedicated Operator roots, and verifies the working
root is empty. A failure triggers the same bounded rollback path. The legacy
coding workspace remains untouched.

Users should export a portable ZIP before approving clear when they may need the
artifacts later. Merely clicking **Review workspace clear** deletes nothing.

## Resume behavior

When a committed restore names an active normalized tabular snapshot, the host
strictly validates its schema, provenance, dimensions, cell values, and source
hash metadata before showing it as working data. The original workbook is not
reconstructed. Restored scripts, workflow manifests, reports, CSV files, and
JSON outputs remain in the dedicated workspace and can be exported again.

## Current non-goals

- background or server-side backup;
- automatic cloud synchronization;
- binary artifacts or original workbook preservation;
- signed or encrypted bundles;
- multi-device merge;
- cross-tab atomic replacement; and
- automatically executing a restored script or approval.

Encryption, organization retention, remote backup, and signed attestations need
separate key, identity, and server trust models. They are not implied by a local
portable ZIP.
