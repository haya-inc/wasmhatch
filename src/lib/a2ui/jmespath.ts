/**
 * Pure-TypeScript JMESPath compiler and AST evaluator for A2UI `transformData`.
 *
 * Strictly CSP-safe (`script-src 'self'`, zero `eval` / `new Function`),
 * prototype-pollution hardened (`Object.hasOwn` + forbidden key guards), and
 * backed by an LRU cache of 100 compiled ASTs matching `@a2ui/catalog-mcp`.
 */

import { A2uiExpressionError } from "@a2ui/web_core/v1_0";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_CACHE_SIZE = 100;
const MAX_EXPRESSION_LENGTH = 8_192;
const MAX_AST_DEPTH = 64;

type TokenType =
  | "identifier"
  | "quoted_identifier"
  | "raw_string"
  | "literal"
  | "number"
  | "dot"
  | "star"
  | "flatten"
  | "filter"
  | "lbracket"
  | "rbracket"
  | "lbrace"
  | "rbrace"
  | "lparen"
  | "rparen"
  | "comma"
  | "colon"
  | "pipe"
  | "or"
  | "and"
  | "not"
  | "current"
  | "expref"
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "eof";

interface Token {
  type: TokenType;
  value: unknown;
  pos: number;
}

export type JmesAst =
  | { kind: "identity" }
  | { kind: "current" }
  | { kind: "literal"; value: unknown }
  | { kind: "field"; name: string }
  | { kind: "index"; index: number }
  | { kind: "slice"; start: number | null; stop: number | null; step: number | null }
  | { kind: "subexpression"; left: JmesAst; right: JmesAst }
  | { kind: "pipe"; left: JmesAst; right: JmesAst }
  | { kind: "projection"; left: JmesAst; right: JmesAst }
  | { kind: "value_projection"; left: JmesAst; right: JmesAst }
  | { kind: "flatten"; child: JmesAst }
  | { kind: "filter_projection"; left: JmesAst; condition: JmesAst; right: JmesAst }
  | { kind: "multi_select_list"; elements: JmesAst[] }
  | { kind: "multi_select_hash"; entries: Array<{ key: string; value: JmesAst }> }
  | { kind: "or"; left: JmesAst; right: JmesAst }
  | { kind: "and"; left: JmesAst; right: JmesAst }
  | { kind: "not"; child: JmesAst }
  | {
      kind: "comparator";
      op: "==" | "!=" | "<" | "<=" | ">" | ">=";
      left: JmesAst;
      right: JmesAst;
    }
  | { kind: "function"; name: string; args: JmesAst[] }
  | { kind: "expref"; expr: JmesAst };

const astCache = new Map<string, JmesAst>();

function failSyntax(message: string, expr: string): never {
  throw new A2uiExpressionError(
    `Invalid JMESPath expression "${expr}": ${message}`,
    "transformData"
  );
}

