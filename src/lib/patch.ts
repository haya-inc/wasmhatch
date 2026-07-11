import { createWorkspacePatch } from "./diff";
import type { WorkspaceStore } from "./workspace";

export async function buildWorkspacePatch(store: WorkspaceStore) {
  const currentPaths = await store.listFiles();
  const baselinePaths = await store.listBaselineFiles();
  const allPaths = [...new Set([...baselinePaths, ...currentPaths])].sort();
  const changes = await Promise.all(
    allPaths.map(async (path) => {
      let before = "";
      let after = "";
      try { before = await store.readBaselineFile(path); } catch { /* New file. */ }
      try { after = await store.readFile(path); } catch { /* Deleted file. */ }
      return { path, before, after };
    })
  );
  const changedFileCount = changes.filter((change) => change.before !== change.after).length;
  return { patch: createWorkspacePatch(changes), changedFileCount };
}
