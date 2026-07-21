import { describe, expect, it } from "vitest";
import { parseWorkspaceReference } from "./google-workspace-url";

describe("parseWorkspaceReference", () => {
  const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

  it("accepts a bare file ID", () => {
    expect(parseWorkspaceReference(id, "spreadsheet")).toBe(id);
    expect(parseWorkspaceReference(id, "document")).toBe(id);
    expect(parseWorkspaceReference(id, "presentation")).toBe(id);
  });

  it("extracts the ID from a docs.google.com edit URL", () => {
    expect(parseWorkspaceReference(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`, "spreadsheet")).toBe(id);
    expect(parseWorkspaceReference(`https://docs.google.com/document/d/${id}/edit`, "document")).toBe(id);
    expect(parseWorkspaceReference(`https://docs.google.com/presentation/d/${id}/edit`, "presentation")).toBe(id);
  });

  it("extracts the ID from a drive.google.com open?id= URL", () => {
    expect(parseWorkspaceReference(`https://drive.google.com/open?id=${id}`, "spreadsheet")).toBe(id);
  });

  it("rejects a URL whose file kind does not match the tool", () => {
    expect(() => parseWorkspaceReference(`https://docs.google.com/spreadsheets/d/${id}/edit`, "document"))
      .toThrowError(/spreadsheets URL/);
  });

  it("rejects non-Google hosts", () => {
    expect(() => parseWorkspaceReference(`https://evil.example.com/spreadsheets/d/${id}/edit`, "spreadsheet"))
      .toThrowError(/docs.google.com and drive.google.com/);
  });

  it("rejects http URLs", () => {
    expect(() => parseWorkspaceReference(`http://docs.google.com/document/d/${id}/edit`, "document"))
      .toThrowError(/https/);
  });

  it("rejects empty, non-string, and malformed references", () => {
    expect(() => parseWorkspaceReference("", "spreadsheet")).toThrowError(/required/);
    expect(() => parseWorkspaceReference(undefined, "spreadsheet")).toThrowError(/required/);
    expect(() => parseWorkspaceReference("short", "spreadsheet")).toThrowError(/valid Google Sheets file ID/);
    expect(() => parseWorkspaceReference("https://docs.google.com/spreadsheets/d/", "spreadsheet"))
      .toThrowError(/Could not find/);
  });

  it("names the error class so tool executors can surface it", () => {
    try {
      parseWorkspaceReference("", "presentation");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as Error).name).toBe("GoogleWorkspaceReferenceError");
    }
  });
});
