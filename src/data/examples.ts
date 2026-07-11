import { normalizeGitHubIssueUrl } from "../lib/share";

export interface ExampleTask {
  repository: string;
  ref: string;
  title: string;
  description: string;
  task: string;
  scope: string;
  issueUrl?: string;
}

export function getExampleIssueNumber(issueUrl?: string) {
  const normalized = normalizeGitHubIssueUrl(issueUrl || "");
  return normalized.match(/\/issues\/(\d+)$/)?.[1] || "";
}

export const exampleTasks: ExampleTask[] = [
  {
    repository: "haya-inc/wasmhatch",
    ref: "b858776477085da50b488a9d83c917852f464773",
    title: "Name exports by repository",
    description: "Keep downloaded patches and workspaces identifiable without unsafe filenames.",
    task:
      "Add a small pure helper that derives safe repository-aware download names for Patch and Zip exports. Use haya-inc-wasmhatch.patch and haya-inc-wasmhatch-workspace.zip for haya-inc/wasmhatch, preserve the current wasmhatch fallbacks for empty or unsupported input, sanitize unsafe characters, and add focused unit tests without changing export contents.",
    scope: "Export UX + tests",
    issueUrl: "https://github.com/haya-inc/wasmhatch/issues/11"
  },
  {
    repository: "haya-inc/create-knowledge-kit",
    ref: "bfd8b8ba30bdaaf71a55d38b1c1fb0d6464e755c",
    title: "Add CLI smoke tests",
    description: "Cover two network-free commands in a six-file JavaScript CLI.",
    task:
      "Add node:test smoke coverage for --help and --version. Run the CLI as a child process, assert successful exit status and useful output, and avoid any network access.",
    scope: "Tests only"
  },
  {
    repository: "haya-inc/create-wiki-kit",
    ref: "cbc891ca85cb7f7a15882de6e11705dea5b417e4",
    title: "Establish a test baseline",
    description: "Introduce the first deterministic tests for a small scaffolding CLI.",
    task:
      "Add an npm test script using node:test and create smoke tests for --help, --version, and an unsupported --locale value. Spawn the CLI without cloning a template or using the network.",
    scope: "Test foundation"
  }
];