function failEval(message: string): never {
  throw new A2uiExpressionError(`JMESPath evaluation failed: ${message}`, "transformData");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeGetProp(target: unknown, key: string): unknown {
  if (FORBIDDEN_KEYS.has(key) || !isPlainObject(target)) return null;
  if (!Object.prototype.hasOwnProperty.call(target, key)) return null;
  const val = target[key];
  return val === undefined ? null : val;
}

function isFalsey(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, key) || !deepEqual(a[key], b[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = expr.length;

  while (i < len) {
    const ch = expr[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === ".") {
      tokens.push({ type: "dot", value: ".", pos: i });
      i += 1;
      continue;
    }
    if (ch === "*") {
      tokens.push({ type: "star", value: "*", pos: i });
      i += 1;
      continue;
    }
    if (ch === "[") {
      if (expr[i + 1] === "]") {
        tokens.push({ type: "flatten", value: "[]", pos: i });
        i += 2;
      } else if (expr[i + 1] === "?") {
        tokens.push({ type: "filter", value: "[?", pos: i });
        i += 2;
      } else {
        tokens.push({ type: "lbracket", value: "[", pos: i });
        i += 1;
      }
      continue;
    }
    if (ch === "]") {
      tokens.push({ type: "rbracket", value: "]", pos: i });
      i += 1;
      continue;
    }
    if (ch === "{") {
      tokens.push({ type: "lbrace", value: "{", pos: i });
      i += 1;
      continue;
    }
    if (ch === "}") {
      tokens.push({ type: "rbrace", value: "}", pos: i });
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen", value: "(", pos: i });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", value: ")", pos: i });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma", value: ",", pos: i });
      i += 1;
      continue;
    }
    if (ch === ":") {
      tokens.push({ type: "colon", value: ":", pos: i });
      i += 1;
      continue;
    }
    if (ch === "@") {
      tokens.push({ type: "current", value: "@", pos: i });
      i += 1;
      continue;
    }
    if (ch === "|") {
      if (expr[i + 1] === "|") {
        tokens.push({ type: "or", value: "||", pos: i });
        i += 2;
      } else {
        tokens.push({ type: "pipe", value: "|", pos: i });
        i += 1;
      }
      continue;
    }
    if (ch === "&") {
      if (expr[i + 1] === "&") {
        tokens.push({ type: "and", value: "&&", pos: i });
        i += 2;
      } else {
        tokens.push({ type: "expref", value: "&", pos: i });
        i += 1;
      }
      continue;
    }
    if (ch === "!") {
      if (expr[i + 1] === "=") {
        tokens.push({ type: "ne", value: "!=", pos: i });
        i += 2;
      } else {
        tokens.push({ type: "not", value: "!", pos: i });
        i += 1;
      }
      continue;
    }
    if (ch === "=") {
      if (expr[i + 1] === "=") {
        tokens.push({ type: "eq", value: "==", pos: i });
        i += 2;
        continue;
      }
      failSyntax(`Unexpected '=' at position ${i}`, expr);
    }
    if (ch === "<") {
      if (expr[i + 1] === "=") {
        tokens.push({ type: "le", value: "<=", pos: i });
        i += 2;
      } else {
        tokens.push({ type: "lt", value: "<", pos: i });
        i += 1;
      }
      continue;
    }
    if (ch === ">") {
      if (expr[i + 1] === "=") {
        tokens.push({ type: "ge", value: ">=", pos: i });
        i += 2;
      } else {
        tokens.push({ type: "gt", value: ">", pos: i });
        i += 1;
      }
      continue;
    }
    if (ch === "'") {
      const start = i;
      i += 1;
      let buf = "";
      let closed = false;
      while (i < len) {
        if (expr[i] === "\\" && (expr[i + 1] === "'" || expr[i + 1] === "\\")) {
          if (expr[i + 1] === "'") {
            buf += "'";
          } else {
            buf += "\\\\";
          }
          i += 2;
          continue;
        }
        if (expr[i] === "'") {
          closed = true;
          i += 1;
          break;
        }
        buf += expr[i];
        i += 1;
      }
      if (!closed) failSyntax(`Unterminated raw string starting at ${start}`, expr);
      tokens.push({ type: "raw_string", value: buf, pos: start });
      continue;
    }
    if (ch === "`") {
      const start = i;
      i += 1;
      let buf = "";
      let closed = false;
      while (i < len) {
        if (expr[i] === "\\" && expr[i + 1] === "`") {
          buf += "`";
          i += 2;
          continue;
        }
        if (expr[i] === "`") {
          closed = true;
          i += 1;
          break;
        }
        buf += expr[i];
        i += 1;
      }
      if (!closed) failSyntax(`Unterminated JSON literal starting at ${start}`, expr);
      const trimmed = buf.trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // JMESPath deprecated unquoted string fallback is rejected in strict mode unless valid JSON.
        failSyntax(`Invalid JSON literal \`${buf}\``, expr);
      }
      tokens.push({ type: "literal", value: parsed, pos: start });
      continue;
    }
    if (ch === '"') {
      const start = i;
      i += 1;
      let rawJson = '"';
      let closed = false;
      while (i < len) {
        if (expr[i] === "\\" && i + 1 < len) {
          rawJson += expr[i] + expr[i + 1];
          i += 2;
          continue;
        }
        rawJson += expr[i];
        if (expr[i] === '"') {
          closed = true;
          i += 1;
          break;
        }
        i += 1;
      }
      if (!closed) failSyntax(`Unterminated quoted identifier starting at ${start}`, expr);
      let ident: unknown;
      try {
        ident = JSON.parse(rawJson);
      } catch {
        failSyntax(`Invalid quoted identifier ${rawJson}`, expr);
      }
      if (typeof ident !== "string") {
        failSyntax(`Invalid quoted identifier ${rawJson}`, expr);
      }
      tokens.push({ type: "quoted_identifier", value: ident, pos: start });
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const start = i;
      if (ch === "-") i += 1;
      const digitsStart = i;
      while (i < len && expr[i] >= "0" && expr[i] <= "9") i += 1;
      if (i === digitsStart) failSyntax(`Expected integer after '-' at ${start}`, expr);
      const num = Number.parseInt(expr.slice(start, i), 10);
      tokens.push({ type: "number", value: num, pos: start });
      continue;
    }
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_") {
      const start = i;
      i += 1;
      while (
        i < len &&
        ((expr[i] >= "a" && expr[i] <= "z") ||
          (expr[i] >= "A" && expr[i] <= "Z") ||
          (expr[i] >= "0" && expr[i] <= "9") ||
          expr[i] === "_")
      ) {
        i += 1;
      }
      tokens.push({ type: "identifier", value: expr.slice(start, i), pos: start });
      continue;
    }
    failSyntax(`Unexpected character '${ch}' at position ${i}`, expr);
  }

  tokens.push({ type: "eof", value: "", pos: len });
  return tokens;
}

