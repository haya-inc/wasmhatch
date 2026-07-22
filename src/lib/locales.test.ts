import { describe, expect, it } from "vitest";
import { LOCALE_CODES, SOURCE_LOCALE, UI_LOCALES, isSupportedLocale, resolveLocale } from "./locales";

describe("locale registry", () => {
  it("keeps codes unique and resolvable by Intl", () => {
    expect(new Set(LOCALE_CODES).size).toBe(LOCALE_CODES.length);
    for (const code of LOCALE_CODES) {
      expect(() => new Intl.Locale(code)).not.toThrow();
    }
  });

  it("labels every locale with a non-empty endonym", () => {
    for (const locale of UI_LOCALES) {
      expect(locale.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("treats codes case-insensitively", () => {
    expect(isSupportedLocale("PT-br")).toBe(true);
    expect(isSupportedLocale("xx")).toBe(false);
  });
});

describe("resolveLocale", () => {
  it("prefers an exact tag match", () => {
    expect(resolveLocale(["ja"])).toBe("ja");
    expect(resolveLocale(["pt-BR"])).toBe("pt-BR");
  });

  it("maps region tags to the right script for Chinese", () => {
    expect(resolveLocale(["zh-CN"])).toBe("zh-Hans");
    expect(resolveLocale(["zh-SG"])).toBe("zh-Hans");
    expect(resolveLocale(["zh-TW"])).toBe("zh-Hant");
    expect(resolveLocale(["zh-HK"])).toBe("zh-Hant");
  });

  it("falls back from region variants to the base language", () => {
    expect(resolveLocale(["ja-JP"])).toBe("ja");
    expect(resolveLocale(["fr-CA"])).toBe("fr");
    expect(resolveLocale(["pt-PT"])).toBe("pt-BR");
    expect(resolveLocale(["de-AT"])).toBe("de");
  });

  it("honors the order of browser preferences", () => {
    expect(resolveLocale(["da", "ja", "en"])).toBe("ja");
    expect(resolveLocale(["da-DK", "sv"])).toBe(SOURCE_LOCALE);
  });

  it("skips garbage tags without crashing", () => {
    expect(resolveLocale(["not a tag!", "", "ko-KR"])).toBe("ko");
    expect(resolveLocale([])).toBe(SOURCE_LOCALE);
  });
});
