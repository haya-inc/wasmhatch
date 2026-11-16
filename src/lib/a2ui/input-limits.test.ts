import { describe, expect, it, vi } from "vitest";
import { z as compatibilityZod } from "zod/v3";
import { z as currentZod } from "zod/v4";
import {
  A2UI_INPUT_LIMITS,
  A2uiTextInputGuard,
  assertA2uiInput,
  parseA2uiJson
} from "./input-limits";
import { HatchlingA2uiRuntime } from "./runtime";
import { A2UI_MIME_TYPE, extractA2uiMessages, parseA2uiMessagesFromResource } from "./mcp-catalog";

describe("A2UI input budgets", () => {
  it("rejects an oversized collection before reading its first element", () => {
    const read = vi.fn(() => ({}));
    const values = new Array(A2UI_INPUT_LIMITS.maxCollectionItems + 1);
    Object.defineProperty(values, 0, { get: read });
    expect(() => assertA2uiInput({ data: values })).toThrow("10,000 items");
    expect(read).not.toHaveBeenCalled();
  });

  it("allows the supported 5,000-row workspace dataset with ordinary columns", () => {
    const rows = Array.from({ length: 5_000 }, (_, i) => ({ id: i, label: `Row ${i}`, amount: i * 2 }));
    expect(() => assertA2uiInput({ rows })).not.toThrow();
  });

  it("rejects deep and cyclic data with bounded traversal", () => {
    let nested: unknown = "leaf";
    for (let i = 0; i <= A2UI_INPUT_LIMITS.maxDepth; i += 1) nested = { nested };
    expect(() => assertA2uiInput(nested)).toThrow("64 levels");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => assertA2uiInput(cycle)).toThrow("cyclic data");
  });

  it("checks JSON collection and nesting budgets before JSON.parse", () => {
    const parse = vi.spyOn(JSON, "parse");
    try {
      const arrayText = `[${"0,".repeat(A2UI_INPUT_LIMITS.maxCollectionItems)}0]`;
      expect(() => parseA2uiJson(arrayText)).toThrow("10,000 items");
      expect(() => parseA2uiJson("[".repeat(65) + "0" + "]".repeat(65))).toThrow("64 levels");
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("maintains nesting and byte budgets across streaming chunks and split tags", () => {
    const guard = new A2uiTextInputGuard();
    guard.feed("Plain text [ignored\n<a2");
    guard.feed("ui>\n$/data = ");
    guard.feed("[".repeat(32));
    expect(() => guard.feed("[".repeat(33))).toThrow("64 levels");
    const bytes = new A2uiTextInputGuard();
    bytes.feed("x".repeat(A2UI_INPUT_LIMITS.maxBytes));
    expect(() => bytes.feed("あ")).toThrow("4 MiB");
  });

  it("ignores quoted and commented delimiters, including split raw and triple strings", () => {
    const guard = new A2uiTextInputGuard();
    const parts = [
      '<a2ui>\n# ' + "[".repeat(100) + '\n$/text = "',
      "[".repeat(100) + '\\"',
      "[".repeat(100) + '"\n$/raw = r',
      '"' + "[".repeat(100) + '"\n$/multiline = "',
      '"',
      '"' + "[".repeat(100) + '""',
      '"\n/* ' + "[".repeat(100) + '*',
      '/\nroot = Text(text="Safe")\n</a2',
      'ui>\nPlain ['
    ];
    for (const part of parts) expect(() => guard.feed(part)).not.toThrow();
    expect(() => guard.feed("[".repeat(100))).not.toThrow();
  });

  it("rejects excessive MCP UI before either inline or downloaded resources reach validation", () => {
    const text = `[${"0,".repeat(A2UI_INPUT_LIMITS.maxCollectionItems)}0]`;
    expect(() => extractA2uiMessages([{
      type: "resource", resource: { uri: "a2ui://large", mimeType: A2UI_MIME_TYPE, text }
    }])).toThrow("10,000 items");
    expect(() => parseA2uiMessagesFromResource({
      contents: [{ uri: "a2ui://large", mimeType: A2UI_MIME_TYPE, text }]
    }, "a2ui://large")).toThrow("10,000 items");
  });

  it("rejects oversized restored component lists before cloning or rendering elements", () => {
    const runtime = new HatchlingA2uiRuntime();
    const read = vi.fn(() => ({ id: "bad", type: "Text", properties: {} }));
    const components = new Array(A2UI_INPUT_LIMITS.maxComponents + 1);
    Object.defineProperty(components, 0, { get: read });
    expect(() => runtime.restoreSurfaces([{ surfaceId: "large", components }])).toThrow("1,000 items");
    expect(read).not.toHaveBeenCalled();
    expect(runtime.listCanvasSurfaces()).toEqual([]);
    runtime.dispose();
  });

  it("rejects an over-deep model response and still accepts the next normal UI", () => {
    const runtime = new HatchlingA2uiRuntime();
    const rejected = runtime.applyWholeResponse('<a2ui>\n$/data = ' + "[".repeat(65) + "0" + "]".repeat(65) + "\n</a2ui>");
    expect(rejected.errors).toHaveLength(1);
    expect(rejected.errors[0].error.message).toContain("64 levels");
    const accepted = runtime.applyWholeResponse('<a2ui>\nsurface("valid")\nroot = Text(text="Ready")\n</a2ui>');
    expect(accepted.errors).toEqual([]);
    expect(runtime.getSurface("valid")).toBeDefined();
    runtime.dispose();
  });
});

describe("GHSA-mrhx-c7xc-m3w5 collection rejection", () => {
  it("rejects oversized arrays before element parsing in both official v4 and the A2UI compatibility engine", () => {
    const compatibilityVisits = vi.fn((value: unknown) => value);
    const currentVisits = vi.fn((value: unknown) => value);
    const variants = [
      { schema: compatibilityZod.object({ values: compatibilityZod.array(compatibilityZod.preprocess(compatibilityVisits, compatibilityZod.string())).max(100) }), visits: compatibilityVisits },
      { schema: currentZod.object({ values: currentZod.array(currentZod.preprocess(currentVisits, currentZod.string())).max(100) }), visits: currentVisits }
    ];
    for (const { schema, visits } of variants) {
      const read = vi.fn(() => 0);
      const values = Array(10_000).fill(0);
      Object.defineProperty(values, 0, { get: read });
      const result = schema.safeParse({ values });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toMatchObject([{ code: "too_big", path: ["values"] }]);
      expect(!result.success && result.error.issues.length).toBe(1);
      expect(visits).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(schema.safeParse({ values: ["valid"] }).success).toBe(true);
      expect(visits).toHaveBeenCalledOnce();
    }
  });

  it("rejects exact-length arrays and capped sets before inspecting their elements", () => {
    const compatibilityVisits = vi.fn((value: unknown) => value);
    const currentVisits = vi.fn((value: unknown) => value);
    const variants = [
      {
        array: compatibilityZod.array(compatibilityZod.preprocess(compatibilityVisits, compatibilityZod.string())).length(2),
        set: compatibilityZod.set(compatibilityZod.preprocess(compatibilityVisits, compatibilityZod.string())).max(2), visits: compatibilityVisits
      },
      {
        array: currentZod.array(currentZod.preprocess(currentVisits, currentZod.string())).length(2),
        set: currentZod.set(currentZod.preprocess(currentVisits, currentZod.string())).max(2), visits: currentVisits
      }
    ];
    for (const { array, set, visits } of variants) {
      for (const [schema, input] of [[array, [1, 2, 3]], [set, new Set([1, 2, 3])]] as const) {
        const result = schema.safeParse(input);
        expect(result.success).toBe(false);
        expect(!result.success && result.error.issues.length).toBe(1);
      }
      expect(visits).not.toHaveBeenCalled();
    }
  });
});
