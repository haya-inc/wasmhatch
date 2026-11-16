/** Budgets applied before parsing or validating model/MCP supplied UI. */
export const A2UI_INPUT_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxDepth: 64,
  maxCollectionItems: 10_000,
  maxComponents: 1_000,
  maxNodes: 250_000
});

export class A2uiInputLimitError extends Error {
  readonly code = "A2UI_INPUT_LIMIT";

  constructor(detail: string) {
    super(`Interactive UI input exceeds its safety limit: ${detail}. Reduce the UI or dataset and try again.`);
    this.name = "A2uiInputLimitError";
  }
}

const encoder = new TextEncoder();

export function assertA2uiTextSize(text: string): number {
  if (text.length > A2UI_INPUT_LIMITS.maxBytes) throw new A2uiInputLimitError("4 MiB of text");
  const bytes = encoder.encode(text).byteLength;
  if (bytes > A2UI_INPUT_LIMITS.maxBytes) throw new A2uiInputLimitError("4 MiB of text");
  return bytes;
}

/**
 * Bound the work a validator can amplify. Check collection length before
 * reading even its first element; no issue objects are built for rejected UI.
 * JSON objects are visited without first allocating an unbounded keys array.
 */
export function assertA2uiInput(value: unknown): void {
  let nodes = 0;
  let textBytes = 0;
  const ancestors = new WeakSet<object>();
  const visit = (item: unknown, depth: number, key?: string): void => {
    if (++nodes > A2UI_INPUT_LIMITS.maxNodes) throw new A2uiInputLimitError("250,000 values");
    if (depth > A2UI_INPUT_LIMITS.maxDepth) throw new A2uiInputLimitError("64 levels of nesting");
    if (typeof item === "string") {
      textBytes += assertA2uiTextSize(item);
      if (textBytes > A2UI_INPUT_LIMITS.maxBytes) throw new A2uiInputLimitError("4 MiB of text");
      return;
    }
    if (!item || typeof item !== "object") return;
    if (ancestors.has(item)) throw new A2uiInputLimitError("cyclic data");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        const cap = key === "components" ? A2UI_INPUT_LIMITS.maxComponents : A2UI_INPUT_LIMITS.maxCollectionItems;
        if (item.length > cap) throw new A2uiInputLimitError(`${cap.toLocaleString("en-US")} items in one ${key === "components" ? "component list" : "collection"}`);
        for (let i = 0; i < item.length; i += 1) visit(item[i], depth + 1);
      } else {
        let count = 0;
        for (const field in item) {
          if (!Object.hasOwn(item, field)) continue;
          if (++count > A2UI_INPUT_LIMITS.maxCollectionItems) throw new A2uiInputLimitError("10,000 fields in one object");
        }
        for (const field in item) {
          if (!Object.hasOwn(item, field)) continue;
          textBytes += assertA2uiTextSize(field);
          if (textBytes > A2UI_INPUT_LIMITS.maxBytes) throw new A2uiInputLimitError("4 MiB of text");
          visit((item as Record<string, unknown>)[field], depth + 1, field);
        }
      }
    } finally {
      ancestors.delete(item);
    }
  };
  visit(value, 0);
}

/** An incremental lexical budget, before the recursive Express/JSON parser. */
export class A2uiTextInputGuard {
  private bytes = 0;
  private pending = "";
  private inBlock: boolean;
  private quote = "";
  private rawString = false;
  private escaped = false;
  private comment: "line" | "block" | null = null;
  private readonly collections: number[] = [];
  private values = 0;

  constructor(private readonly json = false) {
    this.inBlock = json;
  }

