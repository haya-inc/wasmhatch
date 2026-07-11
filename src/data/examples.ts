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
    ref: "3b4a3876b1ff47e9d954f570ec6a79913c1a1da8",
    title: "Handle copied GitHub URLs",
    description: "Accept query strings and fragments without weakening host or path validation.",
    task:
      "Update parseGitHubRepository so GitHub repository URLs with a query string or fragment, such as ?tab=readme-ov-file or #readme, still normalize to owner/repository. Preserve existing shorthand and .git handling, reject non-GitHub hosts and nested paths, and add focused regression tests.",
    scope: "Parser + tests",
    issueUrl: "https://github.com/haya-inc/wasmhatch/issues/4"
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
