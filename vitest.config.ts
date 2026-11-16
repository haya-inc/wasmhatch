import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

// This file shadows vite.config.ts for Vitest, so merge the app config in —
// tests need the same transform pipeline as the build (Lingui macro
// compilation and .po catalog imports).
export default mergeConfig(
  viteConfig({ command: "serve", mode: "test" }),
  defineConfig({
    test: {
      environment: "node",
      // Keep A2UI imports inside Vite so the patched zod/v3 alias also applies
      // to its dependencies rather than being bypassed by Node externalization.
      server: { deps: { inline: [/@a2ui\//] } },
      include: ["src/**/*.test.{ts,tsx}"],
      exclude: ["e2e/**", "node_modules/**", "dist/**"]
    }
  })
);
