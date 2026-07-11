export interface ExampleTask {
  repository: string;
  ref: string;
  title: string;
  description: string;
  task: string;
  scope: string;
  issueUrl?: string;
}

export const exampleTasks: ExampleTask[] = [
  {
    repository: "haya-inc/wasmhatch",
    ref: "e4a2cf2e312e5035dfc31f8439bade27bec7e78a",
    title: "Harden GitHub URL parsing",
    description: "Fix a real normalization edge case and add focused regression coverage.",
    task:
      "Update parseGitHubRepository so a GitHub URL ending in .git/ is normalized to the repository name without .git. Add a regression test and keep the change focused.",
    scope: "Parser + test",
    issueUrl: "https://github.com/haya-inc/wasmhatch/issues/1"
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
