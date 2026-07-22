import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-po";
import { LOCALE_CODES, SOURCE_LOCALE } from "./src/lib/locales";

export default defineConfig({
  sourceLocale: SOURCE_LOCALE,
  locales: [...LOCALE_CODES],
  catalogs: [
    {
      path: "<rootDir>/src/locales/{locale}",
      include: ["src"],
      exclude: ["**/node_modules/**", "**/*.test.ts", "**/*.test.tsx"]
    }
  ],
  format: formatter({ lineNumbers: false }),
  fallbackLocales: { default: SOURCE_LOCALE }
});