const BINDING_POWER: Partial<Record<TokenType, number>> = {
  pipe: 1,
  or: 2,
  and: 3,
  eq: 5,
  ne: 5,
  lt: 5,
  le: 5,
  gt: 5,
  ge: 5,
  flatten: 9,
  star: 20,
  filter: 21,
  dot: 40,
  not: 45,
  lbrace: 50,
  lbracket: 55,
  lparen: 60
};

class JmesParser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly source: string
  ) {}

  private peek(offset = 0): Token {
    return this.tokens[this.pos + offset] ?? this.tokens[this.tokens.length - 1];
  }

  private advance(): Token {
    const tok = this.peek();
    if (tok.type !== "eof") this.pos += 1;
    return tok;
  }

  private expect(type: TokenType): Token {
    const tok = this.peek();
    if (tok.type !== type) {
      failSyntax(`Expected ${type} but found ${tok.type} at ${tok.pos}`, this.source);
    }
    return this.advance();
  }

  parseRoot(): JmesAst {
    if (this.peek().type === "eof") {
      failSyntax("Expression cannot be empty", this.source);
    }
    const ast = this.expression(0, 0);
    if (this.peek().type !== "eof") {
      failSyntax(`Unexpected token ${this.peek().type} at ${this.peek().pos}`, this.source);
    }
    return ast;
  }

  private expression(rbp: number, depth: number): JmesAst {
    if (depth > MAX_AST_DEPTH) {
      failSyntax("Expression exceeds maximum nesting depth", this.source);
    }
    let left = this.nud(this.advance(), depth + 1);
    while (rbp < (BINDING_POWER[this.peek().type] ?? 0)) {
      left = this.led(this.advance(), left, depth + 1);
    }
    return left;
  }

  private nud(token: Token, depth: number): JmesAst {
    switch (token.type) {
      case "identifier": {
        const name = String(token.value);
        if (this.peek().type === "lparen") {
          this.advance();
          const args: JmesAst[] = [];
          if (this.peek().type !== "rparen") {
            while (true) {
              args.push(this.expression(0, depth + 1));
              if (this.peek().type === "comma") {
                this.advance();
              } else {
                break;
              }
            }
          }
          this.expect("rparen");
          return { kind: "function", name, args };
        }
        if (FORBIDDEN_KEYS.has(name)) {
          failSyntax(`Forbidden property key "${name}"`, this.source);
        }
        return { kind: "field", name };
      }
      case "quoted_identifier": {
        const name = String(token.value);
        if (FORBIDDEN_KEYS.has(name)) {
          failSyntax(`Forbidden property key "${name}"`, this.source);
        }
        return { kind: "field", name };
      }
      case "raw_string":
      case "literal":
        return { kind: "literal", value: token.value };
      case "current":
        return { kind: "current" };
      case "star": {
        const right = this.parseProjectionRhs(BINDING_POWER.star!, depth + 1);
        return { kind: "value_projection", left: { kind: "identity" }, right };
      }
      case "flatten": {
        const left: JmesAst = { kind: "flatten", child: { kind: "identity" } };
        const right = this.parseProjectionRhs(BINDING_POWER.flatten!, depth + 1);
        return { kind: "projection", left, right };
      }
      case "filter": {
        return this.parseFilter({ kind: "identity" }, depth + 1);
      }
      case "not": {
        const child = this.expression(BINDING_POWER.not!, depth + 1);
        return { kind: "not", child };
      }
      case "expref": {
        const expr = this.expression(BINDING_POWER.or!, depth + 1);
        return { kind: "expref", expr };
      }
      case "lparen": {
        const inner = this.expression(0, depth + 1);
        this.expect("rparen");
        return inner;
      }
      case "lbrace":
        return this.parseMultiSelectHash(depth + 1);
      case "lbracket": {
        if (this.peek().type === "number" || this.peek().type === "colon") {
          const idxOrSlice = this.parseIndexOrSlice();
          if (idxOrSlice.kind === "slice") {
            const right = this.parseProjectionRhs(BINDING_POWER.star!, depth + 1);
            return { kind: "projection", left: idxOrSlice, right };
          }
          return idxOrSlice;
        }
        if (this.peek().type === "star" && this.peek(1).type === "rbracket") {
          this.advance();
          this.advance();
          const right = this.parseProjectionRhs(BINDING_POWER.star!, depth + 1);
          return { kind: "projection", left: { kind: "identity" }, right };
        }
        return this.parseMultiSelectList(depth + 1);
      }
      default:
        failSyntax(`Unexpected token ${token.type} at ${token.pos}`, this.source);
    }
  }

  private led(token: Token, left: JmesAst, depth: number): JmesAst {
    switch (token.type) {
      case "dot": {
        if (this.peek().type === "star") {
          this.advance();
          const right = this.parseProjectionRhs(BINDING_POWER.star!, depth + 1);
          return { kind: "value_projection", left, right };
        }
        const right = this.parseDotRhs(BINDING_POWER.dot!, depth + 1);
        return { kind: "subexpression", left, right };
      }
      case "lbracket": {
        if (this.peek().type === "number" || this.peek().type === "colon") {
          const idxOrSlice = this.parseIndexOrSlice();
          if (idxOrSlice.kind === "slice") {
            const sub: JmesAst = { kind: "subexpression", left, right: idxOrSlice };
            const right = this.parseProjectionRhs(BINDING_POWER.star!, depth + 1);
            return { kind: "projection", left: sub, right };
          }
          return { kind: "subexpression", left, right: idxOrSlice };
        }
        if (this.peek().type === "star") {
          this.advance();
          this.expect("rbracket");
          const right = this.parseProjectionRhs(BINDING_POWER.star!, depth + 1);
          return { kind: "projection", left, right };
        }
        failSyntax(`Expected index, slice, or '*' after '[' at ${this.peek().pos}`, this.source);
      }
      case "flatten": {
        const flat: JmesAst = { kind: "flatten", child: left };
        const right = this.parseProjectionRhs(BINDING_POWER.flatten!, depth + 1);
        return { kind: "projection", left: flat, right };
      }
      case "filter":
        return this.parseFilter(left, depth + 1);
      case "pipe":
        return { kind: "pipe", left, right: this.expression(BINDING_POWER.pipe!, depth + 1) };
      case "or":
        return { kind: "or", left, right: this.expression(BINDING_POWER.or!, depth + 1) };
      case "and":
        return { kind: "and", left, right: this.expression(BINDING_POWER.and!, depth + 1) };
      case "eq":
      case "ne":
      case "lt":
      case "le":
      case "gt":
      case "ge": {
        const opMap: Record<string, "==" | "!=" | "<" | "<=" | ">" | ">="> = {
          eq: "==",
          ne: "!=",
          lt: "<",
          le: "<=",
          gt: ">",
          ge: ">="
        };
        return {
          kind: "comparator",
          op: opMap[token.type],
          left,
          right: this.expression(BINDING_POWER.eq!, depth + 1)
        };
      }
      default:
        failSyntax(`Unexpected infix token ${token.type} at ${token.pos}`, this.source);
    }
  }

  private parseDotRhs(rbp: number, depth: number): JmesAst {
    const next = this.peek();
    if (next.type === "identifier" || next.type === "quoted_identifier") {
      return this.expression(rbp, depth + 1);
    }
    if (next.type === "lbracket") {
      this.advance();
      return this.parseMultiSelectList(depth + 1);
    }
    if (next.type === "lbrace") {
      this.advance();
      return this.parseMultiSelectHash(depth + 1);
    }
    failSyntax(`Expected identifier or multi-select after '.' at ${next.pos}`, this.source);
  }

  private parseProjectionRhs(rbp: number, depth: number): JmesAst {
    const next = this.peek();
    if ((BINDING_POWER[next.type] ?? 0) < 10 && next.type !== "flatten") {
      return { kind: "identity" };
    }
    if (next.type === "dot") {
      this.advance();
      return this.parseProjectionAfterDot(rbp, depth + 1);
    }
    if (next.type === "lbracket" || next.type === "filter" || next.type === "flatten") {
      return this.expression(rbp, depth + 1);
    }
    return { kind: "identity" };
  }

  private parseProjectionAfterDot(rbp: number, depth: number): JmesAst {
    const next = this.peek();
    if (next.type === "star") {
      this.advance();
      const right = this.parseProjectionRhs(BINDING_POWER.star!, depth + 1);
      return { kind: "value_projection", left: { kind: "identity" }, right };
    }
    if (next.type === "identifier" || next.type === "quoted_identifier") {
      return this.expression(rbp, depth + 1);
    }
    if (next.type === "lbracket") {
      this.advance();
      return this.parseMultiSelectList(depth + 1);
    }
    if (next.type === "lbrace") {
      this.advance();
      return this.parseMultiSelectHash(depth + 1);
    }
    failSyntax(`Unexpected token ${next.type} in projection at ${next.pos}`, this.source);
  }

  private parseFilter(left: JmesAst, depth: number): JmesAst {
    const condition = this.expression(0, depth + 1);
    this.expect("rbracket");
    const right = this.parseProjectionRhs(BINDING_POWER.filter!, depth + 1);
    return { kind: "filter_projection", left, condition, right };
  }

  private parseIndexOrSlice(): Extract<JmesAst, { kind: "index" | "slice" }> {
    const parts: Array<number | null> = [];
    let sawColon = false;

    if (this.peek().type === "number") {
      parts.push(this.advance().value as number);
    } else {
      parts.push(null);
    }

    if (this.peek().type === "rbracket") {
      this.advance();
      if (parts[0] === null) {
        failSyntax("Empty bracket expression", this.source);
      }
      return { kind: "index", index: parts[0] };
    }

    while (this.peek().type === "colon") {
      sawColon = true;
      this.advance();
      if (this.peek().type === "number") {
        parts.push(this.advance().value as number);
      } else {
        parts.push(null);
      }
    }
    this.expect("rbracket");
    if (!sawColon || parts.length > 3) {
      failSyntax("Invalid slice syntax", this.source);
    }
    const step = parts[2] ?? null;
    if (step === 0) {
      failSyntax("Slice step cannot be 0", this.source);
    }
    return {
      kind: "slice",
      start: parts[0] ?? null,
      stop: parts[1] ?? null,
      step
    };
  }

  private parseMultiSelectList(depth: number): JmesAst {
    const elements: JmesAst[] = [];
    if (this.peek().type === "rbracket") {
      failSyntax("Multi-select list cannot be empty", this.source);
    }
    while (true) {
      elements.push(this.expression(0, depth + 1));
      if (this.peek().type === "comma") {
        this.advance();
      } else {
        break;
      }
    }
    this.expect("rbracket");
    return { kind: "multi_select_list", elements };
  }

  private parseMultiSelectHash(depth: number): JmesAst {
    const entries: Array<{ key: string; value: JmesAst }> = [];
    if (this.peek().type === "rbrace") {
      failSyntax("Multi-select hash cannot be empty", this.source);
    }
    while (true) {
      const keyTok = this.peek();
      if (keyTok.type !== "identifier" && keyTok.type !== "quoted_identifier") {
        failSyntax(`Expected key name in multi-select hash at ${keyTok.pos}`, this.source);
      }
      this.advance();
      const key = String(keyTok.value);
      if (FORBIDDEN_KEYS.has(key)) {
        failSyntax(`Forbidden key "${key}" in multi-select hash`, this.source);
      }
      this.expect("colon");
      const value = this.expression(0, depth + 1);
      entries.push({ key, value });
      if (this.peek().type === "comma") {
        this.advance();
      } else {
        break;
      }
    }
    this.expect("rbrace");
    return { kind: "multi_select_hash", entries };
  }
}

