import { describe, expect, it } from "vitest";
import { parseMarkdown, type MarkdownInline } from "./markdown";

const text = (value: string): MarkdownInline => ({ kind: "text", text: value });

describe("parseMarkdown blocks", () => {
  it("returns nothing for empty or blank input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n  \n")).toEqual([]);
  });

  it("splits paragraphs on blank lines and keeps intra-paragraph newlines", () => {
    expect(parseMarkdown("one\ntwo\n\nthree")).toEqual([
      { kind: "paragraph", inline: [text("one\ntwo")] },
      { kind: "paragraph", inline: [text("three")] }
    ]);
  });

  it("parses headings up to level three and leaves hashtags alone", () => {
    expect(parseMarkdown("## Plan")).toEqual([
      { kind: "heading", level: 2, inline: [text("Plan")] }
    ]);
    expect(parseMarkdown("#hashtag")).toEqual([
      { kind: "paragraph", inline: [text("#hashtag")] }
    ]);
  });

  it("groups list items and distinguishes ordered from unordered", () => {
    expect(parseMarkdown("- first\n- second\n\n1. one\n2) two")).toEqual([
      { kind: "list", ordered: false, items: [[text("first")], [text("second")]] },
      { kind: "list", ordered: true, items: [[text("one")], [text("two")]] }
    ]);
  });

  it("does not mistake years or bold openers for list markers", () => {
    expect(parseMarkdown("2024. That year was busy.")).toEqual([
      { kind: "paragraph", inline: [text("2024. That year was busy.")] }
    ]);
    const bold = parseMarkdown("**Bold** opener");
    expect(bold).toHaveLength(1);
    expect(bold[0].kind).toBe("paragraph");
  });

  it("captures fenced code with its language and tolerates an unclosed fence", () => {
    expect(parseMarkdown("```js\nconst x = 1;\n```")).toEqual([
      { kind: "code", language: "js", text: "const x = 1;" }
    ]);
    expect(parseMarkdown("```\nstill streaming")).toEqual([
      { kind: "code", language: "", text: "still streaming" }
    ]);
  });

  it("never parses markdown inside a code fence", () => {
    expect(parseMarkdown("```\n**not bold**\n- not a list\n```")).toEqual([
      { kind: "code", language: "", text: "**not bold**\n- not a list" }
    ]);
  });
});

describe("parseMarkdown inline", () => {
  const paragraph = (input: string) => {
    const blocks = parseMarkdown(input);
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind !== "paragraph") throw new Error("expected a paragraph");
    return blocks[0].inline;
  };

  it("parses code, strong, and em spans", () => {
    expect(paragraph("run `npm test` **now** or *later*")).toEqual([
      text("run "),
      { kind: "code", text: "npm test" },
      text(" "),
      { kind: "strong", inline: [text("now")] },
      text(" or "),
      { kind: "em", inline: [text("later")] }
    ]);
  });

  it("nests em inside strong", () => {
    expect(paragraph("**very *much* so**")).toEqual([
      { kind: "strong", inline: [text("very "), { kind: "em", inline: [text("much")] }, text(" so")] }
    ]);
  });

  it("leaves unmatched or spaced markers literal", () => {
    expect(paragraph("2 * 3 * 4 = 24")).toEqual([text("2 * 3 * 4 = 24")]);
    expect(paragraph("a ** b and `open")).toEqual([text("a ** b and `open")]);
    expect(paragraph("snake_case_stays")).toEqual([text("snake_case_stays")]);
  });

  it("keeps only http(s) links and renders anything else as text", () => {
    expect(paragraph("see [docs](https://example.com/guide)")).toEqual([
      text("see "),
      { kind: "link", text: "docs", href: "https://example.com/guide" }
    ]);
    expect(paragraph("[bad](javascript:alert(1))")).toEqual([
      text("[bad](javascript:alert(1))")
    ]);
    expect(paragraph("[weird](data:text/html,x)")).toEqual([
      text("[weird](data:text/html,x)")
    ]);
  });
});
