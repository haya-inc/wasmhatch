import { describe, expect, it, vi } from "vitest";
import { diffSpreadsheetRows, GoogleSheetsConnector, validateSpreadsheetRows } from "./spreadsheet";

describe("GoogleSheetsConnector", () => {
  it("reads a bounded range without exposing the token in the URL", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      range: "Ops!A1:C2",
      values: [["Owner", "Region", "Amount"], ["Aya", "West", 42]]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const connector = new GoogleSheetsConnector("secret-token", fetcher);

    const snapshot = await connector.read({ spreadsheetId: "sheet-id", range: "Ops!A1:C2" });

    expect(snapshot.values[1]).toEqual(["Aya", "West", 42]);
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toContain("Ops!A1%3AC2");
    expect(String(url)).not.toContain("secret-token");
    expect(options.headers.authorization).toBe("Bearer secret-token");
  });

  it("writes values using an explicit input mode", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      updatedRange: "Ops!A1:B2",
      updatedRows: 2,
      updatedColumns: 2,
      updatedCells: 4
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const connector = new GoogleSheetsConnector("token", fetcher);

    const result = await connector.write({
      spreadsheetId: "sheet-id",
      range: "Ops!A1:B2",
      values: [["Owner", "Amount"], ["Aya", 42]],
      inputMode: "RAW"
    });

    expect(result.updatedCells).toBe(4);
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toContain("valueInputOption=RAW");
    expect(options.method).toBe("PUT");
    expect(JSON.parse(options.body)).toEqual({
      range: "Ops!A1:B2",
      majorDimension: "ROWS",
      values: [["Owner", "Amount"], ["Aya", 42]]
    });
  });

  it("returns actionable authorization errors without response details", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("sensitive detail", { status: 403 }));
    const connector = new GoogleSheetsConnector("token", fetcher);

    await expect(connector.read({ spreadsheetId: "sheet-id", range: "A1:B2" }))
      .rejects.toThrow("denied this operation");
  });
});

describe("spreadsheet values", () => {
  it("rejects non-finite or structured cell values", () => {
    expect(() => validateSpreadsheetRows([[Number.NaN]])).toThrow("finite numbers");
    expect(() => validateSpreadsheetRows([[{ formula: "=1+1" }]])).toThrow("Spreadsheet values");
  });

  it("creates a cell-level write preview", () => {
    expect(diffSpreadsheetRows([["Name", "Amount"], [" Aya ", 4]], [["Name", "Amount"], ["Aya", 5]]))
      .toEqual([
        { row: 1, column: 0, before: " Aya ", after: "Aya" },
        { row: 1, column: 1, before: 4, after: 5 }
      ]);
  });
});
