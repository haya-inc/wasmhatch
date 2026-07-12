import { describe, expect, it, vi } from "vitest";
import {
  diffSpreadsheetRows,
  GoogleSheetsConnector,
  LocalSpreadsheetConnector,
  SpreadsheetWriteUncertainError,
  validateSpreadsheetRows
} from "./spreadsheet";
import {
  GOOGLE_SHEETS_MANIFEST,
  createConnectorFixtureTransport,
  type ConnectorFixtureHandlers
} from "./connector";

function googleConnector(handlers: ConnectorFixtureHandlers) {
  return new GoogleSheetsConnector(createConnectorFixtureTransport(
    GOOGLE_SHEETS_MANIFEST,
    {
      operations: ["read-range", "write-range"],
      pathParameters: {
        spreadsheetId: ["sheet-id"],
        range: ["Ops!A1:C2", "Ops!A1:B2", "A1:B2"]
      }
    },
    handlers
  ));
}

describe("GoogleSheetsConnector", () => {
  it("reads a bounded range without exposing the token in the URL", async () => {
    const handler = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      range: "Ops!A1:C2",
      values: [["Owner", "Region", "Amount"], ["Aya", "West", 42]]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const connector = googleConnector({ "read-range": handler });

    const snapshot = await connector.read({ spreadsheetId: "sheet-id", range: "Ops!A1:C2" });

    expect(snapshot.values[1]).toEqual(["Aya", "West", 42]);
    const [request] = handler.mock.calls[0];
    expect(request.url).toContain("Ops!A1%3AC2");
    expect(request.headers).not.toHaveProperty("authorization");
  });

  it("writes values using an explicit input mode", async () => {
    const handler = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      updatedRange: "Ops!A1:B2",
      updatedRows: 2,
      updatedColumns: 2,
      updatedCells: 4
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const connector = googleConnector({ "write-range": handler });

    const result = await connector.write({
      spreadsheetId: "sheet-id",
      range: "Ops!A1:B2",
      values: [["Owner", "Amount"], ["Aya", 42]],
      inputMode: "RAW"
    });

    expect(result.updatedCells).toBe(4);
    const [request] = handler.mock.calls[0];
    expect(request.url).toContain("valueInputOption=RAW");
    expect(request.method).toBe("PUT");
    expect(request.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(request.body)).toEqual({
      range: "Ops!A1:B2",
      majorDimension: "ROWS",
      values: [["Owner", "Amount"], ["Aya", 42]]
    });
  });

  it("uses exact RAW writes by default and translates conceptual nulls into provider clears", async () => {
    const handler = vi.fn().mockResolvedValue(new Response(JSON.stringify({ updatedCells: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const connector = googleConnector({ "write-range": handler });

    await connector.write({
      spreadsheetId: "sheet-id",
      range: "Ops!A1:B2",
      values: [["Owner", "Amount"], ["Aya", null]]
    });

    const [request] = handler.mock.calls[0];
    expect(request.url).toContain("valueInputOption=RAW");
    expect(JSON.parse(request.body).values).toEqual([["Owner", "Amount"], ["Aya", ""]]);
  });

  it("returns actionable authorization errors without response details", async () => {
    const connector = googleConnector({
      "read-range": async () => new Response("sensitive detail", { status: 403 })
    });

    await expect(connector.read({ spreadsheetId: "sheet-id", range: "A1:B2" }))
      .rejects.toThrow("denied this operation");
  });

  it("marks a transport failure during a write as an uncertain outcome", async () => {
    const connector = googleConnector({ "write-range": vi.fn().mockRejectedValue(new TypeError("network detail")) });

    await expect(connector.write({ spreadsheetId: "sheet-id", range: "A1:B2", values: [["A", "B"]] }))
      .rejects.toBeInstanceOf(SpreadsheetWriteUncertainError);
  });

  it("marks an unreadable success response as uncertain because the write may have committed", async () => {
    const connector = googleConnector({ "write-range": async () => new Response("not json", { status: 200 }) });

    await expect(connector.write({ spreadsheetId: "sheet-id", range: "A1:B2", values: [["A", "B"]] }))
      .rejects.toThrow("may have reached the provider");
  });

  it("treats a server-side write failure as uncertain but a policy rejection as failed", async () => {
    const uncertain = googleConnector({ "write-range": async () => new Response("", { status: 503 }) });
    const rejected = googleConnector({ "write-range": async () => new Response("", { status: 403 }) });
    const request = { spreadsheetId: "sheet-id", range: "A1:B2", values: [["A", "B"]] };

    await expect(uncertain.write(request)).rejects.toBeInstanceOf(SpreadsheetWriteUncertainError);
    await expect(rejected.write(request)).rejects.toThrow("denied this operation");
  });
});

describe("LocalSpreadsheetConnector", () => {
  it("binds local reads and writes to one manifest-declared target", async () => {
    let values = [["Owner", "Amount"], ["Aya", 4]];
    const connector = new LocalSpreadsheetConnector({
      target: { spreadsheetId: "local-demo", range: "Demo!A1:B2" },
      readValues: () => values,
      writeValues: (next) => { values = next as typeof values; }
    });

    const snapshot = await connector.read({ spreadsheetId: "local-demo", range: "Demo!A1:B2" });
    const result = await connector.write({
      spreadsheetId: "local-demo",
      range: "Demo!A1:B2",
      values: [["Owner", "Amount"], ["Aya", 5]]
    });

    expect(connector.manifest.id).toBe("local-spreadsheet");
    expect(snapshot.values).toEqual([["Owner", "Amount"], ["Aya", 4]]);
    expect(result.updatedCells).toBe(1);
    expect(values[1][1]).toBe(5);
    await expect(connector.read({ spreadsheetId: "another", range: "Demo!A1:B2" }))
      .rejects.toThrow("outside its bound target");
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
