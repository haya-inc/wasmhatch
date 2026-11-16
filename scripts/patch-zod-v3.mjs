import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

// A2UI 0.15 still requires the Zod 3 schema API. Zod 4.6.7 fixes the native
// v4 parser, but its bundled v3 compatibility parser retains CVE-2023-54404.
// Backport the actual early-abort behavior from the upstream fix:
// https://github.com/colinhacks/zod/commit/a0ebf97
// https://github.com/colinhacks/zod/issues/6653
// Keep the original package identity/version and all license headers intact.
const EXPECTED_VERSION = "4.6.7";
const packageRoot = new URL("../node_modules/zod/", import.meta.url);
const checkOnly = process.argv.includes("--check");
if (process.argv.slice(2).some((argument) => argument !== "--check")) {
  throw new Error("Usage: node scripts/patch-zod-v3.mjs [--check]");
}

const targets = [
  {
    path: "v3/types.js",
    originalSha256: "d7214e1dacf9e6e70c9ca80247717b4be13b240510428fef132b7da3260d1a32",
    patchedSha256: "9e2603da4e33a4a3d1a598da4c22ec5ab9d0e4d10cc2cc0083dff4c370c04a00"
  },
  {
    path: "v3/types.cjs",
    originalSha256: "7a2f06d88e280bdd198c60e0d292ed7f1e3993e877be4415de07e6abc7746dd1",
    patchedSha256: "ede8d4486ba7a8e41cf8cf6eb1f99bd53f6c322a1dc2faab1fad718d65eb4040"
  },
  {
    path: "src/v3/types.ts",
    originalSha256: "73b9529564a34fc028a5a62c17e09148747b737039b78b124e84254cb886411a",
    patchedSha256: "c9a8fdd8ed7c4d5fac972799001f3ecc609d315a46e2f60d2265a31d8a200935"
  }
];

// The v4 parser is already fixed upstream and must remain byte-for-byte intact.
const untouchedV4 = [
  ["v4/core/schemas.js", "0ee56e8afbae28eeb1060a162ad7e56f0675ee6fb83f0ae56bea2e088f6cdbc0"],
  ["v4/core/schemas.cjs", "7e35563b275bcc457a6d8ae0f5e1354b3c499ddd38401439f16bed1b8f357e41"]
];

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function replaceOnce(source, pattern, replacement, label) {
  let count = 0;
  const result = source.replace(pattern, (...match) => {
    count += 1;
    return replacement(...match);
  });
  if (count !== 1) throw new Error(`Unexpected Zod source at ${label}: matched ${count} sites.`);
  return result;
}

function backport(source, path) {
  const invalid = path.endsWith(".cjs") ? "parseUtil_js_1.INVALID" : "INVALID";
  let result = source;
  for (const field of ["exactLength", "maxLength", "maxSize"]) {
    const pattern = new RegExp(
      `(message: def\\.${field}\\.message,\\n\\s*\\}\\);\\n)([ \\t]*)status\\.dirty\\(\\);`,
      "g"
    );
    result = replaceOnce(result, pattern, (_match, prefix, indent) => {
      // A too-small exact-length array keeps its normal validation semantics.
      // An oversized array/set aborts before spread, element parsing or refine.
      return field === "exactLength"
        ? `${prefix}${indent}if (tooBig) return ${invalid};\n${indent}status.dirty();`
        : `${prefix}${indent}return ${invalid};`;
    }, `${path}:${field}`);
  }
  // A tuple without rest is another array with a fixed upper bound.
  return replaceOnce(result,
    /(if \(!rest && ctx\.data\.length > this\._def\.items\.length\) \{[\s\S]*?\n)([ \t]*)status\.dirty\(\);/g,
    (_match, prefix, indent) => `${prefix}${indent}return ${invalid};`,
    `${path}:tuple`
  );
}

async function main() {
  const manifest = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));
  if (manifest.name !== "zod" || manifest.version !== EXPECTED_VERSION) {
    throw new Error(`Expected official zod@${EXPECTED_VERSION}; review this backport before upgrading Zod.`);
  }
  for (const [path, expectedHash] of untouchedV4) {
    if (sha256(await readFile(new URL(path, packageRoot), "utf8")) !== expectedHash) {
      throw new Error(`Unexpected modification of the upstream Zod 4 parser: ${path}. Run npm ci.`);
    }
  }
  // Validate every input and output before writing any files. An unknown source
  // or a partial/altered patch fails closed instead of silently skipping a fix.
  const pending = [];
  for (const target of targets) {
    const url = new URL(target.path, packageRoot);
    const source = await readFile(url, "utf8");
    const hash = sha256(source);
    if (hash === target.patchedSha256) continue;
    if (checkOnly) {
      throw new Error(`Zod v3 security backport is missing or altered (${target.path}). Run npm run patch:dependencies.`);
    }
    if (hash !== target.originalSha256) {
      throw new Error(`Unknown Zod source (${target.path}). Run npm ci or review the backport; refusing to patch.`);
    }
    const patched = backport(source, target.path);
    if (sha256(patched) !== target.patchedSha256) {
      throw new Error(`Zod patch output did not match its reviewed hash: ${target.path}.`);
    }
    pending.push([url, patched]);
  }
  for (const [url, patched] of pending) await writeFile(url, patched, "utf8");
  console.log(checkOnly
    ? "Verified the Zod v3 security backport and unchanged upstream v4 parser."
    : "Applied and verified the Zod v3 collection-bounds security backport.");
}

await main();
