/**
 * Locale registry — the single source of truth for UI languages.
 *
 * Everything language-related derives from this list: the language picker,
 * catalog loading, `<html lang>`, the translation script's target matrix,
 * and the built-in-model language declarations. Adding a language means
 * adding one entry here and filling the catalog (see docs/i18n.md).
 */

export interface UiLocale {
  /** BCP 47 tag; also the catalog file name under src/locales/. */
  code: string;
  /** Native name (endonym) shown in the language picker. */
  label: string;
}

/** The language source strings are written in; never needs a catalog. */
export const SOURCE_LOCALE = "en";

/** Stored preference meaning "follow the browser language". */
export const AUTO_LOCALE = "auto";

export const UI_LOCALES: readonly UiLocale[] = [
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "zh-Hans", label: "简体中文" },
  { code: "zh-Hant", label: "繁體中文" },
  { code: "ko", label: "한국어" },
  { code: "es", label: "Español" },
  { code: "pt-BR", label: "Português (Brasil)" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "it", label: "Italiano" },
  { code: "ru", label: "Русский" },
  { code: "uk", label: "Українська" },
  { code: "pl", label: "Polski" },
  { code: "nl", label: "Nederlands" },
  { code: "tr", label: "Türkçe" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "vi", label: "Tiếng Việt" },
  { code: "th", label: "ไทย" }
];

export const LOCALE_CODES: readonly string[] = UI_LOCALES.map((locale) => locale.code);

export function isSupportedLocale(code: string): boolean {
  return UI_LOCALES.some((locale) => locale.code.toLowerCase() === code.toLowerCase());
}

interface LocaleShape {
  language: string;
  script: string;
}

/** Resolve a tag to its likely language+script (zh-TW -> zh/Hant); null for garbage tags. */
function likelyShape(tag: string): LocaleShape | null {
  try {
    const maximized = new Intl.Locale(tag).maximize();
    return { language: maximized.language, script: maximized.script ?? "" };
  } catch {
    return null;
  }
}

/**
 * Pick the best supported locale for an ordered list of requested tags
 * (usually navigator.languages). Match order per requested tag: exact tag,
 * then same language+script (zh-TW -> zh-Hant), then same base language
 * (pt-PT -> pt-BR). Falls back to the source locale.
 */
export function resolveLocale(requested: readonly string[]): string {
  const supported = UI_LOCALES.map((locale) => ({
    code: locale.code,
    shape: likelyShape(locale.code)
  }));

  for (const tag of requested) {
    if (typeof tag !== "string" || !tag) continue;
    const exact = supported.find((entry) => entry.code.toLowerCase() === tag.toLowerCase());
    if (exact) return exact.code;

    const shape = likelyShape(tag);
    if (!shape) continue;
    const scriptMatch = supported.find(
      (entry) => entry.shape?.language === shape.language && entry.shape?.script === shape.script
    );
    if (scriptMatch) return scriptMatch.code;
    const languageMatch = supported.find((entry) => entry.shape?.language === shape.language);
    if (languageMatch) return languageMatch.code;
  }
  return SOURCE_LOCALE;
}