  feed(chunk: string): void {
    this.bytes += assertA2uiTextSize(chunk);
    if (this.bytes > A2UI_INPUT_LIMITS.maxBytes) throw new A2uiInputLimitError("4 MiB of text");
    const text = this.pending + chunk;
    this.pending = "";
    for (let i = 0; i < text.length; i += 1) {
      if (!this.inBlock) {
        const match = /<a2ui(?:\s[^>]*)?>/i.exec(text.slice(i));
        if (!match) {
          const tail = text.slice(i).match(/<(?:a2ui(?:\s[^>]*)?|a2u?|a?)?$/i)?.[0] ?? "";
          if (tail.length > 1_024) throw new A2uiInputLimitError("an oversized UI tag");
          this.pending = tail;
          return;
        }
        i += match.index + match[0].length - 1;
        this.inBlock = true;
        this.collections.length = 0;
        continue;
      }
      const ch = text[i];
      if (this.quote) {
        if (this.escaped) { this.escaped = false; continue; }
        if (!this.rawString && ch === "\\") { this.escaped = true; continue; }
        if (text.startsWith(this.quote, i)) {
          i += this.quote.length - 1;
          this.quote = "";
        } else if (ch === this.quote[0] && this.quote.startsWith(text.slice(i))) {
          this.pending = text.slice(i);
          return;
        }
        continue;
      }
      if (this.comment === "block") {
        if (ch === "*" && i + 1 === text.length) { this.pending = "*"; return; }
        if (text.startsWith("*/", i)) { this.comment = null; i += 1; }
        continue;
      }
      if (!this.json && ch === "<") {
        const close = /^<\/a2ui\s*>/i.exec(text.slice(i));
        if (close) {
          this.inBlock = false;
          this.comment = null;
          i += close[0].length - 1;
          continue;
        }
        const tail = text.slice(i);
        if ("</a2ui>".startsWith(tail.toLowerCase()) || /^<\/a2ui\s*$/i.test(tail)) {
          if (tail.length > 1_024) throw new A2uiInputLimitError("an oversized UI tag");
          this.pending = tail;
          return;
        }
      }
      if (this.comment === "line") {
        if (ch === "\n" || ch === "\r") this.comment = null;
        continue;
      }
      if (!this.json && (ch === "#" || text.startsWith("//", i) || text.startsWith("--", i))) {
        this.comment = "line";
        continue;
      }
      if (!this.json && text.startsWith("/*", i)) { this.comment = "block"; i += 1; continue; }
      if (!this.json && i + 1 === text.length && "/-rR".includes(ch)) { this.pending = ch; return; }
      const raw = !this.json && (ch === "r" || ch === "R") && text[i + 1] === '"' &&
        (i === 0 || !/[a-zA-Z0-9_]/.test(text[i - 1]));
      if (raw) i += 1;
      const quote = text[i];
      if (quote === '"' || (!this.json && quote === "'")) {
        if (!this.json && text.length - i < 3 && text.slice(i).split(quote).join("") === "") {
          this.pending = (raw ? ch : "") + text.slice(i);
          return;
        }
        this.quote = !this.json && text.startsWith(quote.repeat(3), i) ? quote.repeat(3) : quote;
        this.rawString = raw;
        i += this.quote.length - 1;
      } else if ("[({".includes(ch)) {
        this.collections.push(1);
        if (this.collections.length > A2UI_INPUT_LIMITS.maxDepth) throw new A2uiInputLimitError("64 levels of nesting");
        if (++this.values > A2UI_INPUT_LIMITS.maxNodes) throw new A2uiInputLimitError("250,000 values");
      } else if ("])}".includes(ch)) {
        this.collections.pop();
      } else if (ch === "," && this.collections.length) {
        const last = this.collections.length - 1;
        if (++this.collections[last] > A2UI_INPUT_LIMITS.maxCollectionItems) throw new A2uiInputLimitError("10,000 items in one collection");
        if (++this.values > A2UI_INPUT_LIMITS.maxNodes) throw new A2uiInputLimitError("250,000 values");
      }
    }
  }
}

export function parseA2uiJson(text: string): unknown {
  new A2uiTextInputGuard(true).feed(text);
  const parsed: unknown = JSON.parse(text);
  assertA2uiInput(parsed);
  return parsed;
}
