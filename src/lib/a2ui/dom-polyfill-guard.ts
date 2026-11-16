// `@a2ui/react` declares `class ReactWcHost extends HTMLElement` at module
// evaluation time. Defining a minimal stub when `HTMLElement` is absent allows
// headless Node/SSR/Vitest suites (`HatchlingSwarm`, `HatchlingA2uiRuntime`) to
// import the catalog cleanly while remaining a no-op in every browser.
if (typeof globalThis.HTMLElement === "undefined") {
  (globalThis as Record<string, unknown>).HTMLElement = class {};
}
export {};
