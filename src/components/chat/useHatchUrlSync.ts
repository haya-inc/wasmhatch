import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { HatchlingSwarm } from "../../lib/agent-session";
import { MAIN_THREAD_ID } from "../../lib/agent-threads";

/** Which sidebars are open; the choice sticks per device. */
export interface ColumnLayout {
  left: boolean;
  right: boolean;
}

const LAYOUT_KEY = "wasmhatch-chat-layout-v1";
const HATCH_PARAM = "hatch";

function loadColumnLayout(): ColumnLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ColumnLayout>;
      return { left: parsed.left !== false, right: parsed.right !== false };
    }
  } catch {
    /* layout preference is cosmetic; a blocked store falls back to defaults */
  }
  return { left: true, right: true };
}

function saveColumnLayout(layout: ColumnLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* the preference simply won't survive a reload */
  }
}

function hatchIdFromLocation(): string | null {
  const value = new URLSearchParams(window.location.search).get(HATCH_PARAM);
  return value && /^[a-z0-9][a-z0-9-]*$/.test(value) ? value : null;
}

function locationWithHatch(threadId: string): string {
  const url = new URL(window.location.href);
  if (threadId === MAIN_THREAD_ID) url.searchParams.delete(HATCH_PARAM);
  else url.searchParams.set(HATCH_PARAM, threadId);
  return url.pathname + url.search + url.hash;
}

export function useColumnLayout(): [ColumnLayout, Dispatch<SetStateAction<ColumnLayout>>] {
  const [columns, setColumns] = useState<ColumnLayout>(loadColumnLayout);
  useEffect(() => {
    saveColumnLayout(columns);
  }, [columns]);
  return [columns, setColumns];
}

/**
 * Deep-link routing per hatchling: `?view=chat&hatch=<thread id>`.
 * The id is device-local (the registry lives in this browser), so this is
 * navigation — reload, bookmarks, back/forward — not a sharing feature.
 * The main hatchling keeps the clean parameter-free URL as its canonical form.
 */
export function useHatchUrlSync(swarm: HatchlingSwarm, selectedId: string): void {
  const [urlRoutingReady, setUrlRoutingReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void swarm.ready.then(() => {
      if (cancelled) return;
      const fromUrl = hatchIdFromLocation();
      if (fromUrl && swarm.getState(fromUrl)) swarm.select(fromUrl);
      setUrlRoutingReady(true);
    });
    const onPopState = () => {
      const fromUrl = hatchIdFromLocation();
      swarm.select(fromUrl && swarm.getState(fromUrl) ? fromUrl : MAIN_THREAD_ID);
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      cancelled = true;
      window.removeEventListener("popstate", onPopState);
    };
  }, [swarm]);

  // Keep the URL in step with the selection. The first sync after boot
  // replaces (normalizing a stale or invalid deep link without polluting
  // history); every later change pushes so Back walks the selection.
  const firstUrlSync = useRef(true);
  useEffect(() => {
    if (!urlRoutingReady) return;
    const current = hatchIdFromLocation() ?? MAIN_THREAD_ID;
    if (current === selectedId) {
      firstUrlSync.current = false;
      return;
    }
    if (firstUrlSync.current) {
      history.replaceState(null, "", locationWithHatch(selectedId));
      firstUrlSync.current = false;
    } else {
      history.pushState(null, "", locationWithHatch(selectedId));
    }
  }, [urlRoutingReady, selectedId]);
}
