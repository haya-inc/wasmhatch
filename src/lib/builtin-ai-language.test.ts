import { describe, expect, it, vi } from "vitest";
import { builtinLanguageOptions, callWithLanguageFallback } from "./builtin-ai-language";

describe("builtinLanguageOptions", () => {
  it("declares English plus the UI language when the Prompt API supports it", () => {
    for (const locale of ["ja", "es", "de", "fr"]) {
      const options = builtinLanguageOptions(locale);
      expect(options.expectedInputs[0].languages).toEqual(["en", locale]);
      expect(options.expectedOutputs[0].languages).toEqual(["en", locale]);
    }
  });

  it("reduces region variants to their base language", () => {
    expect(builtinLanguageOptions("fr-CA").expectedOutputs[0].languages).toEqual(["en", "fr"]);
  });

  it("stays English-only for unsupported locales", () => {
    for (const locale of ["en", "zh-Hans", "ko", "th", "pt-BR", ""]) {
      const options = builtinLanguageOptions(locale);
      expect(options.expectedInputs[0].languages).toEqual(["en"]);
      expect(options.expectedOutputs[0].languages).toEqual(["en"]);
    }
  });
});

describe("callWithLanguageFallback", () => {
  it("passes the locale-aware options through on success", async () => {
    const run = vi.fn(async (options: unknown) => options);
    const result = await callWithLanguageFallback(run, "ja");
    expect(run).toHaveBeenCalledOnce();
    expect((result as ReturnType<typeof builtinLanguageOptions>).expectedOutputs[0].languages).toEqual(["en", "ja"]);
  });

  it("retries once with English when the language list is rejected", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new DOMException("bad languages", "NotSupportedError"))
      .mockResolvedValueOnce("ok");
    await expect(callWithLanguageFallback(run, "ja")).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0].expectedOutputs[0].languages).toEqual(["en"]);
  });

  it("does not retry for other errors or when already English-only", async () => {
    const boom = new Error("network");
    const failing = vi.fn().mockRejectedValue(boom);
    await expect(callWithLanguageFallback(failing, "ja")).rejects.toBe(boom);
    expect(failing).toHaveBeenCalledOnce();

    const rejectingEnglish = vi.fn().mockRejectedValue(new DOMException("no", "NotSupportedError"));
    await expect(callWithLanguageFallback(rejectingEnglish, "en")).rejects.toBeInstanceOf(DOMException);
    expect(rejectingEnglish).toHaveBeenCalledOnce();
  });
});