function evalSlice(
  arr: unknown[],
  start: number | null,
  stop: number | null,
  step: number | null
): unknown[] {
  const actualStep = step ?? 1;
  const len = arr.length;
  let actualStart: number;
  let actualStop: number;

  if (actualStep > 0) {
    actualStart = start === null ? 0 : start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
    actualStop = stop === null ? len : stop < 0 ? Math.max(len + stop, 0) : Math.min(stop, len);
    const out: unknown[] = [];
    for (let i = actualStart; i < actualStop; i += actualStep) {
      out.push(arr[i]);
    }
    return out;
  }

  actualStart =
    start === null ? len - 1 : start < 0 ? Math.max(len + start, -1) : Math.min(start, len - 1);
  actualStop = stop === null ? -1 : stop < 0 ? Math.max(len + stop, -1) : Math.min(stop, len - 1);
  const out: unknown[] = [];
  for (let i = actualStart; i > actualStop; i += actualStep) {
    out.push(arr[i]);
  }
  return out;
}

function jmesTypeOf(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return "array";
  if (isPlainObject(value)) return "object";
  return "null";
}

interface ExpRefValue {
  readonly __jmesExpRef: true;
  readonly ast: JmesAst;
}

function isExpRef(value: unknown): value is ExpRefValue {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { __jmesExpRef?: unknown }).__jmesExpRef === true
  );
}

