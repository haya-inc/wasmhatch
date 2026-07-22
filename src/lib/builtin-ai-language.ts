/**
 * Language declarations for Chrome's built-in model (Prompt API).
 *
 * The Prompt API accepts only a fixed set of languages ("en", "ja", "es",
 * "de", "fr" as of Chrome's 2026-05 docs) and rejects create()/availability()
 * with a NotSupportedError DOMException when anything else is declared. The
 * UI locale therefore only joins the declaration when the model supports its
 * base language; other locales keep the English-only declaration, and cloud
 * BYOK providers remain the path to responses in those languages.
 */

import { activeLocale } from "./i18n";

export const PROMPT_API_LANGUAGES: readonly string[] = Object.freeze(["en", "ja", "es", "de", "fr"]);

export interface BuiltinLanguageOptions {
  expectedInputs: readonly { type: "text"; languages: readonly string[] }[];
  expectedOutputs: readonly { type: "text"; languages: readonly string[] }[];
}

function frozenOptions(languages: readonly string[]): BuiltinLanguageOptions {
  const list = Object.freeze([...languages]);
  return Object.freeze({
    expectedInputs: Object.freeze([{ type: "text" as const, languages: list }]),
    expectedOutputs: Object.freeze([{ type: "text" as const, languages: list }])
  });
}

const ENGLISH_ONLY = frozenOptions(["en"]);

/**
 * Build expectedInputs/expectedOutputs for the given UI locale (defaults to
 * the active one). English is always declared — prompts are English — and the
 * locale's base language is added when the Prompt API supports it.
 */
export function builtinLanguageOptions(locale: string = activeLocale()): BuiltinLanguageOptions {
  const base = (locale || "").split("-")[0].toLowerCase();
  if (!base || base === "en" || !PROMPT_API_LANGUAGES.includes(base)) return ENGLISH_ONLY;
  return frozenOptions(["en", base]);
}

function isNotSupportedError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotSupportedError";
}

/**
 * Run a Prompt API call with the locale-aware declaration, retrying once with
 * the English-only declaration if the browser rejects the language list —
 * so a Chrome release shrinking its language support degrades output language
 * instead of turning the built-in provider off.
 */
export async function callWithLanguageFallback<T>(
  run: (options: BuiltinLanguageOptions) => Promise<T>,
  locale: string = activeLocale()
): Promise<T> {
  const preferred = builtinLanguageOptions(locale);
  try {
    return await run(preferred);
  } catch (error) {
    if (preferred === ENGLISH_ONLY || !isNotSupportedError(error)) throw error;
    return run(ENGLISH_ONLY);
  }
}
