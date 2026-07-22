/// <reference lib="webworker" />

/**
 * Heartbeat for the hatchling scheduler. Hidden tabs throttle main-thread
 * timers hard; dedicated-worker timers keep firing, so the swarm keeps
 * checking its schedules while the user reads another tab. A frozen or
 * closed tab still stops everything — that limit is documented, not hidden.
 */

const worker = self as unknown as DedicatedWorkerGlobalScope;

let intervalId: ReturnType<typeof setInterval> | null = null;

worker.onmessage = (event: MessageEvent<{ tickMs?: number }>) => {
  const tickMs = typeof event.data?.tickMs === "number" && event.data.tickMs >= 1_000
    ? event.data.tickMs
    : 15_000;
  if (intervalId !== null) clearInterval(intervalId);
  intervalId = setInterval(() => worker.postMessage("tick"), tickMs);
};

export {};
