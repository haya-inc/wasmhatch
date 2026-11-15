import { useCallback, useMemo, useState } from "react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { HatchlingState, HatchlingSwarm } from "../../lib/agent-session";
import { MAIN_THREAD_ID, MAX_HATCHLINGS, SCHEDULE_LIMITS } from "../../lib/agent-threads";
import { HATCHLING_PRESETS, profileFromPreset } from "../../lib/hatchling-presets";
import type { OfficeCharacter } from "../../lib/pixel-office";
import type { TicketStatus } from "../../lib/tickets";
import { HatchlingOffice } from "../HatchlingOffice";

const AUTO_WORK_INTERVALS = [1, 5, 10, 30, 60] as const;

function hatchlingStatusLine(state: HatchlingState, now: number): string {
  if (state.running) return state.runKind === "auto" ? t`Auto work in progress…` : t`Working…`;
  if (state.mood === "error") return t`Needs attention`;
  if (state.thread.schedule.enabled) {
    if (state.autoBlocker === "exhausted") return t`Auto budget used up`;
    if (state.autoSkipNote) return t`Auto work waiting`;
    if (state.nextAutoRunAt !== null) {
      const minutes = Math.max(0, Math.round((state.nextAutoRunAt - now) / 60_000));
      return minutes <= 0 ? t`Next auto run any moment` : t`Next auto run in ~${minutes} min`;
    }
    return t`Auto work on`;
  }
  return state.mood === "done" && state.lastActivity ? state.lastActivity : t`Resting`;
}

function ticketStatusLabel(status: TicketStatus): string {
  switch (status) {
    case "todo": return t`To do`;
    case "doing": return t`Doing`;
    case "blocked": return t`Blocked`;
    case "done": return t`Done`;
  }
}

export interface TeamSidebarProps {
  swarm: HatchlingSwarm;
  threads: readonly HatchlingState[];
  selectedId: string;
  selected: HatchlingState | null;
  onNotice: (text: string, tone?: "info" | "error") => void;
}

