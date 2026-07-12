# Business Agent Landscape

Updated: 2026-07-12

WasmHatch is a browser-native AI operator for foreground business work. It is
not a coding workspace, general workflow server, or replacement for mature
automation platforms.

The detailed, source-level comparison that guides implementation is in
[OSS Design Study](oss-design-study.md). That study treats reference projects
as evidence, not templates, and records both the patterns to adopt and the
designs that do not fit WasmHatch.

## Comparable products

| Product | Strength | Runtime model | Implication for WasmHatch |
| --- | --- | --- | --- |
| [Activepieces](https://github.com/activepieces/activepieces) | Large typed connector ecosystem, AI agents, code steps, MCP tools | Server/self-hosted | Validate connector pieces, human input, and AI-selected tools; do not compete on connector count |
| [Windmill](https://www.windmill.dev/docs/core_concepts/ai_agents) | Scripts, workflows, approvals, and scripts exposed as agent tools | Server/self-hosted workers | Validate scripts-as-tools and effect approvals; differentiate with foreground browser execution |
| [n8n](https://docs.n8n.io/advanced-ai/) | Visual workflows, integrations, and AI nodes | Server/cloud | Validate demand for broad orchestration; avoid recreating a visual DAG builder initially |
| [Google Apps Script](https://developers.google.com/apps-script/guides/sheets) | Spreadsheet-adjacent scripting and scheduled automation | Google-hosted | Validate spreadsheet automation; differentiate with provider-neutral local sandbox and visible effects |
| [OpenCode](https://github.com/anomalyco/opencode) | Legible workspace, separate file/search/exec tools, plan/build modes, undo, granular permissions | Local terminal/desktop/server | Adopt explicit tool contracts and approval modes; replace host shell access with browser-local proposals and Wasm Workers |
| [OpenClaw](https://github.com/openclaw/openclaw) | File-backed Markdown memory and skills, channels, tool policy, sandboxed execution | Local/self-hosted gateway | Adopt inspectable workspace artifacts and separate workspace, tool, and sandbox policy; do not adopt ambient host access or always-on autonomy in the foreground product |
| [SQLite-Wasm](https://sqlite.org/wasm/doc/tip/persistence.md) | Transactional embedded SQL with OPFS persistence | Browser Wasm/Worker | First candidate for workspace catalog, audit index, workflow state, and small structured datasets |
| [DuckDB-Wasm](https://duckdb.org/docs/stable/clients/wasm/overview) | Analytical SQL over local and remote columnar/tabular data | Browser Wasm/Worker | Optional analytical adapter for larger CSV, JSON, and Parquet joins and reports |
| [PGlite](https://pglite.dev/docs/about) | Postgres-compatible database with browser persistence and extensions | Browser Wasm/Worker | Evaluate for Postgres compatibility, reactive queries, or pgvector; avoid a default dependency without demonstrated demand |
| [ZenFS](https://zenfs.dev/core/) | Node-like filesystem facade over OPFS, IndexedDB, and other backends | Browser/library | Reference filesystem adapter semantics; compare against extending the existing smaller WorkspaceStore |
| [Pyodide](https://github.com/pyodide/pyodide) | Mature Python distribution in the browser | Browser Wasm | Candidate second runner for data-science-heavy pilot workloads |
| [Wasmer JS](https://docs.wasmer.io/sdk/wasmer-js/) | WASI/WASIX programs, filesystem, subprocesses, and interpreters in browser | Browser Wasm | Candidate for packaged CLI tools; broader than the initial JSON transform contract |

## Patterns to adopt carefully

### From OpenCode

- Treat `read`, `glob`, `grep`, file mutation, and execution as distinct tools.
- Resolve each tool or input pattern to `allow`, `ask`, or `deny`.
- Provide an inspect-only planning mode and a separately authorized execution
  mode.
- Keep changes diffable and reversible instead of treating a completed model
  response as success.
- Load project instructions from legible files, but never let instructions
  grant themselves more authority.

OpenCode defaults are designed for a developer-controlled local environment.
WasmHatch uses stricter defaults for business data: model egress is visible,
mutations stage proposals, and there is no general host shell.

### From OpenClaw

- Store durable user knowledge and reusable workflows in visible Markdown
  files rather than hidden model state.
- Keep workspace access, tool availability, execution location, and elevated
  escape hatches conceptually separate.
- Allow skills or workflows to describe how tools should be used while policy
  independently decides whether those tools are available.
- Put reusable agent-authored instructions through a proposal/review lifecycle.

OpenClaw is optimized for an always-on personal assistant with access to host
files, processes, browsers, and messaging channels. WasmHatch remains
foreground-first: its workspace is origin-private, scripts run in a Worker/Wasm
sandbox, and external effects require typed review.

## Chosen wedge

WasmHatch starts where server automation products are weakest:

- a user is present in the browser;
- credentials do not need durable storage;
- the task operates on bounded workspace files, database tables, spreadsheets,
  selected documents, or other typed business resources;
- generated transformation logic can run locally;
- external writes benefit from a precise before/after review;
- the user wants to inspect model egress and tool effects.

This wedge supports a static deployment and avoids requiring an account,
workflow server, or credential vault for the first useful experience.

## What not to build first

- Hundreds of connectors.
- A generic visual workflow canvas.
- Background schedules and webhook infrastructure.
- A full POSIX or Node.js runtime in the browser.
- A general shell exposed to generated scripts.
- Autonomous writes without an approval model.
- Durable organization credential storage.

## Technology choices

### QuickJS/Wasm first

The first sandbox accepts a synchronous JavaScript function and JSON-compatible
input. It is small enough to audit, has no host functions, and covers common
spreadsheet transformations.

The next runner contract adds a snapshot-based virtual mount: scripts may read
only declared input files and write only ephemeral outputs. The host validates
those outputs and stages a filesystem diff. Live OPFS, connector credentials,
DOM access, and ambient network access remain outside the sandbox.

### OPFS workspace first

The existing `WorkspaceStore` remains the minimum abstraction. Markdown, CSV,
JSON, scripts, reports, and connector snapshots use a visible file tree backed
by OPFS, with localStorage retained only as a constrained fallback. ZenFS is an
evaluation candidate if Node-like filesystem compatibility materially reduces
adapter complexity; it is not a prerequisite.

### SQLite for transactions, DuckDB for analysis

SQLite-Wasm is the default candidate for durable catalog and transactional local
state because it has an official OPFS persistence path. DuckDB-Wasm is a
separate analytical adapter for bounded joins and aggregations over tabular
files. User artifacts must remain exportable without requiring either engine.
PGlite stays optional until a real workflow needs Postgres semantics or its
extension ecosystem.

### Pyodide on demonstrated demand

Pyodide is useful when pilots require pandas, scientific packages, or existing
Python logic. Its larger payload and file-level MPL-2.0 obligations make it a
separate optional runner rather than the default.

### No WebContainer dependency

WebContainer is optimized for Node.js development environments rather than
business-data transformation. Its runtime is hosted by StackBlitz and
commercial production usage requires a separate license. It is not part of the
WasmHatch core architecture.

Official references:

- https://webcontainers.io/enterprise
- https://webcontainers.io/guides/api-support

### Server only for durable autonomy

If pilots require schedules, webhooks, service accounts, refresh tokens, or
non-CORS APIs, WasmHatch will introduce a self-hostable server adapter. That
adapter should borrow proven isolation and orchestration patterns rather than
turn the browser application into an implicit cloud service.

## OSS success strategy

The initial community artifact should be the connector and policy contract, not
the UI alone. Useful external contributions include:

- connector implementations with typed schemas and fixtures;
- virtual-filesystem and embedded-database adapters with recovery fixtures;
- transformation examples with deterministic input/output cases;
- script manifests and sandbox conformance tests;
- policy and approval primitives;
- redaction and model-egress tests;
- local workbook adapters;
- pilot reports that include rejected or failed operations.

Success is demonstrated by repeat business workflows and trustworthy effects,
not GitHub issue-to-patch conversion.
