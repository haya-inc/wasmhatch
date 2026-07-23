/**
 * Glue between hatchlings and the portable agent format.
 *
 * A hatchling's shareable profile is exactly what the package carries:
 * instructions (the entrypoint file), starter workspace files, and declared
 * capabilities (hatchling-capabilities vocabulary). This module builds the
 * export draft from a live thread, derives the hatch profile from a read
 * package, and speaks the registry's tiny HTTP API. The registry stays
 * optional: local file import/export works with no service at all.
 */

import {
  PORTABLE_AGENT_MEDIA_TYPE,
  createPortableAgentPackage,
  type PortableAgentExample,
  type PortableAgentManifest,
  type PortableAgentPackage
} from "./agent-package";
import { HATCHLING_CAPABILITY_IDS } from "./hatchling-capabilities";
import { MAX_INSTRUCTION_CHARS, type HatchlingProfile, type HatchlingThread } from "./agent-threads";
import { isProtectedAgentPath } from "./secrets";
import type { WorkspaceFile } from "./workspace";

export const PORTABLE_ENTRYPOINT = "AGENTS.md";

/** Deployment-baked registry origin (VITE_REGISTRY_URL); undefined = none. */
export function registryBaseUrl(): string | undefined {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const raw = env?.VITE_REGISTRY_URL;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Lowercase-slugs a hatchling name into a valid portable agent id. */
export function portableAgentId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  const valid = /^[a-z][a-z0-9-]*$/.test(slug) ? slug : "";
  return valid || "hatchling";
}

/** The hatch profile a validated package asks for. */
export function hatchProfileFromPackage(pkg: PortableAgentPackage): HatchlingProfile & { seedFiles: readonly WorkspaceFile[] } {
  const entry = pkg.files.find((file) => file.path === pkg.manifest.entrypoint);
  return {
    name: pkg.manifest.name,
    instructions: (entry?.content ?? "").trim().slice(0, MAX_INSTRUCTION_CHARS),
    capabilities: pkg.manifest.permissions.tools,
    seedFiles: pkg.files
  };
}

export interface PortableExportMeta {
  summary?: string;
  version?: string;
  license?: string;
  examples?: readonly PortableAgentExample[];
}

/**
 * Packages a hatchling: its workspace files (protected credential paths
 * excluded twice — here and again inside the package validator) plus a
 * synthesized entrypoint when the workspace has none.
 */
export async function buildPortableHatchling(
  thread: HatchlingThread,
  workspaceFiles: readonly WorkspaceFile[],
  meta: PortableExportMeta = {}
): Promise<PortableAgentPackage> {
  const files = workspaceFiles.filter((file) => !isProtectedAgentPath(file.path));
  if (!files.some((file) => file.path === PORTABLE_ENTRYPOINT)) {
    const body = thread.instructions.trim() || `You are ${thread.name}, a WasmHatch hatchling. Do the user's task with your available tools.`;
    files.unshift({ path: PORTABLE_ENTRYPOINT, content: `${body}\n` });
  }
  return createPortableAgentPackage({
    id: portableAgentId(thread.name),
    name: thread.name,
    summary: (meta.summary ?? "").trim() || `${thread.name} — a portable WasmHatch hatchling.`,
    version: (meta.version ?? "").trim() || "1.0.0",
    license: (meta.license ?? "").trim() || "Apache-2.0",
    entrypoint: PORTABLE_ENTRYPOINT,
    permissions: {
      tools: thread.capabilities ?? [...HATCHLING_CAPABILITY_IDS],
      networkOrigins: []
    },
    examples: meta.examples ?? []
  }, files);
}

export function portableFileName(manifest: PortableAgentManifest): string {
  return `${manifest.id}-${manifest.version}.agent`;
}

// ----- Registry client (the optional hosted service) -----

