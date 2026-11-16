import { expect, test, type Page } from "@playwright/test";

async function installBuiltinModel(page: Page, initialStatus: "downloadable" | "downloading", failFirst = false) {
  await page.addInitScript(({ initialStatus, failFirst }) => {
    let status: string = initialStatus;
    let progress: ((event: { loaded: number }) => void) | undefined;
    let finish: (() => void) | undefined;
    let attempts = 0;
    const calls: { activated: boolean; destroyed: boolean; prompts: string[] }[] = [];
    const availabilityLanguages: string[][] = [];
    const api = {
      async availability(options?: { expectedOutputs?: { languages: string[] }[] }) {
        if (this !== api) throw new TypeError("Illegal invocation");
        availabilityLanguages.push(options?.expectedOutputs?.[0]?.languages ?? []);
        return status;
      },
      async create(options: {
        monitor?: (monitor: { addEventListener: (type: string, listener: (event: { loaded: number }) => void) => void }) => void;
      }) {
        if (this !== api) throw new TypeError("Illegal invocation");
        const call = { activated: navigator.userActivation.isActive, destroyed: false, prompts: [] as string[] };
        calls.push(call);
        if (status !== "available") {
          if (!call.activated) throw new DOMException("A user gesture is required.", "NotAllowedError");
          if (failFirst && attempts++ === 0) throw new DOMException("Download was declined.", "NotAllowedError");
          status = "downloading";
          options.monitor?.({ addEventListener: (_type, listener) => { progress = listener; } });
          progress?.({ loaded: 0.25 });
          await new Promise<void>((resolve) => { finish = resolve; });
          status = "available";
        }
        return {
          async prompt(input: string) {
            call.prompts.push(input);
            return JSON.stringify({ action: "final", answer: "Ready to help on-device." });
          },
          destroy() { call.destroyed = true; }
        };
      }
    };
    Object.defineProperty(window, "LanguageModel", { configurable: true, value: api });
    Object.assign(window, {
      builtinTest: {
        calls,
        availabilityLanguages,
        finish() { progress?.({ loaded: 1 }); finish?.(); },
        setAvailable() { status = "available"; }
      }
    });
  }, { initialStatus, failFirst });
}

for (const initialStatus of ["downloadable", "downloading"] as const) {
  test(`prepares a ${initialStatus} Chrome model from a user gesture and runs a prompt`, async ({ page }) => {
    await installBuiltinModel(page, initialStatus);
    await page.goto("/?view=chat");
    await page.getByLabel("Provider").selectOption("builtin");
    const prepare = page.getByRole("button", { name: "Prepare on-device model" });
    await expect(prepare).toBeEnabled();
    await prepare.click();
    await expect(page.getByRole("button", { name: "Preparing…" })).toBeDisabled();
    await expect(page.getByRole("progressbar", { name: "On-device model download" })).toHaveAttribute("value", "0.25");
    await page.evaluate(() => {
      (window as unknown as { builtinTest: { finish: () => void } }).builtinTest.finish();
    });
    await expect(page.getByText("The on-device model is ready.", { exact: true })).toBeVisible();
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    await page.getByLabel("Message the agent").fill("Say hello locally.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator(".chat-assistant").last()).toHaveText("Ready to help on-device.");
    const calls = await page.evaluate(() => (
      window as unknown as { builtinTest: { calls: { activated: boolean; destroyed: boolean; prompts: string[] }[] } }
    ).builtinTest.calls);
    expect(calls[0]).toEqual({ activated: true, destroyed: true, prompts: [] });
    expect(calls.slice(1).some((call) => call.prompts.length > 0 && call.destroyed)).toBe(true);
  });
}

test("allows retry after a model download failure", async ({ page }) => {
  await installBuiltinModel(page, "downloadable", true);
  await page.goto("/?view=chat");
  await page.getByLabel("Provider").selectOption("builtin");
  const prepare = page.getByRole("button", { name: "Prepare on-device model" });
  await prepare.click();
  await expect(page.getByText("Could not prepare the on-device model: Download was declined.", { exact: true })).toBeVisible();
  await expect(prepare).toBeEnabled();
  await prepare.click();
  await expect(page.getByRole("progressbar")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { builtinTest: { finish: () => void } }).builtinTest.finish();
  });
  await expect(page.getByText("The on-device model is ready.", { exact: true })).toBeVisible();
});

test("refreshes Chrome model availability when returning to the app", async ({ page }) => {
  await installBuiltinModel(page, "downloadable");
  await page.goto("/?view=chat");
  await page.getByLabel("Provider").selectOption("builtin");
  await expect(page.getByRole("button", { name: "Prepare on-device model" })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { builtinTest: { setAvailable: () => void } }).builtinTest.setAvailable();
    window.dispatchEvent(new Event("focus"));
  });
  await expect(page.getByRole("button", { name: "Prepare on-device model" })).toHaveCount(0);
  await expect(page.getByLabel("Provider")).toHaveValue("builtin");
  await expect(page.locator('option[value="builtin"]')).toHaveText("Built into Chrome — free, no key");
});

test("checks Chrome model support again after changing the interface language", async ({ page }) => {
  await installBuiltinModel(page, "downloadable");
  await page.goto("/?view=chat");
  await expect(page.getByRole("button", { name: "Prepare on-device model" })).toBeVisible();
  await page.getByLabel("Language").selectOption("ja");
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { builtinTest: { availabilityLanguages: string[][] } }
  ).builtinTest.availabilityLanguages.some((languages) => languages.includes("ja")))).toBe(true);
});
