#!/usr/bin/env node
/**
 * Validate src/locales/*.po catalogs without touching the network.
 *
 *   npm run i18n:check            # all locales
 *   npm run i18n:check -- ja ko   # some locales
 *
 * Checks, per non-source catalog:
 * - every en.po entry exists in the catalog (a truncated or stale file
 *   fails loudly instead of passing with fewer entries);
 * - every entry has a translation (no empty msgstr);
 * - `{placeholder}` sets survive the translation verbatim;
 * - ICU plural messages keep the plural skeleton, the same variable,
 *   an `other` branch, and the `#` count.
 *
 * Translations themselves are written by hand or by an agent and reviewed
 * as a normal git diff; this script is the machine-checkable part.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const LOCALES_DIR = path.join(import.meta.dirname, "..", "src", "locales");
const SOURCE_LOCALE = "en";

function parseArgs(argv) {
  const locales = argv.filter((arg) => !arg.startsWith("-"));
  return { onlyLocales: locales.length ? new Set(locales) : null };
}

function unescapePo(value) {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/**
 * Minimal parser for the Lingui-generated PO shape: header entry first,
 * then entries of comment lines + `msgid "..."` + `msgstr "..."` with
 * optional `"..."` continuation lines.
 */
function parsePo(text) {
  const lines = text.split("\n");
  const entries = [];
  let index = 0;

  function readString(startIndex, keyword) {
    const first = lines[startIndex];
    let value = first.slice(keyword.length).trim();
    if (!value.startsWith('"') || !value.endsWith('"')) {
      throw new Error(`Malformed ${keyword} at line ${startIndex + 1}`);
    }
    value = value.slice(1, -1);
    let end = startIndex;
    while (end + 1 < lines.length && /^\s*"/.test(lines[end + 1])) {
      end += 1;
      const cont = lines[end].trim();
      value += cont.slice(1, -1);
    }
    return { value: unescapePo(value), endIndex: end };
  }

  while (index < lines.length) {
    if (!lines[index].startsWith("msgid ")) {
      index += 1;
      continue;
    }
    const id = readString(index, "msgid ");
    let cursor = id.endIndex + 1;
    while (cursor < lines.length && !lines[cursor].startsWith("msgstr ")) cursor += 1;
    if (cursor >= lines.length) throw new Error(`msgid without msgstr near line ${index + 1}`);
    const str = readString(cursor, "msgstr ");
    if (id.value !== "") {
      entries.push({ msgid: id.value, msgstr: str.value, line: index + 1 });
    }
    index = str.endIndex + 1;
  }
  return entries;
}

/** Simple `{name}` placeholders (not ICU plural skeletons). */
function simplePlaceholders(message) {
  return (message.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort();
}

function isPlural(message) {
  return /\{\s*[a-zA-Z0-9_]+\s*,\s*plural\s*,/.test(message);
}

/** Returns a problem description, or null when the translation is sound. */
function validateTranslation(source, translation) {
  if (!translation || !translation.trim()) return "missing translation";
  if (/```/.test(translation)) return "contains a code fence";
  if (isPlural(source)) {
    const head = source.match(/\{\s*([a-zA-Z0-9_]+)\s*,\s*plural\s*,/)[1];
    if (!new RegExp(`\\{\\s*${head}\\s*,\\s*plural\\s*,`).test(translation)) {
      return "lost the ICU plural skeleton";
    }
    if (!/other\s*\{/.test(translation)) return "missing the plural 'other' branch";
    if (source.includes("#") && !translation.includes("#")) return "dropped the '#' count";
    return null;
  }
  const expected = simplePlaceholders(source).join("|");
  const actual = simplePlaceholders(translation).join("|");
  if (expected !== actual) return `placeholders changed (${expected || "none"} -> ${actual || "none"})`;
  return null;
}

async function main() {
  const { onlyLocales } = parseArgs(process.argv.slice(2));
  const files = (await readdir(LOCALES_DIR))
    .filter((name) => name.endsWith(".po"))
    .map((name) => ({ locale: name.replace(/\.po$/, ""), filePath: path.join(LOCALES_DIR, name) }))
    .filter(({ locale }) => locale !== SOURCE_LOCALE)
    .filter(({ locale }) => !onlyLocales || onlyLocales.has(locale));
  if (!files.length) {
    console.error("No matching locale catalogs found under src/locales/.");
    process.exit(1);
  }

  const sourceIds = parsePo(await readFile(path.join(LOCALES_DIR, `${SOURCE_LOCALE}.po`), "utf8"))
    .map((entry) => entry.msgid);

  let problems = 0;
  for (const { locale, filePath } of files) {
    const entries = parsePo(await readFile(filePath, "utf8"));
    const present = new Set(entries.map((entry) => entry.msgid));
    const absent = sourceIds.filter((msgid) => !present.has(msgid));
    const bad = entries
      .map((entry) => ({ ...entry, problem: validateTranslation(entry.msgid, entry.msgstr) }))
      .filter((entry) => entry.problem);
    if (!bad.length && !absent.length) {
      console.log(`${locale}: ok (${entries.length} messages)`);
      continue;
    }
    problems += bad.length + absent.length;
    for (const msgid of absent) {
      console.error(`${locale}: "${msgid.slice(0, 60)}" — entry absent (truncated or stale catalog; run i18n:extract)`);
    }
    for (const entry of bad) {
      console.error(`${locale}:${entry.line}: "${entry.msgid.slice(0, 60)}" — ${entry.problem}`);
    }
  }
  if (problems) {
    console.error(`\n${problems} problem(s). Fix the catalogs and re-run.`);
    process.exit(2);
  }
  console.log("\nAll catalogs are complete and well-formed.");
}

await main();
