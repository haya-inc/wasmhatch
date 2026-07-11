export function createReadableDiff(path: string, before: string, after: string): string {
  if (before === after) return `--- a/${path}\n+++ b/${path}\n(no changes)`;

  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  while (
    oldSuffix >= prefix &&
    newSuffix >= prefix &&
    oldLines[oldSuffix] === newLines[newSuffix]
  ) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }

  const contextStart = Math.max(0, prefix - 3);
  const oldEnd = Math.min(oldLines.length, oldSuffix + 4);
  const newEnd = Math.min(newLines.length, newSuffix + 4);
  const oldCount = oldEnd - contextStart;
  const newCount = newEnd - contextStart;
  const oldStart = oldCount === 0 ? 0 : contextStart + 1;
  const newStart = newCount === 0 ? 0 : contextStart + 1;
  const output = [
    before ? `--- a/${path}` : "--- /dev/null",
    after ? `+++ b/${path}` : "+++ /dev/null",
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`
  ];

  for (let index = contextStart; index < prefix; index += 1) output.push(` ${oldLines[index]}`);
  for (let index = prefix; index <= oldSuffix; index += 1) output.push(`-${oldLines[index]}`);
  for (let index = prefix; index <= newSuffix; index += 1) output.push(`+${newLines[index]}`);
  const trailing = newLines.slice(newSuffix + 1, newEnd);
  for (const line of trailing) output.push(` ${line}`);

  return output.join("\n");
}

function splitLines(content: string) {
  if (!content) return [];
  const withoutFinalNewline = content.endsWith("\n") ? content.slice(0, -1) : content;
  return withoutFinalNewline.split("\n");
}

export function createWorkspacePatch(
  changes: Array<{ path: string; before: string; after: string }>
) {
  return changes
    .filter((change) => change.before !== change.after)
    .map((change) => createReadableDiff(change.path, change.before, change.after))
    .join("\n\n");
}
