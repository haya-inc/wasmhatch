import { describe, expect, it } from "vitest";
import { defaultSchedule, SCHEDULE_LIMITS, type ThreadSchedule } from "./agent-threads";
import {
  applyAutoRunOutcome,
  backoffMultiplier,
  evaluateSchedule,
  resetAutoRunBudget
} from "./agent-scheduler";

const NOW = Date.UTC(2026, 6, 22, 12, 0, 0);
const MINUTE = 60_000;

function schedule(overrides: Partial<ThreadSchedule> = {}): ThreadSchedule {
  return { ...defaultSchedule(), enabled: true, ...overrides };
}

describe("evaluateSchedule", () => {
  it("never fires while disabled, exhausted, or already running", () => {
    expect(evaluateSchedule({ schedule: { ...schedule(), enabled: false }, lastRunEndedAt: null, running: false, now: NOW }))
      .toMatchObject({ due: false, blocker: "disabled" });
    expect(evaluateSchedule({ schedule: schedule({ autoRuns: 20, maxAutoRuns: 20 }), lastRunEndedAt: null, running: false, now: NOW }))
      .toMatchObject({ due: false, blocker: "exhausted", runsLeft: 0 });
    expect(evaluateSchedule({ schedule: schedule(), lastRunEndedAt: null, running: true, now: NOW }))
      .toMatchObject({ due: false, blocker: "running" });
  });

  it("fires immediately after enabling, then waits one interval between runs", () => {
    const enabled = schedule({ intervalMinutes: 10 });
    expect(evaluateSchedule({ schedule: enabled, lastRunEndedAt: null, running: false, now: NOW }))
      .toMatchObject({ due: true });
    const waiting = evaluateSchedule({ schedule: enabled, lastRunEndedAt: NOW, running: false, now: NOW + 9 * MINUTE });
    expect(waiting.due).toBe(false);
    expect(waiting.nextRunAt).toBe(NOW + 10 * MINUTE);
    expect(evaluateSchedule({ schedule: enabled, lastRunEndedAt: NOW, running: false, now: NOW + 10 * MINUTE }))
      .toMatchObject({ due: true });
  });

  it("stretches the wait exponentially with consecutive failures, capped at 8x", () => {
    expect(backoffMultiplier(0)).toBe(1);
    expect(backoffMultiplier(1)).toBe(2);
    expect(backoffMultiplier(3)).toBe(8);
    expect(backoffMultiplier(10)).toBe(8);
    const failing = schedule({ intervalMinutes: 1, consecutiveFailures: 2 });
    const status = evaluateSchedule({ schedule: failing, lastRunEndedAt: NOW, running: false, now: NOW + MINUTE });
    expect(status.due).toBe(false);
    expect(status.nextRunAt).toBe(NOW + 4 * MINUTE);
  });

  it("reports runs left so the UI can show the visible budget", () => {
    const status = evaluateSchedule({
      schedule: schedule({ maxAutoRuns: 20, autoRuns: 5 }),
      lastRunEndedAt: null,
      running: false,
      now: NOW
    });
    expect(status.runsLeft).toBe(15);
  });
});

describe("applyAutoRunOutcome", () => {
  it("counts the run and clears the failure streak on success", () => {
    const { schedule: next, autoDisabled } = applyAutoRunOutcome(schedule({ autoRuns: 3, consecutiveFailures: 2 }), true);
    expect(next).toMatchObject({ autoRuns: 4, consecutiveFailures: 0, enabled: true });
    expect(autoDisabled).toBe(false);
  });

  it("turns the schedule off — never silently — after the failure limit", () => {
    let current = schedule({ intervalMinutes: 5 });
    let disabled = false;
    for (let attempt = 0; attempt < SCHEDULE_LIMITS.maxConsecutiveFailures; attempt += 1) {
      expect(current.enabled).toBe(true);
      const outcome = applyAutoRunOutcome(current, false);
      current = outcome.schedule;
      disabled = outcome.autoDisabled;
    }
    expect(disabled).toBe(true);
    expect(current.enabled).toBe(false);
    expect(current.autoRuns).toBe(SCHEDULE_LIMITS.maxConsecutiveFailures);
  });
});

describe("resetAutoRunBudget", () => {
  it("resets spend and failures, clamping the new cap into range", () => {
    const spent = schedule({ autoRuns: 19, consecutiveFailures: 3, maxAutoRuns: 20 });
    expect(resetAutoRunBudget(spent)).toMatchObject({ autoRuns: 0, consecutiveFailures: 0, maxAutoRuns: 20 });
    expect(resetAutoRunBudget(spent, 100_000).maxAutoRuns).toBe(SCHEDULE_LIMITS.maxMaxAutoRuns);
    expect(resetAutoRunBudget(spent, 0).maxAutoRuns).toBe(1);
  });
});
