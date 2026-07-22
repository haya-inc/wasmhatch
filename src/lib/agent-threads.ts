/**
 * Hatchling thread registry.
 *
 * A hatchling is one agent thread: its own conversation, its own isolated
 * workspace pair (working tree + revert baseline), its own optional interval
 * schedule, and its own pixel character. The registry is a single JSON
 * document in the shared meta store. Parsing is defensive: any malformed
 * entry is dropped and numeric fields are clamped into their legal ranges,
 * because a corrupt registry must never break page boot.
 *
 * The historical single-thread workspace becomes hatchling `main`, which
 * keeps the legacy storage roots so nothing an existing user stored moves.
 */

import type { AsyncTextStore } from "./opfs-kv";
import { DEFAULT_WORKSPACE_ROOTS, type WorkspaceRoots } from "./workspace";

export const MAIN_THREAD_ID = "main";
export const MAX_HATCHLINGS = 8;

/** Scheduler guardrails — see docs/hatchlings-design.md decision 2. */
export const SCHEDULE_LIMITS = Object.freeze({
  minIntervalMinutes: 1,
  maxIntervalMinutes: 24 * 60,
  defaultIntervalMinutes: 10,
  defaultMaxAutoRuns: 20,
  maxMaxAutoRuns: 500,
  maxConsecutiveFailures: 4,
  maxPromptChars: 2_000
});

export const DEFAULT_LOOP_PROMPT =
  "Check the shared ticket board with list_tickets. If a ticket is unassigned and ready, claim it with " +
  "update_ticket, do the work with your tools, then update the ticket with a short note on what you did " +
  "(status done when finished). If nothing needs you, reply with one short status line and stop.";

export interface ThreadSchedule {
  enabled: boolean;
  intervalMinutes: number;
  /** The task text each scheduled run starts with. */
  prompt: string;
  /** Cumulative auto-run cap; visible and user-raisable, never hidden. */
  maxAutoRuns: number;
  /** Auto runs spent so far (reset by the user alongside the cap). */
  autoRuns: number;
  consecutiveFailures: number;
}

export interface HatchlingThread {
  id: string;
  name: string;
  /** Sprite palette index for the pixel office. */
  species: number;
  createdAt: string;
  schedule: ThreadSchedule;
  /**
   * Packaged persona/playbook injected into the system prompt as untrusted
   * data; "" for an ordinary hatchling.
   */
  instructions: string;
  /**
   * Capability allowlist (hatchling-capabilities vocabulary). Null means
   * everything — the ordinary hatchling default; a list fails closed.
   */
  capabilities: readonly string[] | null;
}

const THREADS_KEY = "threads";
const THREAD_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MAX_NAME_CHARS = 24;
export const MAX_INSTRUCTION_CHARS = 16_000;
const MAX_CAPABILITIES = 64;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;

export const HATCHLING_NAMES: readonly string[] = [
  "Pip", "Momo", "Coco", "Mame", "Yuzu", "Taro", "Nori", "Fuku", "Beni", "Kuri", "Suzu", "Hana"
];

export const SPECIES_COUNT = 6;

export function defaultSchedule(): ThreadSchedule {
  return {
    enabled: false,
    intervalMinutes: SCHEDULE_LIMITS.defaultIntervalMinutes,
    prompt: DEFAULT_LOOP_PROMPT,
    maxAutoRuns: SCHEDULE_LIMITS.defaultMaxAutoRuns,
    autoRuns: 0,
    consecutiveFailures: 0
  };
}

export function mainHatchling(now: Date = new Date()): HatchlingThread {
  return {
    id: MAIN_THREAD_ID,
    name: HATCHLING_NAMES[0],
    species: 0,
    createdAt: now.toISOString(),
    schedule: defaultSchedule(),
    instructions: "",
    capabilities: null
  };
}

export interface HatchlingProfile {
  name?: string;
  instructions?: string;
  capabilities?: readonly string[] | null;
}

function sanitizeInstructions(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_INSTRUCTION_CHARS) : "";
}

function sanitizeCapabilities(value: unknown): readonly string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const capabilities: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !CAPABILITY_PATTERN.test(entry) || capabilities.includes(entry)) continue;
    capabilities.push(entry);
    if (capabilities.length >= MAX_CAPABILITIES) break;
  }
  return Object.freeze(capabilities);
}

function randomThreadId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let suffix = "";
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `h-${suffix}`;
}

