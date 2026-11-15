/**
 * Browser download helpers — single source of truth for Blob -> <a download>
 * delivery so UI components do not duplicate object-URL lifecycle boilerplate.
 */

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  txt: "text/plain",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  py: "text/x-python",
  sh: "text/x-shellscript",
  yaml: "text/yaml",
  yml: "text/yaml"
});

export function mimeTypeForPath(path: string): string {
  const ext = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
  return MIME_BY_EXTENSION[ext] ?? "text/plain";
}

export function basenameOfPath(path: string): string {
  return path.split("/").pop() || path;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.click();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadBytes(bytes: Uint8Array, fileName: string, mimeType: string): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  downloadBlob(new Blob([copy.buffer], { type: mimeType }), fileName);
}

export function downloadTextFile(fileName: string, content: string, mimeType = mimeTypeForPath(fileName)): void {
  downloadBlob(new Blob([new TextEncoder().encode(content)], { type: mimeType }), basenameOfPath(fileName));
}
