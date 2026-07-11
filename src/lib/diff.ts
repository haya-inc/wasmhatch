export function createReadableDiff(path: string, before: string, after: string): string {
  if (before === after) return `--- a/${path}\n+++ b/${path}\n(no changes)`;

  const oldLines = before.split("\n");
  const newLines = after.split("\n");
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

  const contextStart = Math.max(0, prefix - 2);
  const newEnd = Math.min(newLines.length, newSuffix + 3);
  const output = [`--- a/${path}`, `+++ b/${path}`, `@@ -${contextStart + 1} +${contextStart + 1} @@`];

  for (let index = contextStart; index < prefix; index += 1) output.push(` ${oldLines[index]}`);
  for (let index = prefix; index <= oldSuffix; index += 1) output.push(`-${oldLines[index]}`);
  for (let index = prefix; index <= newSuffix; index += 1) output.push(`+${newLines[index]}`);
  const trailing = newLines.slice(newSuffix + 1, newEnd);
  for (const line of trailing) output.push(` ${line}`);

  return output.join("\n");
}
