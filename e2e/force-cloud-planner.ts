import type { Page } from "@playwright/test";

/**
 * Pin Chrome's built-in AI (Prompt API) to "unavailable" for tests that
 * exercise the OpenAI planner path. Chromium may ship the Prompt API, and
 * when built-in AI reports anything but "unavailable" the operator
 * auto-selects it, hiding the OpenAI key field. Tests that want the
 * built-in path define their own LanguageModel mock instead.
 */
export async function forceCloudPlanner(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "LanguageModel", {
      configurable: true,
      value: { availability: async () => "unavailable" }
    });
  });
}