/** Picks an unused name; when every name is taken, numbers the first one. */
function pickName(existing: readonly HatchlingThread[]): string {
  const used = new Set(existing.map((thread) => thread.name));
  for (const name of HATCHLING_NAMES) {
    if (!used.has(name)) return name;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${HATCHLING_NAMES[0]} ${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Trims a requested name and numbers it if another hatchling holds it. */
function uniqueName(requested: string, existing: readonly HatchlingThread[]): string {
  const base = requested.trim().slice(0, MAX_NAME_CHARS) || HATCHLING_NAMES[0];
  const used = new Set(existing.map((thread) => thread.name));
  if (!used.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base.slice(0, MAX_NAME_CHARS - 3)} ${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function createHatchling(
  existing: readonly HatchlingThread[],
  now: Date = new Date(),
  profile: HatchlingProfile = {}
): HatchlingThread {
  if (existing.length >= MAX_HATCHLINGS) {
    throw new Error(`The nest is full — at most ${MAX_HATCHLINGS} hatchlings per browser.`);
  }
  const usedIds = new Set(existing.map((thread) => thread.id));
  let id = randomThreadId();
  while (usedIds.has(id)) id = randomThreadId();
  return {
    id,
    name: profile.name !== undefined ? uniqueName(profile.name, existing) : pickName(existing),
    species: existing.length % SPECIES_COUNT,
    createdAt: now.toISOString(),
    schedule: defaultSchedule(),
    instructions: sanitizeInstructions(profile.instructions),
    capabilities: sanitizeCapabilities(profile.capabilities ?? null)
  };
}

/** Maps a thread to its storage roots; `main` keeps the legacy pair. */
export function workspaceRootsForThread(threadId: string): WorkspaceRoots {
  if (!THREAD_ID_PATTERN.test(threadId)) throw new Error(`Invalid thread id: ${threadId}`);
  if (threadId === MAIN_THREAD_ID) return DEFAULT_WORKSPACE_ROOTS;
  return { working: `wasmhatch-ws-${threadId}`, baseline: `wasmhatch-bl-${threadId}` };
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function sanitizeSchedule(value: unknown): ThreadSchedule {
  const base = defaultSchedule();
  if (!value || typeof value !== "object") return base;
  const record = value as Record<string, unknown>;
  const prompt = typeof record.prompt === "string" && record.prompt.trim()
    ? record.prompt.slice(0, SCHEDULE_LIMITS.maxPromptChars)
    : base.prompt;
  const maxAutoRuns = clampInteger(record.maxAutoRuns, 1, SCHEDULE_LIMITS.maxMaxAutoRuns, base.maxAutoRuns);
  return {
    enabled: record.enabled === true,
    intervalMinutes: clampInteger(
      record.intervalMinutes,
      SCHEDULE_LIMITS.minIntervalMinutes,
      SCHEDULE_LIMITS.maxIntervalMinutes,
      base.intervalMinutes
    ),
    prompt,
    maxAutoRuns,
    autoRuns: clampInteger(record.autoRuns, 0, SCHEDULE_LIMITS.maxMaxAutoRuns, 0),
    consecutiveFailures: clampInteger(record.consecutiveFailures, 0, SCHEDULE_LIMITS.maxConsecutiveFailures, 0)
  };
}

function sanitizeThread(value: unknown): HatchlingThread | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !THREAD_ID_PATTERN.test(record.id)) return null;
  const name = typeof record.name === "string" && record.name.trim()
    ? record.name.trim().slice(0, MAX_NAME_CHARS)
    : HATCHLING_NAMES[0];
  return {
    id: record.id,
    name,
    species: clampInteger(record.species, 0, SPECIES_COUNT - 1, 0),
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
    schedule: sanitizeSchedule(record.schedule),
    instructions: sanitizeInstructions(record.instructions),
    capabilities: sanitizeCapabilities(record.capabilities ?? null)
  };
}

export function parseThreads(raw: string | null): HatchlingThread[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !Array.isArray(record.threads)) return null;
  const threads: HatchlingThread[] = [];
  const seen = new Set<string>();
  for (const entry of record.threads) {
    const thread = sanitizeThread(entry);
    if (!thread || seen.has(thread.id)) continue;
    seen.add(thread.id);
    threads.push(thread);
    if (threads.length >= MAX_HATCHLINGS) break;
  }
  return threads.length ? threads : null;
}

export function serializeThreads(threads: readonly HatchlingThread[]): string {
  return JSON.stringify({ schemaVersion: 1, threads });
}

/** Loads the registry, seeding it with the `main` hatchling on first run. */
export async function loadThreads(store: AsyncTextStore): Promise<HatchlingThread[]> {
  const parsed = parseThreads(await store.read(THREADS_KEY));
  if (parsed) {
    // The main thread must always exist: it owns the legacy workspace.
    if (!parsed.some((thread) => thread.id === MAIN_THREAD_ID)) {
      parsed.unshift(mainHatchling());
    }
    return parsed;
  }
  const seeded = [mainHatchling()];
  try {
    await store.write(THREADS_KEY, serializeThreads(seeded));
  } catch {
    /* persisting the seed is best-effort; the in-memory registry still works */
  }
  return seeded;
}

export async function saveThreads(store: AsyncTextStore, threads: readonly HatchlingThread[]): Promise<void> {
  try {
    await store.write(THREADS_KEY, serializeThreads(threads));
  } catch {
    /* registry persistence is best-effort; a full store must not break the session */
  }
}
