/**
 * Minimal Markdown parser for assistant messages.
 *
 * Deliberately a safe subset: the output is a typed tree the UI maps to
 * React elements, so no HTML string is ever injected. Links are kept only
 * for http(s) destinations; every unmatched or unsafe construct falls back
 * to literal text. No dependency, no HTML, no surprises.
 */

export type MarkdownInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; inline: MarkdownInline[] }
  | { kind: "em"; inline: MarkdownInline[] }
  | { kind: "link"; text: string; href: string };

export type MarkdownBlock =
  | { kind: "paragraph"; inline: MarkdownInline[] }
  | { kind: "heading"; level: 1 | 2 | 3; inline: MarkdownInline[] }
  | { kind: "code"; language: string; text: string }
  | { kind: "list"; ordered: boolean; items: MarkdownInline[][] };

const UNORDERED_ITEM = /^\s{0,3}[-*]\s+/;
const ORDERED_ITEM = /^\s{0,3}\d{1,3}[.)]\s+/;
const HEADING = /^(#{1,3})\s+(.+)$/;
const FENCE_OPEN = /^```([A-Za-z0-9+#.-]*)\s*$/;
const FENCE_CLOSE = /^```\s*$/;
const LINK = /^\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/i;

/** Emphasis spans must not start or end with whitespace ("2 * 3 * 4" is math). */
function emphasisBody(input: string, start: number, end: number): string | null {
  const inner = input.slice(start, end);
  return inner && inner === inner.trim() ? inner : null;
}

function parseInline(input: string, allowStrong = true): MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  let literal = "";
  const flush = () => {
    if (literal) {
      nodes.push({ kind: "text", text: literal });
      literal = "";
    }
  };

  let index = 0;
  while (index < input.length) {
    const char = input[index];

    if (char === "`") {
      const end = input.indexOf("`", index + 1);
      if (end > index) {
        flush();
        nodes.push({ kind: "code", text: input.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }

    if (allowStrong && input.startsWith("**", index)) {
      const end = input.indexOf("**", index + 2);
      const body = end > index + 1 ? emphasisBody(input, index + 2, end) : null;
      if (body) {
        flush();
        nodes.push({ kind: "strong", inline: parseInline(body, false) });
        index = end + 2;
        continue;
      }
    }

    if (char === "*" && !input.startsWith("**", index)) {
      const end = input.indexOf("*", index + 1);
      const body = end > index ? emphasisBody(input, index + 1, end) : null;
      if (body) {
        flush();
        nodes.push({ kind: "em", inline: parseInline(body, false) });
        index = end + 1;
        continue;
      }
    }

    if (char === "[") {
      const match = input.slice(index).match(LINK);
      if (match) {
        flush();
        nodes.push({ kind: "link", text: match[1], href: match[2] });
        index += match[0].length;
        continue;
      }
    }

    literal += char;
    index += 1;
  }
  flush();
  return nodes;
}

export function parseMarkdown(input: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = input.replaceAll("\r\n", "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    const fence = line.match(FENCE_OPEN);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE_CLOSE.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // Skip the closing fence; an unclosed fence (mid-stream) ends the input.
      blocks.push({ kind: "code", language: fence[1] ?? "", text: body.join("\n") });
      continue;
    }

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3,
        inline: parseInline(heading[2].trim())
      });
      index += 1;
      continue;
    }

    if (UNORDERED_ITEM.test(line) || ORDERED_ITEM.test(line)) {
      const ordered = ORDERED_ITEM.test(line);
      const marker = ordered ? ORDERED_ITEM : UNORDERED_ITEM;
      const items: MarkdownInline[][] = [];
      while (index < lines.length && marker.test(lines[index])) {
        items.push(parseInline(lines[index].replace(marker, "").trim()));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    const body: string[] = [];
    while (index < lines.length) {
      const current = lines[index];
      if (
        !current.trim() ||
        FENCE_OPEN.test(current) ||
        HEADING.test(current) ||
        UNORDERED_ITEM.test(current) ||
        ORDERED_ITEM.test(current)
      ) break;
      body.push(current);
      index += 1;
    }
    blocks.push({ kind: "paragraph", inline: parseInline(body.join("\n")) });
  }

  return blocks;
}
