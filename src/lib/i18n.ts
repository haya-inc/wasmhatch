/**
 * i18n runtime — loads Lingui catalogs and keeps the document in sync.
 *
 * The stored preference is either a locale code from the registry or
 * "auto" (follow navigator.languages). React re-renders through
 * I18nProvider when a catalog is activated, so switching languages never
 * reloads the page — important because hatchling runs live in this tab.
 */

import { i18n } from "@lingui/core";
import { AUTO_LOCALE, SOURCE_LOCALE, isSupportedLocale, resolveLocale } from "./locales";

export { i18n };

const STORAGE_KEY = "wasmhatch-locale-v1";

function readStoredPreference(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && (raw === AUTO_LOCALE || isSupportedLocale(raw))) return raw;
  } catch {
    // Blocked storage falls back to auto-detection.
  }
  return AUTO_LOCALE;
}

function writeStoredPreference(preference: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Persistence is best-effort; the session still switches.
  }
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages && navigator.languages.length > 0
    ? navigator.languages
    : [navigator.language].filter(Boolean);
}

function effectiveLocale(preference: string): string {
  return preference === AUTO_LOCALE ? resolveLocale(browserLanguages()) : preference;
}

async function loadCatalog(locale: string): Promise<void> {
  const { messages } = await import(`../locales/${locale}.po`);
  i18n.load(locale, messages);
}

async function activate(locale: string): Promise<void> {
  try {
    await loadCatalog(locale);
    i18n.activate(locale);
  } catch {
    // A missing or broken catalog must never take the app down.
    if (locale !== SOURCE_LOCALE) {
      await loadCatalog(SOURCE_LOCALE).catch(() => i18n.load(SOURCE_LOCALE, {}));
      i18n.activate(SOURCE_LOCALE);
    } else {
      i18n.load(SOURCE_LOCALE, {});
      i18n.activate(SOURCE_LOCALE);
    }
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = i18n.locale;
  }
}

/** The stored preference ("auto" or a locale code) for the settings UI. */
export function localePreference(): string {
  return readStoredPreference();
}

/** The locale the UI is currently rendered in. */
export function activeLocale(): string {
  return i18n.locale || effectiveLocale(readStoredPreference());
}

/** Activate the stored (or auto-detected) locale. Call once before first render. */
export async function initI18n(): Promise<void> {
  await activate(effectiveLocale(readStoredPreference()));
}

/** Persist a preference ("auto" or a locale code) and switch to it in place. */
export async function setLocalePreference(preference: string): Promise<void> {
  const next = preference === AUTO_LOCALE || isSupportedLocale(preference) ? preference : AUTO_LOCALE;
  writeStoredPreference(next);
  await activate(effectiveLocale(next));
}
