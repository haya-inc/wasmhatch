# Business Agent Landscape

Updated: 2026-07-12

WasmHatch is a browser-native AI operator for foreground business work. It is
not a coding workspace, general workflow server, or replacement for mature
automation platforms.

## Comparable products

| Product | Strength | Runtime model | Implication for WasmHatch |
| --- | --- | --- | --- |
| [Activepieces](https://github.com/activepieces/activepieces) | Large typed connector ecosystem, AI agents, code steps, MCP tools | Server/self-hosted | Validate connector pieces, human input, and AI-selected tools; do not compete on connector count |
| [Windmill](https://www.windmill.dev/docs/core_concepts/ai_agents) | Scripts, workflows, approvals, and scripts exposed as agent tools | Server/self-hosted workers | Validate scripts-as-tools and effect approvals; differentiate with foreground browser execution |
| [n8n](https://docs.n8n.io/advanced-ai/) | Visual workflows, integrations, and AI nodes | Server/cloud | Validate demand for broad orchestration; avoid recreating a visual DAG builder initially |
| [Google Apps Script](https://developers.google.com/apps-script/guides/sheets) | Spreadsheet-adjacent scripting and scheduled automation | Google-hosted | Validate spreadsheet automation; differentiate with provider-neutral local sandbox and visible effects |
| [Pyodide](https://github.com/pyodide/pyodide) | Mature Python distribution in the browser | Browser Wasm | Candidate second runner for data-science-heavy pilot workloads |
| [Wasmer JS](https://docs.wasmer.io/sdk/wasmer-js/) | WASI/WASIX programs, filesystem, subprocesses, and interpreters in browser | Browser Wasm | Candidate for packaged CLI tools; broader than the initial JSON transform contract |

## Chosen wedge

WasmHatch starts where server automation products are weakest:

- a user is present in the browser;
- credentials do not need durable storage;
- the task operates on a bounded spreadsheet or business dataset;
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
- Autonomous writes without an approval model.
- Durable organization credential storage.

## Technology choices

### QuickJS/Wasm first

The first sandbox accepts a synchronous JavaScript function and JSON-compatible
input. It is small enough to audit, has no host functions, and covers common
spreadsheet transformations.

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
- transformation examples with deterministic input/output cases;
- policy and approval primitives;
- redaction and model-egress tests;
- local workbook adapters;
- pilot reports that include rejected or failed operations.

Success is demonstrated by repeat business workflows and trustworthy effects,
not GitHub issue-to-patch conversion.