function evalFunction(name: string, rawArgs: JmesAst[], current: unknown): unknown {
  const args = rawArgs.map((arg) =>
    arg.kind === "expref" ? ({ __jmesExpRef: true, ast: arg.expr } as ExpRefValue) : evaluateAst(arg, current)
  );

  const requireArity = (expected: number) => {
    if (args.length !== expected) {
      failEval(`${name}() expects ${expected} argument(s), got ${args.length}`);
    }
  };

  switch (name) {
    case "length": {
      requireArity(1);
      const val = args[0];
      if (typeof val === "string") return Array.from(val).length;
      if (Array.isArray(val)) return val.length;
      if (isPlainObject(val)) return Object.keys(val).length;
      failEval(`length() expects string, array, or object, got ${jmesTypeOf(val)}`);
    }
    case "keys": {
      requireArity(1);
      const val = args[0];
      if (!isPlainObject(val)) failEval(`keys() expects object, got ${jmesTypeOf(val)}`);
      return Object.keys(val).filter((k) => !FORBIDDEN_KEYS.has(k));
    }
    case "values": {
      requireArity(1);
      const val = args[0];
      if (!isPlainObject(val)) failEval(`values() expects object, got ${jmesTypeOf(val)}`);
      return Object.keys(val)
        .filter((k) => !FORBIDDEN_KEYS.has(k))
        .map((k) => val[k]);
    }
    case "type": {
      requireArity(1);
      return jmesTypeOf(args[0]);
    }
    case "to_string": {
      requireArity(1);
      const val = args[0];
      return typeof val === "string" ? val : JSON.stringify(val);
    }
    case "to_number": {
      requireArity(1);
      const val = args[0];
      if (typeof val === "number") return Number.isFinite(val) ? val : null;
      if (typeof val === "string" && val.trim().length > 0) {
        const parsed = Number(val);
        return Number.isFinite(parsed) ? parsed : null;
      }
      return null;
    }
    case "to_array": {
      requireArity(1);
      return Array.isArray(args[0]) ? args[0] : [args[0]];
    }
    case "contains": {
      requireArity(2);
      const subject = args[0];
      const search = args[1];
      if (typeof subject === "string") {
        if (typeof search !== "string") failEval("contains() string search must be a string");
        return subject.includes(search);
      }
      if (Array.isArray(subject)) {
        return subject.some((item) => deepEqual(item, search));
      }
      failEval(`contains() expects string or array, got ${jmesTypeOf(subject)}`);
    }
    case "starts_with": {
      requireArity(2);
      if (typeof args[0] !== "string" || typeof args[1] !== "string") {
        failEval("starts_with() expects (string, string)");
      }
      return args[0].startsWith(args[1]);
    }
    case "ends_with": {
      requireArity(2);
      if (typeof args[0] !== "string" || typeof args[1] !== "string") {
        failEval("ends_with() expects (string, string)");
      }
      return args[0].endsWith(args[1]);
    }
    case "join": {
      requireArity(2);
      const glue = args[0];
      const list = args[1];
      if (typeof glue !== "string" || !Array.isArray(list)) {
        failEval("join() expects (string, array<string>)");
      }
      for (const item of list) {
        if (typeof item !== "string") failEval("join() array elements must be strings");
      }
      return (list as string[]).join(glue);
    }
    case "reverse": {
      requireArity(1);
      const val = args[0];
      if (typeof val === "string") return Array.from(val).reverse().join("");
      if (Array.isArray(val)) return [...val].reverse();
      failEval(`reverse() expects string or array, got ${jmesTypeOf(val)}`);
    }
    case "sort": {
      requireArity(1);
      const list = args[0];
      if (!Array.isArray(list)) failEval("sort() expects array");
      if (list.length === 0) return [];
      const allNumbers = list.every((v) => typeof v === "number");
      const allStrings = list.every((v) => typeof v === "string");
      if (!allNumbers && !allStrings) {
        failEval("sort() expects homogeneous array of numbers or strings");
      }
      return [...list].sort((a, b) =>
        typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a) < String(b)
            ? -1
            : String(a) > String(b)
              ? 1
              : 0
      );
    }
    case "sort_by": {
      requireArity(2);
      const list = args[0];
      const exp = args[1];
      if (!Array.isArray(list) || !isExpRef(exp)) {
        failEval("sort_by() expects (array, &expression)");
      }
      if (list.length === 0) return [];
      const decorated = list.map((item, idx) => ({
        item,
        idx,
        key: evaluateAst(exp.ast, item)
      }));
      const allNumbers = decorated.every((d) => typeof d.key === "number");
      const allStrings = decorated.every((d) => typeof d.key === "string");
      if (!allNumbers && !allStrings) {
        failEval("sort_by() key expression must evaluate to all numbers or all strings");
      }
      decorated.sort((a, b) => {
        if (typeof a.key === "number" && typeof b.key === "number") {
          return a.key - b.key || a.idx - b.idx;
        }
        const sa = String(a.key);
        const sb = String(b.key);
        return sa < sb ? -1 : sa > sb ? 1 : a.idx - b.idx;
      });
      return decorated.map((d) => d.item);
    }
    case "sum": {
      requireArity(1);
      const list = args[0];
      if (!Array.isArray(list) || !list.every((v) => typeof v === "number")) {
        failEval("sum() expects array<number>");
      }
      return (list as number[]).reduce((acc, n) => acc + n, 0);
    }
    case "avg": {
      requireArity(1);
      const list = args[0];
      if (!Array.isArray(list) || !list.every((v) => typeof v === "number")) {
        failEval("avg() expects array<number>");
      }
      if (list.length === 0) return null;
      return (list as number[]).reduce((acc, n) => acc + n, 0) / list.length;
    }
    case "min":
    case "max": {
      requireArity(1);
      const list = args[0];
      if (!Array.isArray(list)) failEval(`${name}() expects array`);
      if (list.length === 0) return null;
      const allNumbers = list.every((v) => typeof v === "number");
      const allStrings = list.every((v) => typeof v === "string");
      if (!allNumbers && !allStrings) {
        failEval(`${name}() expects array<number> or array<string>`);
      }
      let best = list[0];
      for (let i = 1; i < list.length; i += 1) {
        const candidate = list[i];
        const cmp =
          typeof candidate === "number" && typeof best === "number"
            ? candidate - best
            : String(candidate) < String(best)
              ? -1
              : String(candidate) > String(best)
                ? 1
                : 0;
        if ((name === "min" && cmp < 0) || (name === "max" && cmp > 0)) {
          best = candidate;
        }
      }
      return best;
    }
    case "min_by":
    case "max_by": {
      requireArity(2);
      const list = args[0];
      const exp = args[1];
      if (!Array.isArray(list) || !isExpRef(exp)) {
        failEval(`${name}() expects (array, &expression)`);
      }
      if (list.length === 0) return null;
      const decorated = list.map((item) => ({ item, key: evaluateAst(exp.ast, item) }));
      const allNumbers = decorated.every((d) => typeof d.key === "number");
      const allStrings = decorated.every((d) => typeof d.key === "string");
      if (!allNumbers && !allStrings) {
        failEval(`${name}() key expression must evaluate to numbers or strings`);
      }
      let best = decorated[0];
      for (let i = 1; i < decorated.length; i += 1) {
        const cur = decorated[i];
        const cmp =
          typeof cur.key === "number" && typeof best.key === "number"
            ? cur.key - best.key
            : String(cur.key) < String(best.key)
              ? -1
              : String(cur.key) > String(best.key)
                ? 1
                : 0;
        if ((name === "min_by" && cmp < 0) || (name === "max_by" && cmp > 0)) {
          best = cur;
        }
      }
      return best.item;
    }
    case "abs":
    case "ceil":
    case "floor": {
      requireArity(1);
      if (typeof args[0] !== "number") failEval(`${name}() expects number`);
      return name === "abs"
        ? Math.abs(args[0])
        : name === "ceil"
          ? Math.ceil(args[0])
          : Math.floor(args[0]);
    }
    case "not_null": {
      if (args.length === 0) failEval("not_null() requires at least 1 argument");
      for (const arg of args) {
        if (arg !== null && arg !== undefined) return arg;
      }
      return null;
    }
    case "map": {
      requireArity(2);
      const exp = args[0];
      const list = args[1];
      if (!isExpRef(exp) || !Array.isArray(list)) {
        failEval("map() expects (&expression, array)");
      }
      return list.map((item) => evaluateAst(exp.ast, item));
    }
    case "merge": {
      if (args.length === 0) failEval("merge() requires at least 1 object argument");
      const merged: Record<string, unknown> = {};
      for (const arg of args) {
        if (!isPlainObject(arg)) failEval("merge() arguments must all be objects");
        for (const key of Object.keys(arg)) {
          if (!FORBIDDEN_KEYS.has(key)) {
            merged[key] = arg[key];
          }
        }
      }
      return merged;
    }
    default:
      failEval(`Unknown JMESPath function "${name}()"`);
  }
}

