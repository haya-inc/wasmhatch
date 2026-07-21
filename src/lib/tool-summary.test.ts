import { describe, expect, it } from "vitest";
import { summarizeToolCall } from "./tool-summary";

describe("summarizeToolCall", () => {
  // Original tools
  it("summarizes read_file with path", () => {
    expect(summarizeToolCall("read_file", { path: "work/notes.md" })).toBe("Reading work/notes.md");
  });

  it("summarizes write_file with path", () => {
    expect(summarizeToolCall("write_file", { path: "src/main.ts" })).toBe("Writing src/main.ts");
  });

  it("summarizes list_files", () => {
    expect(summarizeToolCall("list_files", {})).toBe("Listing workspace files");
  });

  // Artifact tool
  it("summarizes create_artifact with title", () => {
    expect(summarizeToolCall("create_artifact", { title: "Q3 Report", html: "<h1>Q3</h1>" })).toBe(
      "Creating an HTML artifact — Q3 Report"
    );
  });

  it("falls back to raw name when create_artifact has no title", () => {
    expect(summarizeToolCall("create_artifact", { html: "<h1>x</h1>" })).toBe("create_artifact");
  });

  // Google tools
  it("summarizes create_google_doc with title", () => {
    expect(summarizeToolCall("create_google_doc", { title: "Meeting Notes" })).toBe(
      "Creating a Google Doc — Meeting Notes"
    );
  });

  it("summarizes create_google_sheet with title", () => {
    expect(summarizeToolCall("create_google_sheet", { title: "Q3 Budget" })).toBe(
      "Creating a Google Sheet — Q3 Budget"
    );
  });

  it("summarizes create_google_slides with title", () => {
    expect(summarizeToolCall("create_google_slides", { title: "Product Roadmap" })).toBe(
      "Creating a Google Slides deck — Product Roadmap"
    );
  });

  it("summarizes read_google_sheet_values", () => {
    expect(summarizeToolCall("read_google_sheet_values", { spreadsheetId: "abc123" })).toBe(
      "Reading a Google Sheet"
    );
  });

  it("summarizes update_google_sheet_values", () => {
    expect(summarizeToolCall("update_google_sheet_values", { spreadsheetId: "abc123", range: "A1:B2" })).toBe(
      "Updating a Google Sheet"
    );
  });

  it("summarizes append_google_doc_text", () => {
    expect(summarizeToolCall("append_google_doc_text", { documentId: "xyz789", text: "Hello" })).toBe(
      "Appending text to a Google Doc"
    );
  });

  // Fallback
  it("falls back to raw name for unknown tools", () => {
    expect(summarizeToolCall("unknown_tool", {})).toBe("unknown_tool");
  });

  it("falls back to raw name with path for unknown tools", () => {
    expect(summarizeToolCall("unknown_tool", { path: "foo.txt" })).toBe("unknown_tool foo.txt");
  });
});
