import { describe, expect, it } from "vitest";
import { systemPrompt } from "./system-prompt";

describe("systemPrompt", () => {
  const fixedDate = new Date(2026, 6, 17, 12, 0, 0); // 2026-07-17 (Friday)

  it("frames solo autonomous runs with date-only context and no-web honesty", () => {
    const prompt = systemPrompt("autonomous", { search: false, fetchPage: false }, undefined, undefined, fixedDate);

    expect(prompt).toContain("You are WasmHatch, a general AI agent running entirely inside the user's browser tab.");
    expect(prompt).toContain("Today is Friday, 2026-07-17");
    expect(prompt).toContain("Act decisively: writes apply immediately");
    expect(prompt).toContain("You cannot browse or search the web in this session");
    expect(prompt).not.toContain("BEGIN PACKAGED PLAYBOOK");
  });

  it("includes swarm coworkers, careful policy, web search + fetch_page, scheduled posture, and confined playbook markers", () => {
    const prompt = systemPrompt(
      "careful",
      { search: true, fetchPage: true },
      { name: "Mame", coworkers: ["Pip", "Yuzu"], scheduled: true },
      "  Focus on CSV reconciliation.  ",
      fixedDate
    );

    expect(prompt).toContain("You are Mame, a WasmHatch hatchling");
    expect(prompt).toContain("working alongside Pip, Yuzu.");
    expect(prompt).toContain("The user chose careful mode:");
    expect(prompt).toContain("use web_search rather than answering from memory.");
    expect(prompt).toContain("After a web_search, fetch_page can read a promising result in full from its URL.");
    expect(prompt).toContain("This is a scheduled check-in with no user present:");
    expect(prompt).toContain("--- BEGIN PACKAGED PLAYBOOK --- Focus on CSV reconciliation. --- END PACKAGED PLAYBOOK ---");
  });
});
