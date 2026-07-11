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
    issueNumber: 11,
    repository: "haya-inc/wasmhatch",
    ref: "b858776477085da50b488a9d83c917852f464773",
    title: "Name exports by repository",
    description: "Keep downloaded patches and workspaces identifiable without unsafe filenames.",
    task: "Add a small pure helper that derives safe repository-aware download names for Patch and Zip exports. Use haya-inc-wasmhatch.patch and haya-inc-wasmhatch-workspace.zip for haya-inc/wasmhatch, preserve the current wasmhatch fallbacks for empty or unsupported input, sanitize unsafe characters, and add focused unit tests without changing export contents.",
    scope: "Export UX + tests"
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
