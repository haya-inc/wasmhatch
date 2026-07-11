# Product landscape and fit

Verified against official product documentation on 2026-07-12.

WasmHatch is not intended to replace a cloud development environment, a full
browser IDE, or an autonomous command-running agent. Its narrow job is to turn a
small public issue into a reviewed, exportable text patch with the least possible
setup and a visible trust boundary.

## Comparison

| Surface | Primary job | Execution boundary | Change path |
| --- | --- | --- | --- |
| **WasmHatch** | Focused public issue to reviewable patch | No command runtime in the core flow; files use browser-managed storage | Explicit write review, then patch or zip export |
| [github.dev](https://docs.github.com/en/codespaces/the-githubdev-web-based-editor) | Lightweight repository editing in a browser | Browser sandbox with no compute or integrated terminal | Signed-in commit, push, and pull request |
| [GitHub Codespaces](https://docs.github.com/en/codespaces/about-codespaces/deep-dive) | Full project development, build, test, and debug | Dev container hosted on a dedicated virtual machine | Normal Git branch, commit, push, and pull-request flow |
| [WebContainers](https://webcontainers.io/api) | Build products that need a Node.js runtime in the browser | In-browser Node.js runtime and virtual filesystem | Defined by the application embedding the API |
| [OpenHands](https://docs.openhands.dev/openhands/usage/sandboxes/overview) | Delegate file editing and command execution to an agent | Docker, process, or remote sandbox | Agent-managed workspace and execution results |

CodeSandbox belongs to the cloud-development-environment category: its official
[Dev Container announcement](https://codesandbox.io/blog/introducing-dev-container-support-in-codesandbox)
describes running projects in cloud infrastructure and preparing a shareable,
full-featured environment. That is a broader job than WasmHatch's runtime-free
issue-to-patch path.

## Choose WasmHatch when

- the source is a public GitHub repository or a zip archive;
- the task is small enough to review as a focused text patch;
- a contributor should not need a preconfigured VM, container, or local toolchain;
- the maintainer wants the exact revision, task, and GitHub Issue to travel in one
  link;
- every model-proposed write should stop at an explicit diff review.

## Choose another surface when

- **Use github.dev** when direct GitHub commit and pull-request creation matters
  more than a provider-neutral patch handoff.
- **Use Codespaces or another cloud development environment** when the task must
  install dependencies, build, test, debug, or run services.
- **Use WebContainers** when the product itself needs to execute Node.js tools in
  the browser.
- **Use OpenHands or another sandboxed coding agent** when autonomous command
  execution is central to the task.

## Current boundary

WasmHatch currently supports bounded public-repository import, manual editing,
Anthropic BYOK file tools, explicit proposal review, persistent baselines, and
patch or zip export. It does not yet provide private-repository authentication,
command execution, direct commits, or pull-request creation. Those omissions are
deliberate until their security, licensing, and contributor-value tradeoffs are
proven.

## Adoption hypothesis

The project succeeds if maintainers can attach an **Open in WasmHatch** link to a
small issue and first-time contributors can produce a valid patch before setting
up the full repository. Runtime-first tools remain the right next step when the
patch needs project-specific validation.
