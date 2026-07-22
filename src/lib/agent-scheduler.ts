/**
 * Interval scheduling for hatchlings — "auto work" while the tab is open.
 *
 * Honest scope: this is late-tolerant polling inside a page, not a cron. A
 * Web Worker heartbeat keeps ticks flowing when the tab is hidden (hidden
 * tabs throttle main-thread timers, worker timers keep running), but a
 * frozen or closed tab stops everything, and the copy must keep saying so.
 *
 * Guardrails (docs/hatchlings-design.md, decision 2): a visible cumulative
 * auto-run cap per hatchling, exponential backoff on consecutive failures,
 * auto-off after too many failures, and scheduled runs only in autonomous
 * mode. The pure functions here decide *whether* a run is due; the session
 * manager owns starting it.
 */

import { SCHEDULE_LIMITS, type ThreadSchedule } from "./agent-threads";

export const SCHEDULER_TICK_MS = 15_000;
/** Backoff multiplier cap: 1min interval + 3 failures ⇒ at most 8 minutes. */
const MAX_BACKOFF_MULTIPLIER = 8;

export type ScheduleBlocker = "disabled" | "exhausted" | "running";

export interface ScheduleStatus {
  /** True when a scheduled run should start now. */
  due: boolean;
  /** Epoch ms of the next run while waiting; null when blocked or due. */
  nextRunAt: number | null;
  blocker: ScheduleBlocker | null;
  runsLeft: number;
}

export interface ScheduleEvaluationInput {
  schedule: ThreadSchedule;
  /** Epoch ms when the last run (manual or auto) finished; null = never. */
  lastRunEndedAt: number | null;
  /** True while this hatchling is mid-run (manual or auto). */
  running: boolean;
  now: number;
}

export function backoffMultiplier(consecutiveFailures: number): number {
  return Math.min(MAX_BACKOFF_MULTIPLIER, 2 ** Math.max(0, consecutiveFailures));
}

export function evaluateSchedule(input: ScheduleEvaluationInput): ScheduleStatus {
  const { schedule, lastRunEndedAt, running, now } = input;
  const runsLeft = Math.max(0, schedule.maxAutoRuns - schedule.autoRuns);
  if (!schedule.enabled) return { due: false, nextRunAt: null, blocker: "disabled", runsLeft };
  if (runsLeft === 0) return { due: false, nextRunAt: null, blocker: "exhausted", runsLeft };
  if (running) return { due: false, nextRunAt: null, blocker: "running", runsLeft };
  // First run after enabling starts immediately — observable and satisfying.
  if (lastRunEndedAt === null) return { due: true, nextRunAt: null, blocker: null, runsLeft };
  const intervalMs = schedule.intervalMinutes * 60_000 * backoffMultiplier(schedule.consecutiveFailures);
  const nextRunAt = lastRunEndedAt + intervalMs;
  if (now >= nextRunAt) return { due: true, nextRunAt: null, blocker: null, runsLeft };
  return { due: false, nextRunAt, blocker: null, runsLeft };
}

/**
 * Accounting after one scheduled run. Success clears the failure streak;
 * a failure extends it, and reaching the streak limit turns the schedule
 * off — the caller must surface that visibly (never a silent stop).
 */
export function applyAutoRunOutcome(
  schedule: ThreadSchedule,
  succeeded: boolean
): { schedule: ThreadSchedule; autoDisabled: boolean } {
  const consecutiveFailures = succeeded ? 0 : schedule.consecutiveFailures + 1;
  const autoDisabled = consecutiveFailures >= SCHEDULE_LIMITS.maxConsecutiveFailures;
  return {
    schedule: {
      ...schedule,
      autoRuns: schedule.autoRuns + 1,
      consecutiveFailures: autoDisabled ? 0 : consecutiveFailures,
      enabled: schedule.enabled && !autoDisabled
    },
    autoDisabled
  };
}

/** Resets spend and failure accounting when the user raises or refreshes the cap. */
export function resetAutoRunBudget(schedule: ThreadSchedule, maxAutoRuns?: number): ThreadSchedule {
  const cap = Math.min(
    SCHEDULE_LIMITS.maxMaxAutoRuns,
    Math.max(1, Math.round(maxAutoRuns ?? schedule.maxAutoRuns))
  );
  return { ...schedule, maxAutoRuns: cap, autoRuns: 0, consecutiveFailures: 0 };
}

export interface SchedulerTicker {
  dispose(): void;
}

/**
 * Emits ticks on a worker-driven heartbeat, falling back to a main-thread
 * interval where module workers are unavailable. Fires one immediate tick
 * so "turn on auto work" reacts without waiting a full period.
 */
export function createSchedulerTicker(onTick: () => void, tickMs: number = SCHEDULER_TICK_MS): SchedulerTicker {
  let disposed = false;
  const safeTick = () => {
    if (!disposed) onTick();
  };
  let worker: Worker | null = null;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  try {
    worker = new Worker(new URL("./scheduler-tick.worker.ts", import.meta.url), { type: "module" });
    worker.postMessage({ tickMs });
    worker.onmessage = safeTick;
    worker.onerror = () => {
      // A worker that cannot start must not kill auto work entirely.
      worker?.terminate();
      worker = null;
      if (!disposed && intervalId === null) intervalId = setInterval(safeTick, tickMs);
    };
  } catch {
    intervalId = setInterval(safeTick, tickMs);
  }
  queueMicrotask(safeTick);
  return {
    dispose() {
      disposed = true;
      worker?.terminate();
      if (intervalId !== null) clearInterval(intervalId);
    }
  };
}
