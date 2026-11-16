/**
 * In-tab HTML artifacts.
 *
 * The agent stages one self-contained HTML document; the panel renders it in
 * an iframe locked to `sandbox="allow-scripts"` — never `allow-same-origin` —
 * so artifact scripts run in a null origin with no access to the parent page,
 * its storage, its credentials, or same-origin network. A strict iframe-level
 * CSP is injected into the document head as defense in depth. The HTML is not
 * sanitized: isolation, not sanitization, is the security boundary.
 */

import type { AgentToolDefinition, AgentToolExecutor, AgentToolOutcome } from "./agent-core/types";

export interface HtmlArtifact {
  id: string;
  title: string;
  html: string;
  createdIndex: number;
}

export const CHAT_ARTIFACT_MAX_BYTES = 512 * 1024;
const TITLE_MAX_LENGTH = 200;
const DOWNLOAD_NAME_MAX_LENGTH = 64;

/** The exact sandbox attribute the panel must use. Tests pin the absence of allow-same-origin. */
export const ARTIFACT_IFRAME_SANDBOX = "allow-scripts";

/** Iframe-level CSP injected into every artifact document. */
export const ARTIFACT_IFRAME_CSP =
  "default-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'unsafe-inline'";

export const ARTIFACT_TOOL: AgentToolDefinition = {
  name: "create_artifact",
  description:
    "Render a self-contained single-file HTML document (report, dashboard, or slide deck) in the artifact " +
    "panel beside the chat. Inline all CSS and JS; external network requests are blocked inside the artifact.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      html: { type: "string" }
    },
    required: ["title", "html"],
    additionalProperties: false
  }
};

const encoder = new TextEncoder();

function ok(content: string): AgentToolOutcome {
  return { content };
}

function fail(content: string): AgentToolOutcome {
  return { content, isError: true };
}

export function createArtifactExecutor(
  onArtifact: (artifact: { title: string; html: string }) => void
): AgentToolExecutor {
  return async (name, args) => {
    if (name !== "create_artifact") return fail(`Unknown tool: ${name}`);
    const title = typeof args.title === "string" ? args.title.trim() : "";
    const html = typeof args.html === "string" ? args.html : "";
    if (!title) return fail("title must be a non-empty string.");
    if (title.length > TITLE_MAX_LENGTH) {
      return fail(`title exceeds the ${TITLE_MAX_LENGTH}-character limit.`);
    }
    if (!html.trim()) return fail("html must be a non-empty string.");
    if (!html.includes("<")) {
      return fail("html does not look like an HTML document; provide markup, not plain text.");
    }
    if (encoder.encode(html).byteLength > CHAT_ARTIFACT_MAX_BYTES) {
      return fail(
        `html exceeds the ${CHAT_ARTIFACT_MAX_BYTES.toLocaleString()}-byte artifact limit. ` +
        "Split the document or reduce embedded assets."
      );
    }
    onArtifact({ title, html });
    return ok(`Rendered artifact "${title}" in the panel. The user can view and download it.`);
  };
}

/** Derive a safe download filename from the artifact title. */
export function artifactDownloadName(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, DOWNLOAD_NAME_MAX_LENGTH)
    .replace(/-+$/g, "");
  return `${slug || "artifact"}.html`;
}

function skipWhitespaceAndComments(html: string, start: number): number {
  let cursor = start;
  while (cursor < html.length) {
    const ws = /^\s+/.exec(html.slice(cursor));
    if (ws) {
      cursor += ws[0].length;
      continue;
    }
    if (html.startsWith("<!--", cursor)) {
      const end = html.indexOf("-->", cursor + 4);
      if (end < 0) return html.length;
      cursor = end + 3;
      continue;
    }
    break;
  }
  return cursor;
}

/**
 * Inject the iframe-level CSP meta tag into the document head. Scans only the
 * valid HTML prologue (comments, doctype, `<html>`) before accepting `<head>`
 * so comments or body markup cannot trick injection past executable tags.
 */
export function withInjectedCsp(html: string, csp: string = ARTIFACT_IFRAME_CSP): string {
  const escapedCsp = csp.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapedCsp}">`;

  let cursor = skipWhitespaceAndComments(html, 0);
  let afterDoctype = 0;
  const doctypeMatch = /^<!doctype\b[^>]*>/i.exec(html.slice(cursor));
  if (doctypeMatch) {
    cursor += doctypeMatch[0].length;
    afterDoctype = cursor;
    cursor = skipWhitespaceAndComments(html, cursor);
  }
  const htmlTagMatch = /^<html(?:\s[^>]*)?>/i.exec(html.slice(cursor));
  if (htmlTagMatch) {
    cursor += htmlTagMatch[0].length;
    cursor = skipWhitespaceAndComments(html, cursor);
  }
  const headMatch = /^<head(?:\s[^>]*)?>/i.exec(html.slice(cursor));
  if (headMatch) {
    const insertAt = cursor + headMatch[0].length;
    return `${html.slice(0, insertAt)}${meta}${html.slice(insertAt)}`;
  }
  if (htmlTagMatch) {
    return `${html.slice(0, cursor)}<head>${meta}</head>${html.slice(cursor)}`;
  }
  if (afterDoctype > 0) {
    return `${html.slice(0, afterDoctype)}<head>${meta}</head>${html.slice(afterDoctype)}`;
  }
  return `<head>${meta}</head>${html}`;
}