export function TeamSidebar({ swarm, threads, selectedId, selected, onNotice }: TeamSidebarProps) {
  const [ticketDraft, setTicketDraft] = useState("");
  const now = Date.now();
  const running = selected?.running ?? false;
  const selectedSchedule = selected?.thread.schedule;
  const tickets = swarm.tickets.list();

  const threadNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const state of threads) names.set(state.thread.id, state.thread.name);
    return names;
  }, [threads]);

  const officeCharacters: OfficeCharacter[] = threads.map((state) => ({
    id: state.thread.id,
    name: state.thread.name,
    species: state.thread.species,
    mood: state.mood,
    running: state.running,
    scheduled: state.thread.schedule.enabled,
    selected: state.thread.id === selectedId
  }));

  const addTicket = useCallback(async () => {
    const title = ticketDraft.trim();
    if (!title) return;
    setTicketDraft("");
    try {
      await swarm.tickets.create({ title, createdBy: "user" });
    } catch (error) {
      onNotice(error instanceof Error ? error.message : t`The ticket could not be created.`, "error");
    }
  }, [onNotice, swarm, ticketDraft]);

  return (
    <aside className="chat-side chat-side-left">
      <section className="chat-panel">
        <h2><Trans>Hatchlings</Trans></h2>
        <HatchlingOffice characters={officeCharacters} onSelect={(id) => swarm.select(id)} />
        <ul className="hatchling-list">
          {threads.map((state) => (
            <li key={state.thread.id}>
              <button
                type="button"
                className={state.thread.id === selectedId ? "hatchling-row hatchling-row-selected" : "hatchling-row"}
                onClick={() => swarm.select(state.thread.id)}
              >
                <span className={`hatchling-dot hatchling-dot-${state.running ? "running" : state.mood}`} aria-hidden="true" />
                <span className="hatchling-name">{state.thread.name}</span>
                <span className="hatchling-status">{hatchlingStatusLine(state, now)}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="hatchling-actions">
          {threads.length < MAX_HATCHLINGS && (
            <>
              <button
                className="button"
                type="button"
                onClick={() => { void swarm.hatch().then((id) => swarm.select(id)); }}
              >
                <Trans>Hatch a new one</Trans>
              </button>
              <div className="hatchling-presets">
                <span className="chat-hint"><Trans>Or hatch a specialist:</Trans></span>
                <div className="hatchling-preset-row">
                  {HATCHLING_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      className="hatchling-preset-pill"
                      type="button"
                      title={preset.summary()}
                      onClick={() => {
                        void swarm.hatch(profileFromPreset(preset.id)).then((id) => swarm.select(id));
                      }}
                    >
                      + {preset.label()}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
          <label className="chat-remember">
            <input
              type="checkbox"
              checked={swarm.isGloballyPaused()}
              onChange={(event) => swarm.setGlobalPause(event.target.checked)}
            />
            <span><Trans>Pause all auto work</Trans></span>
          </label>
        </div>
        {selected && selectedSchedule && (
          <div className="hatchling-config">
            {selected.thread.capabilities !== null && (
              <p className="chat-hint">
                {selected.thread.capabilities.length > 0
                  ? t`Scoped tools: ${selected.thread.capabilities.join(", ")}`
                  : t`Scoped tools: conversation only`}
              </p>
            )}
            <label className="chat-field">
              <span><Trans>Name</Trans></span>
              <input
                type="text"
                value={selected.thread.name}
                maxLength={24}
                onChange={(event) => { void swarm.rename(selectedId, event.target.value); }}
              />
            </label>
            <label className="chat-remember">
              <input
                type="checkbox"
                checked={selectedSchedule.enabled}
                onChange={(event) => { void swarm.setSchedule(selectedId, { enabled: event.target.checked }); }}
              />
              <span><Trans>Auto work while this tab is open</Trans></span>
            </label>
            {selectedSchedule.enabled && (
              <>
                <label className="chat-field">
                  <span><Trans>Every</Trans></span>
                  <select
                    value={selectedSchedule.intervalMinutes}
                    onChange={(event) => { void swarm.setSchedule(selectedId, { intervalMinutes: Number(event.target.value) }); }}
                  >
                    {AUTO_WORK_INTERVALS.map((minutes) => (
                      <option key={minutes} value={minutes}>{t`${minutes} min`}</option>
                    ))}
                    {!AUTO_WORK_INTERVALS.includes(selectedSchedule.intervalMinutes as typeof AUTO_WORK_INTERVALS[number]) && (
                      <option value={selectedSchedule.intervalMinutes}>{t`${selectedSchedule.intervalMinutes} min`}</option>
                    )}
                  </select>
                </label>
                <label className="chat-field">
                  <span><Trans>Each run</Trans></span>
                  <textarea
                    rows={3}
                    value={selectedSchedule.prompt}
                    maxLength={SCHEDULE_LIMITS.maxPromptChars}
                    onChange={(event) => { void swarm.setSchedule(selectedId, { prompt: event.target.value }); }}
                  />
                </label>
                <p className="chat-hint">
                  <Trans>{selected.runsLeft} of {selectedSchedule.maxAutoRuns} auto runs left.</Trans>{" "}
                  <button
                    className="chat-linklike"
                    type="button"
                    onClick={() => { void swarm.resetScheduleBudget(selectedId); }}
                  >
                    <Trans>Reset budget</Trans>
                  </button>
                </p>
                {selected.autoSkipNote && <p className="chat-hint">{selected.autoSkipNote}</p>}
                <p className="chat-hint">
                  <Trans>
                    Runs only while this tab is open, in Fast mode, with its own token budget — it stops
                    itself after repeated failures.
                  </Trans>
                </p>
              </>
            )}
            {selectedId !== MAIN_THREAD_ID && (
              <button
                className="button button-quiet"
                type="button"
                disabled={running}
                onClick={() => {
                  if (window.confirm(t`Remove ${selected.thread.name}? Its files and conversation are deleted (the shared ticket board stays).`)) {
                    void swarm.removeHatchling(selectedId);
                  }
                }}
              >
                <Trans>Remove this hatchling</Trans>
              </button>
            )}
          </div>
        )}
      </section>

      <section className="chat-panel">
        <h2><Trans>Tickets</Trans></h2>
        <div className="ticket-add">
          <input
            type="text"
            aria-label={t`New ticket title`}
            placeholder={t`Queue a piece of work…`}
            value={ticketDraft}
            onChange={(event) => setTicketDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void addTicket();
              }
            }}
          />
          <button className="button" type="button" disabled={!ticketDraft.trim()} onClick={() => { void addTicket(); }}>
            <Trans>Add</Trans>
          </button>
        </div>
        {tickets.length === 0
          ? <p className="chat-hint"><Trans>The shared work queue is empty. Add tickets here or let hatchlings queue their own follow-ups.</Trans></p>
          : (
            <ul className="ticket-list">
              {tickets.map((ticket) => (
                <li key={ticket.id} className={`ticket ticket-${ticket.status}`}>
                  <span className={`ticket-chip ticket-chip-${ticket.status}`}>{ticketStatusLabel(ticket.status)}</span>
                  <span className="ticket-title">{ticket.title}</span>
                  {ticket.assignee && (
                    <span className="ticket-assignee">{threadNames.get(ticket.assignee) ?? ticket.assignee}</span>
                  )}
                  {ticket.note && <span className="ticket-note">{ticket.note}</span>}
                  <span className="ticket-actions">
                    {ticket.status !== "done" && (
                      <button
                        className="chat-linklike"
                        type="button"
                        onClick={() => { void swarm.tickets.update(ticket.id, { status: "done" }); }}
                      >
                        <Trans>Done</Trans>
                      </button>
                    )}
                    {ticket.status === "done" && (
                      <button
                        className="chat-linklike"
                        type="button"
                        onClick={() => { void swarm.tickets.update(ticket.id, { status: "todo", assignee: null }); }}
                      >
                        <Trans>Reopen</Trans>
                      </button>
                    )}
                    <button
                      className="chat-linklike"
                      type="button"
                      onClick={() => { void swarm.tickets.remove(ticket.id); }}
                    >
                      <Trans>Delete</Trans>
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
      </section>
    </aside>
  );
}
