import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// This file shadows vite.config.ts for Vitest, so merge the app config in —
// tests need the same transform pipeline as the build (Lingui macro
// compilation and .po catalog imports).
export default mergeConfig(
  viteConfig({ command: "serve", mode: "test" }),
  defineConfig({
    test: {
      environment: "node",
      include: ["src/**/*.test.{ts,tsx}"],
      exclude: ["e2e/**", "node_modules/**", "dist/**"]
    }
  })
);
