# Portable agents

- Contract status: initial implementation, schema version 1
- Bundle kind: `wasmhatch.agent`
- Media type: `application/vnd.wasmhatch.agent+zip`
- Canonical schema: `public/schemas/agent-package-manifest-v1.schema.json`

WasmHatch agents are portable data packages. They can be saved locally, hosted
on any HTTPS origin, shared inside an organization, or published through an
optional registry. The format does not contain an account, API key, billing
mode, official-service URL, or mutable registry state.

The standalone OSS application remains useful without a registry. A registry
adds discovery, publisher identity, moderation, immutable revision storage,
and eventually managed inference; it does not become a prerequisite for local
creation or BYOK execution.

## ZIP layout

```text
wasmhatch-agent/
├── manifest.json
└── files/
    ├── AGENTS.md
    ├── skills/...
    ├── templates/...
    └── examples/...
```

`manifest.json` names the instruction entrypoint, semantic agent version,
compatible WasmHatch core range, declared tools and HTTPS network origins,
sample prompts, and every included file's media type, byte length, and SHA-256.
All file paths are canonical and sorted. A runtime must treat permissions as
requests and intersect them with host policy and foreground user grants; a
manifest never grants a capability by itself.

## Portable boundary

Version 1 contains bounded UTF-8 text files only. It rejects traversal,
absolute and case-ambiguous paths, NUL bytes, undeclared ZIP entries, file/hash
mismatches, and common credential locations including `.env`, `.ssh`, cloud
credential directories, private keys, and credential-named files. Credential
path filtering is a safety floor, not proof that arbitrary prose contains no
secret, so a publish UI must still show the exact file list before upload.

| Boundary | Limit |
| --- | ---: |
| ZIP input/output | 8 MB |
| Expanded agent files | 8 MB |
| One file | 2 MB |
| Manifest | 128 KB |
| Files | 128 |
| Examples | 8 |
| Declared tools | 64 |
| Declared network origins | 32 |

`createPortableAgentPackage` builds and hashes a package.
`readPortableAgentPackage` validates the complete package before exposing any
file. `fetchPortableAgentPackage` adds a registry-neutral HTTPS loading path;
localhost HTTP is accepted for development. Browser CSP still decides which
origins an application deployment permits.

## Runtime model — hatchlings are the unit of sharing

A hatchling's shareable profile is exactly what the package carries:

- the **playbook** (the `AGENTS.md` entrypoint) becomes the hatchling's
  packaged instructions, injected into the system prompt between explicit
  markers and framed as untrusted authored content — it can never override
  the app's rules, unlock tools, or reach credentials;
- `files/` seed the new hatchling's isolated workspace;
- `permissions.tools` use the shared **capability vocabulary**
  (`src/lib/hatchling-capabilities.ts`: `workspace.read`, `workspace.write`,
  `workspace.script`, `artifacts`, `tickets`, `google`, `google.sensitive`,
  `slack`, `web`, `mcp`) and become the hatchling's allowlist. Filtering fails
  closed: unrecognized names grant nothing, and connectors the user has not
  connected simply are not there to grant.

Import always stops at a preview card — name, files, requested
capabilities, license, source — and nothing hatches without a click.
Publishing to a registry goes through the same card before any upload.
Exporting reverses the mapping (protected credential paths are excluded
twice: by the exporter and again by the package validator).

## Registry client

The optional hosted registry is a deployment choice: set
`VITE_REGISTRY_URL` (https, or localhost for development) and its origin
joins the audited CSP `connect-src`. The sidebar then offers load-by-URL
and token-gated publish, and `?agent=<package-url>` becomes a shareable
try link that fetches, previews, and waits for consent. The registry's
server-rendered public pages link back here through exactly that route
(their "Try in WasmHatch" button), and `unpublishFromRegistry` removes
an agent from the registry's public surfaces with the same token that
published it. Every route the client uses is documented in the registry
repository's `docs/api.md`; package bytes are immutable under their
SHA-256. Without a configured registry, `.agent` files still travel by
hand — download, send, import.

## What stays outside the package

- model and connector credentials;
- provider billing or BYOK selection;
- publisher authentication and reputation;
- likes, download counts, ranking, reports, and moderation state;
- the registry's revision ID and visibility state; and
- execution history or private user workspace data.

This separation lets the same package run from a downloaded file, an internal
web server, a self-hosted catalog, or the official WasmHatch service.
