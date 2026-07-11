# Security policy

WasmHatch handles source files and optional model credentials in a browser. We
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
- The production HTML applies a default-deny meta CSP and restricts network
  connections to the GitHub and Anthropic endpoints used by the application.
- GitHub Pages supplies HTTPS/HSTS but does not allow this project to configure
  response headers. Meta CSP cannot enforce header-only directives such as
  `frame-ancestors`; this remains a documented hosting limitation.
- OPFS data can be deleted when users clear site data.
- Imported text files are untrusted input.
- ZIP central-directory metadata is validated before inflation; malformed,
  traversing, duplicate-path, oversized, and excessive-file archives are rejected.
- Browser command execution is not yet enabled.