export interface RegistryPublishResult {
  publisherId: string;
  agentId: string;
  /** Digest of the revision this publish created (or re-confirmed). */
  sha256: string;
  /**
   * True while the revision sits in the registry's quarantine window —
   * accepted, owner-fetchable, but not yet on any public surface.
   */
  quarantined: boolean;
  /** Instant the quarantine window elapses; null when already public. */
  quarantineUntil: string | null;
}

function requireRegistryUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** POSTs a package to the registry; the token stays in the caller's memory. */
export async function publishToRegistry(
  baseUrl: string,
  token: string,
  pkg: PortableAgentPackage,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}
): Promise<RegistryPublishResult> {
  if (!token.trim()) throw new Error("A registry publish token is required.");
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const copy = new Uint8Array(pkg.bytes.byteLength);
  copy.set(pkg.bytes);
  let response: Response;
  try {
    response = await fetchImpl(`${requireRegistryUrl(baseUrl)}/v1/agents`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": PORTABLE_AGENT_MEDIA_TYPE
      },
      body: copy.buffer,
      signal: options.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error("The registry could not be reached. Check the network and the deployment's registry configuration.");
  }
  let body: {
    error?: unknown;
    message?: unknown;
    publisherId?: unknown;
    agentId?: unknown;
    latestSha256?: unknown;
    revision?: { sha256?: unknown; state?: unknown; quarantineUntil?: unknown };
  };
  try {
    body = await response.json() as typeof body;
  } catch {
    throw new Error(`The registry returned an unreadable response (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const message = typeof body.message === "string" && body.message ? body.message : `HTTP ${response.status}`;
    throw new Error(`The registry declined the publish: ${message}`);
  }
  // The revision digest is authoritative: with quarantine enabled a brand-new
  // agent has latestSha256 null until promotion, so that field cannot be
  // required (docs/revision-lifecycle.md in the registry repository).
  const sha256 = typeof body.revision?.sha256 === "string" && body.revision.sha256
    ? body.revision.sha256
    : typeof body.latestSha256 === "string" ? body.latestSha256 : "";
  if (typeof body.publisherId !== "string" || typeof body.agentId !== "string" || !sha256) {
    throw new Error("The registry returned an incomplete publish result.");
  }
  return {
    publisherId: body.publisherId,
    agentId: body.agentId,
    sha256,
    quarantined: body.revision?.state === "quarantined",
    quarantineUntil: typeof body.revision?.quarantineUntil === "string" ? body.revision.quarantineUntil : null
  };
}

/**
 * Removes an agent from the registry's public surfaces (listing, pages,
 * downloads). Only the publishing identity's token can do it; package bytes
 * stay in the registry's audit storage.
 */
export async function unpublishFromRegistry(
  baseUrl: string,
  token: string,
  publisherId: string,
  agentId: string,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}
): Promise<void> {
  if (!token.trim()) throw new Error("A registry publish token is required.");
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  let response: Response;
  try {
    response = await fetchImpl(`${requireRegistryUrl(baseUrl)}/v1/agents/${publisherId}/${agentId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
      signal: options.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error("The registry could not be reached. Check the network and the deployment's registry configuration.");
  }
  if (response.ok) return;
  let message = `HTTP ${response.status}`;
  try {
    const body = await response.json() as { message?: unknown };
    if (typeof body.message === "string" && body.message) message = body.message;
  } catch {
    /* keep the HTTP status */
  }
  throw new Error(`The registry declined the unpublish: ${message}`);
}

/** The immutable package URL for a published revision. */
export function registryPackageUrl(baseUrl: string, result: RegistryPublishResult): string {
  const root = requireRegistryUrl(baseUrl);
  // Publisher/agent ids and the sha256 are all URL-safe by their patterns.
  return `${root}/v1/agents/${result.publisherId}/${result.agentId}/revisions/${result.sha256}/package`;
}

/** True when a pasted package URL sits on the deployment's registry origin. */
export function isRegistryPackageUrl(value: string, baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(value).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}
