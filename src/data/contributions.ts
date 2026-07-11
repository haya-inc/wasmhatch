export interface ContributionTask {
  issueNumber: number;
  repository: string;
  ref: string;
  title: string;
  description: string;
  task: string;
  scope: string;
}

export const contributionTasks: ContributionTask[] = [
  {
    issueNumber: 4,
    repository: "haya-inc/wasmhatch",
    ref: "3b4a3876b1ff47e9d954f570ec6a79913c1a1da8",
    title: "Handle copied GitHub URLs",
    description: "Accept query strings and fragments without weakening repository validation.",
    task: "Update parseGitHubRepository so GitHub repository URLs with a query string or fragment, such as ?tab=readme-ov-file or #readme, still normalize to owner/repository. Preserve existing shorthand and .git handling, reject non-GitHub hosts and nested paths, and add focused regression tests.",
    scope: "Parser + tests"
  },
  {
    issueNumber: 5,
    repository: "haya-inc/wasmhatch",
    ref: "8a3068620112952cbbe2b56629598b822a8068f6",
    title: "Clear the session API key",
    description: "Add an explicit, accessible in-memory key clearing control.",
    task: "Add a visible Clear key control beside the session-only Anthropic API key field. It must clear only the in-memory apiKey state, be disabled or absent when the field is empty, provide accessible labeling and visible confirmation, and never add persistence. Keep the change focused on WorkspacePage styling and documentation.",
    scope: "Security UX"
  },
  {
    issueNumber: 6,
    repository: "haya-inc/wasmhatch",
    ref: "8a3068620112952cbbe2b56629598b822a8068f6",
    title: "Save with Ctrl or Cmd+S",
    description: "Use the familiar shortcut only while the code editor is focused.",
    task: "Add Ctrl+S and Cmd+S handling to the code editor textarea. Only intercept the shortcut while the code editor is focused, prevent the browser save dialog, reuse saveEditor, preserve the existing dirty-state and notice behavior, and expose aria-keyshortcuts. Do not add global shortcuts.",
    scope: "Editor UX"
  },
  {
    issueNumber: 7,
    repository: "haya-inc/wasmhatch",
    ref: "8a3068620112952cbbe2b56629598b822a8068f6",
    title: "Show the resolved commit",
    description: "Keep the immutable SHA that GitHub import already resolves.",
    task: "Return the resolved commit SHA from fetchGitHubRepository without adding another API request, update its tests and WorkspacePage call site, and show the short immutable SHA after a successful GitHub import. Clear that metadata for zip imports and workspace deletion.",
    scope: "Import + UI"
  },
  {
    issueNumber: 8,
    repository: "haya-inc/wasmhatch",
    ref: "8a3068620112952cbbe2b56629598b822a8068f6",
    title: "Announce workspace state",
    description: "Expose selection, dirty state, and proposals to screen readers.",
    task: "Improve WorkspacePage screen-reader semantics without changing its visual layout. Announce status changes politely, mark the selected workspace file with aria-current, and add visually hidden text for the unsaved-editor and proposed-change dots. Add a reusable sr-only CSS utility.",
    scope: "Accessibility"
  }
];