export function evaluateAst(ast: JmesAst, current: unknown): unknown {
  switch (ast.kind) {
    case "identity":
    case "current":
      return current === undefined ? null : current;
    case "literal":
      return ast.value;
    case "field":
      return safeGetProp(current, ast.name);
    case "index": {
      if (!Array.isArray(current)) return null;
      const idx = ast.index < 0 ? current.length + ast.index : ast.index;
      if (idx < 0 || idx >= current.length) return null;
      return current[idx] === undefined ? null : current[idx];
    }
    case "slice": {
      if (!Array.isArray(current)) return null;
      return evalSlice(current, ast.start, ast.stop, ast.step);
    }
    case "subexpression": {
      const base = evaluateAst(ast.left, current);
      if (base === null || base === undefined) return null;
      return evaluateAst(ast.right, base);
    }
    case "pipe": {
      const leftVal = evaluateAst(ast.left, current);
      return evaluateAst(ast.right, leftVal);
    }
    case "projection": {
      const base = evaluateAst(ast.left, current);
      if (!Array.isArray(base)) return null;
      const out: unknown[] = [];
      for (const item of base) {
        const projected = evaluateAst(ast.right, item);
        if (projected !== null && projected !== undefined) {
          out.push(projected);
        }
      }
      return out;
    }
    case "value_projection": {
      const base = evaluateAst(ast.left, current);
      if (!isPlainObject(base)) return null;
      const out: unknown[] = [];
      for (const key of Object.keys(base)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        const projected = evaluateAst(ast.right, base[key]);
        if (projected !== null && projected !== undefined) {
          out.push(projected);
        }
      }
      return out;
    }
    case "flatten": {
      const base = evaluateAst(ast.child, current);
      if (!Array.isArray(base)) return null;
      const out: unknown[] = [];
      for (const item of base) {
        if (Array.isArray(item)) {
          for (const inner of item) out.push(inner);
        } else {
          out.push(item);
        }
      }
      return out;
    }
    case "filter_projection": {
      const base = evaluateAst(ast.left, current);
      if (!Array.isArray(base)) return null;
      const out: unknown[] = [];
      for (const item of base) {
        const cond = evaluateAst(ast.condition, item);
        if (!isFalsey(cond)) {
          const projected = evaluateAst(ast.right, item);
          if (projected !== null && projected !== undefined) {
            out.push(projected);
          }
        }
      }
      return out;
    }
    case "multi_select_list": {
      if (current === null || current === undefined) return null;
      return ast.elements.map((el) => evaluateAst(el, current));
    }
    case "multi_select_hash": {
      if (current === null || current === undefined) return null;
      const out: Record<string, unknown> = {};
      for (const entry of ast.entries) {
        if (!FORBIDDEN_KEYS.has(entry.key)) {
          out[entry.key] = evaluateAst(entry.value, current);
        }
      }
      return out;
    }
    case "or": {
      const leftVal = evaluateAst(ast.left, current);
      return isFalsey(leftVal) ? evaluateAst(ast.right, current) : leftVal;
    }
    case "and": {
      const leftVal = evaluateAst(ast.left, current);
      return isFalsey(leftVal) ? leftVal : evaluateAst(ast.right, current);
    }
    case "not":
      return isFalsey(evaluateAst(ast.child, current));
    case "comparator": {
      const leftVal = evaluateAst(ast.left, current);
      const rightVal = evaluateAst(ast.right, current);
      if (ast.op === "==") return deepEqual(leftVal, rightVal);
      if (ast.op === "!=") return !deepEqual(leftVal, rightVal);
      if (typeof leftVal !== "number" || typeof rightVal !== "number") {
        return null;
      }
      switch (ast.op) {
        case "<":
          return leftVal < rightVal;
        case "<=":
          return leftVal <= rightVal;
        case ">":
          return leftVal > rightVal;
        case ">=":
          return leftVal >= rightVal;
      }
    }
    case "function":
      return evalFunction(ast.name, ast.args, current);
    case "expref":
      failEval("Unexpected bare expression reference '&' outside function argument");
  }
}

export function compileJmesPath(expression: string): JmesAst {
  if (typeof expression !== "string" || !expression.trim()) {
    failSyntax("Expression must be a non-empty string", String(expression ?? ""));
  }
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    failSyntax(`Expression exceeds ${MAX_EXPRESSION_LENGTH} characters`, expression.slice(0, 64));
  }
  const cached = astCache.get(expression);
  if (cached) {
    // Refresh LRU position.
    astCache.delete(expression);
    astCache.set(expression, cached);
    return cached;
  }
  const tokens = tokenize(expression);
  const ast = new JmesParser(tokens, expression).parseRoot();
  if (astCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = astCache.keys().next().value;
    if (oldestKey !== undefined) astCache.delete(oldestKey);
  }
  astCache.set(expression, ast);
  return ast;
}

export function searchJmesPath(data: unknown, expression: string): unknown {
  const ast = compileJmesPath(expression);
  return evaluateAst(ast, data);
}

