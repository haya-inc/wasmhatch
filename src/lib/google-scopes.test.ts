import { describe, expect, it } from "vitest";
import {
  GOOGLE_ALL_SCOPES,
  GOOGLE_CALENDAR_EVENTS_SCOPE,
  GOOGLE_DOCUMENTS_SCOPE,
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_LAUNCH_SCOPES,
  GOOGLE_PRESENTATIONS_SCOPE,
  GOOGLE_SENSITIVE_SCOPES,
  GOOGLE_SPREADSHEETS_SCOPE,
  parseSensitiveScopesFlag,
  resolveGoogleScopes
} from "./google-scopes";

describe("google scopes", () => {
  it("keeps the launch set to the non-sensitive drive.file scope only", () => {
    expect(GOOGLE_LAUNCH_SCOPES).toEqual([GOOGLE_DRIVE_FILE_SCOPE]);
    expect(GOOGLE_LAUNCH_SCOPES).not.toContain(GOOGLE_SPREADSHEETS_SCOPE);
  });

  it("lists exactly the four sensitive scopes", () => {
    expect([...GOOGLE_SENSITIVE_SCOPES]).toEqual([
      GOOGLE_SPREADSHEETS_SCOPE,
      GOOGLE_DOCUMENTS_SCOPE,
      GOOGLE_PRESENTATIONS_SCOPE,
      GOOGLE_CALENDAR_EVENTS_SCOPE
    ]);
    expect([...GOOGLE_ALL_SCOPES]).toEqual([GOOGLE_DRIVE_FILE_SCOPE, ...GOOGLE_SENSITIVE_SCOPES]);
  });

  it("resolves launch-safe scopes unless the deployment opts in", () => {
    expect(resolveGoogleScopes(false)).toEqual([GOOGLE_DRIVE_FILE_SCOPE]);
    expect(resolveGoogleScopes(true)).toEqual([...GOOGLE_ALL_SCOPES]);
  });

  it("only enables sensitive scopes for the exact opt-in flag values", () => {
    expect(parseSensitiveScopesFlag("true")).toBe(true);
    expect(parseSensitiveScopesFlag("1")).toBe(true);
    expect(parseSensitiveScopesFlag(undefined)).toBe(false);
    expect(parseSensitiveScopesFlag("")).toBe(false);
    expect(parseSensitiveScopesFlag("false")).toBe(false);
    expect(parseSensitiveScopesFlag("TRUE")).toBe(false);
    expect(parseSensitiveScopesFlag(true as unknown)).toBe(false);
  });
});
