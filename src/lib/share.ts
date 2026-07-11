export function createWorkspaceShareUrl(baseUrl: string, repository: string, task: string) {
  const url = new URL(baseUrl);
  url.searchParams.set("view", "workspace");
  if (repository.trim()) url.searchParams.set("repo", repository.trim());
  if (task.trim()) url.searchParams.set("task", task.trim());
  return url.toString();
}

export function createBadgeMarkdown(shareUrl: string, badgeUrl: string) {
  return `[![Open in WasmHatch](${badgeUrl})](${shareUrl})`;
}
