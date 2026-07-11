export function createWorkspaceShareUrl(
  baseUrl: string,
  repository: string,
  task: string,
  ref = "",
  issue = ""
) {
  const url = new URL(baseUrl);
  url.searchParams.set("view", "workspace");
  if (repository.trim()) url.searchParams.set("repo", repository.trim());
  if (ref.trim()) url.searchParams.set("ref", ref.trim());
  if (task.trim()) url.searchParams.set("task", task.trim());
  const issueUrl = normalizeGitHubIssueUrl(issue);
  if (issueUrl) url.searchParams.set("issue", issueUrl);
  return url.toString();
}

export function normalizeGitHubIssueUrl(input: string) {
  if (!input.trim()) return "";
  try {
    const url = new URL(input.trim());
    const path = url.pathname.replace(/\/$/, "");
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      !/^\/[^/]+\/[^/]+\/issues\/\d+$/.test(path)
    ) return "";
    return `https://github.com${path}`;
  } catch {
    return "";
  }
}

export function createBadgeMarkdown(shareUrl: string, badgeUrl: string) {
  return `[![Open in WasmHatch](${badgeUrl})](${shareUrl})`;
}
