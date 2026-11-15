/**
 * The hatchling swarm runtime.
 *
 * One HatchlingSwarm per chat page owns every thread: its isolated
 * workspace, its transcript, its run loop, its schedule, and its mood for
 * the pixel office. ChatPage becomes a view over this class — React
 * subscribes to a version counter and reads state snapshots directly.
 *
 * Prompt assembly (`system-prompt.ts`), MCP server connections
 * (`mcp-registry.ts`), and connector tool routing (`tool-router.ts`) live in
 * dedicated modules so this class focuses on thread state and loop execution.
 */

import { createAnthropicProvider } from "./agent-core/anthropic";
import { runAgentLoop } from "./agent-core/loop";
import { createOpenAiCompatibleProvider } from "./agent-core/openai-compatible";
import { createOpenAiResponsesProvider } from "./agent-core/openai-responses";
import type { AgentLoopEvent, AgentMessage, AgentProvider, AgentToolDefinition, AgentToolExecutor } from "./agent-core/types";
import type { PortableAgentPackage } from "./agent-package";
import {
  applyAutoRunOutcome,
  createSchedulerTicker,
  evaluateSchedule,
  resetAutoRunBudget,
  type ScheduleBlocker,
  type SchedulerTicker
} from "./agent-scheduler";
import {
  createHatchling,
  loadThreads,
  MAIN_THREAD_ID,
  saveThreads,
  workspaceRootsForThread,
  type HatchlingProfile,
  type HatchlingThread,
  type ThreadSchedule
} from "./agent-threads";
import type { HtmlArtifact } from "./artifact";
import { callWithLanguageFallback } from "./builtin-ai-language";
import {
  runBuiltinAiToolLoop,
  type BuiltinAiSessionLike,
  type BuiltinTool
} from "./builtin-ai-loop";
import { SessionPermissionStore, type PermissionGate } from "./chat-permissions";
import { getCloudProvider, type ChatProviderId } from "./chat-providers";
import type { AppliedWrite, WritePolicy } from "./chat-tools";
import {
  clearChatTranscript,
  clearThreadTranscript,
  loadChatTranscript,
  loadThreadTranscript,
  saveThreadTranscript
} from "./chat-transcript-store";
import type { PickedDriveFile } from "./google-picker";
import { McpRegistry, type McpConnectedServer, type McpServerStatus } from "./mcp-registry";
import { createMetaStore, type AsyncTextStore } from "./opfs-kv";
import { buildPortableHatchling, hatchProfileFromPackage, type PortableExportMeta } from "./portable-hatchling";
import {
  appendRunJournalEvent,
  createRunJournal,
  serializeRunJournal,
  type RunJournal
} from "./run-journal";
import { isProtectedAgentPath } from "./secrets";
import { systemPrompt } from "./system-prompt";
import { TicketBoard } from "./tickets";
import { assembleHatchlingTools, createHatchlingToolExecutor } from "./tool-router";
import { summarizeToolCall } from "./tool-summary";
import { createWorkspaceStore, type WorkspaceFile, type WorkspaceStore } from "./workspace";

export { systemPrompt } from "./system-prompt";
export type { McpServerStatus } from "./mcp-registry";

export interface ChatItem {
  id: number;
  kind: "user" | "assistant" | "tool" | "notice" | "write" | "sources";
  text: string;
  /** Web sources the provider cited for the preceding answer. */
  sources?: Array<{ url: string; title: string }>;
  tone?: "info" | "error";
  toolName?: string;
  toolState?: "running" | "done" | "error";
  callId?: string;
  streaming?: boolean;
  write?: AppliedWrite & { reverted: boolean };
}

export type HatchlingMood = "idle" | "thinking" | "tool" | "write" | "error" | "done";

export interface HatchlingState {
  thread: HatchlingThread;
  items: readonly ChatItem[];
  running: boolean;
  runKind: "manual" | "auto" | null;
  mood: HatchlingMood;
  /** One plain-language line for the office speech bubble and status list. */
  lastActivity: string;
  nextAutoRunAt: number | null;
  autoBlocker: ScheduleBlocker | null;
  /** Why a due schedule cannot start right now (no key, careful mode, …). */
  autoSkipNote: string | null;
  runsLeft: number;
  /** Bumps on every applied write so the UI knows to refresh file lists. */
  writeCount: number;
}

export interface RunConfig {
  provider: ChatProviderId;
  apiKey: string;
  model: string;
  webSearch: boolean;
  writeMode: WritePolicy;
  builtinAvailability: string;
}

interface ChromeLanguageModelApi {
  create(options: {
    signal?: AbortSignal;
    initialPrompts: readonly { role: "system"; content: string }[];
    expectedInputs?: unknown;
    expectedOutputs?: unknown;
  }): Promise<{
    prompt(input: string, options: {
      signal?: AbortSignal;
      responseConstraint?: unknown;
      omitResponseConstraintInput?: boolean;
    }): Promise<string>;
    destroy(): void;
  }>;
}

export interface SwarmDeps {
  getConfig: () => RunConfig;
  /** Careful-mode approval UI; only manual runs ever reach it. */
  gate: PermissionGate;
  onArtifact: (artifact: HtmlArtifact) => void;
  google: {
    isConnected: () => boolean;
    sensitiveEnabled: boolean;
    getToken: (signal?: AbortSignal) => Promise<string>;
    /** Picker handover UI bridge; absent when the deployment has no picker key. */
    requestFilePick?: (reason: string, signal?: AbortSignal) => Promise<PickedDriveFile[] | null>;
  };
  /** Slack credentials, read per call; "" while that route is not connected. */
  slack?: { getWebhookUrl: () => string; getToken?: () => string };
  /** Web-tool keys, read per call; "" while that tool is not connected. */
  web?: { getTavilyKey: () => string; getJinaKey: () => string };
  getBuiltinApi?: () => ChromeLanguageModelApi | undefined;
  metaStore?: AsyncTextStore;
  now?: () => number;
  /** Test hook: replaces the worker ticker. */
  createTicker?: (onTick: () => void) => SchedulerTicker;
  /** Test hook: overrides cloud provider instantiation. */
  createCloudProvider?: (config: RunConfig) => AgentProvider;
}

interface ThreadRuntime {
  thread: HatchlingThread;
  workspace: WorkspaceStore;
  permissions: SessionPermissionStore;
  messages: AgentMessage[];
  items: ChatItem[];
  nextId: number;
  running: boolean;
  runKind: "manual" | "auto" | null;
  abort: AbortController | null;
  citations: Map<string, string>;
  mood: HatchlingMood;
  moodChangedAt: number;
  lastActivity: string;
  lastRunEndedAt: number | null;
  autoSkipNote: string | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
  writeCount: number;
  /** In-memory audit trail of this thread's runs; exported on demand. */
  journal: RunJournal;
}

/** At most this many hatchlings run loops at the same moment. */
export const MAX_CONCURRENT_RUNS = 3;
/** A "done" face relaxes back to idle after this long. */
const DONE_MOOD_DECAY_MS = 45_000;
const SAVE_DEBOUNCE_MS = 400;

export class HatchlingSwarm {
  readonly ready: Promise<void>;
  readonly tickets: TicketBoard;

  private readonly deps: SwarmDeps;
  private readonly meta: AsyncTextStore;
  private readonly mcp: McpRegistry;
  private readonly runtimes = new Map<string, ThreadRuntime>();
  private threadOrder: string[] = [];
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private emitQueued = false;
  private ticker: SchedulerTicker | null = null;
  private globalPause = false;
  private disposed = false;
  private artifactCounter = 0;
  private selected: string = MAIN_THREAD_ID;

  constructor(deps: SwarmDeps) {
    this.deps = deps;
    this.meta = deps.metaStore ?? createMetaStore();
    this.mcp = new McpRegistry({ onChange: () => this.emit() });
    this.tickets = new TicketBoard(this.meta);
    this.tickets.onChange(() => this.emit());
    this.ready = this.hydrate();
    const createTicker = deps.createTicker ?? createSchedulerTicker;
    this.ticker = createTicker(() => { void this.onTick(); });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // ----- React subscription -----

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private emit(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      this.version += 1;
      for (const listener of this.listeners) listener();
    });
  }

  // ----- hydration -----

  private async hydrate(): Promise<void> {
    const threads = await loadThreads(this.meta);
    const provider = this.deps.getConfig().provider;
    for (const thread of threads) {
      const runtime = this.createRuntime(thread);
      const restored = await loadThreadTranscript<ChatItem, AgentMessage>(thread.id, provider, this.meta);
      if (restored) {
        runtime.items = restored.items;
        runtime.messages = restored.messages;
        runtime.nextId = restored.nextId;
      } else if (thread.id === MAIN_THREAD_ID) {
        // One-time migration of the legacy single-thread localStorage blob.
        const legacy = loadChatTranscript<ChatItem, AgentMessage>(provider);
        if (legacy) {
          runtime.items = legacy.items;
          runtime.messages = legacy.messages;
          runtime.nextId = legacy.nextId;
          await saveThreadTranscript(thread.id, {
            provider,
            items: runtime.items,
            messages: runtime.messages,
            nextId: runtime.nextId
          }, this.meta);
          clearChatTranscript();
        }
      }
    }
    void this.tickets.ready();
    this.emit();
  }

  private createRuntime(thread: HatchlingThread): ThreadRuntime {
    const runtime: ThreadRuntime = {
      thread,
      workspace: createWorkspaceStore(workspaceRootsForThread(thread.id)),
      permissions: new SessionPermissionStore(),
      messages: [],
      items: [],
      nextId: 1,
      running: false,
      runKind: null,
      abort: null,
      citations: new Map(),
      mood: "idle",
      moodChangedAt: this.now(),
      lastActivity: "",
      lastRunEndedAt: null,
      autoSkipNote: null,
      saveTimer: null,
      writeCount: 0,
      journal: createRunJournal()
    };
    this.runtimes.set(thread.id, runtime);
    if (!this.threadOrder.includes(thread.id)) this.threadOrder.push(thread.id);
    return runtime;
  }

  dispose(): void {
    this.disposed = true;
    this.ticker?.dispose();
    for (const runtime of this.runtimes.values()) {
      runtime.abort?.abort();
      if (runtime.saveTimer !== null) clearTimeout(runtime.saveTimer);
    }
    this.mcp.dispose();
  }

  // ----- selectors -----

  get selectedThreadId(): string {
    return this.selected;
  }

  select(threadId: string): void {
    if (this.runtimes.has(threadId)) {
      this.selected = threadId;
      this.emit();
    }
  }

  private toState(runtime: ThreadRuntime): HatchlingState {
    const status = evaluateSchedule({
      schedule: runtime.thread.schedule,
      lastRunEndedAt: runtime.lastRunEndedAt,
      running: runtime.running,
      now: this.now()
    });
    return {
      thread: runtime.thread,
      items: runtime.items,
      running: runtime.running,
      runKind: runtime.runKind,
      mood: runtime.mood,
      lastActivity: runtime.lastActivity,
      nextAutoRunAt: status.nextRunAt,
      autoBlocker: status.blocker,
      autoSkipNote: runtime.autoSkipNote,
      runsLeft: status.runsLeft,
      writeCount: runtime.writeCount
    };
  }

  listThreads(): HatchlingState[] {
    return this.threadOrder
      .map((id) => this.runtimes.get(id))
      .filter((runtime): runtime is ThreadRuntime => Boolean(runtime))
      .map((runtime) => this.toState(runtime));
  }

  getState(threadId: string): HatchlingState | null {
    const runtime = this.runtimes.get(threadId);
    return runtime ? this.toState(runtime) : null;
  }

  isGloballyPaused(): boolean {
    return this.globalPause;
  }

  setGlobalPause(paused: boolean): void {
    this.globalPause = paused;
    this.emit();
  }

  workspaceFor(threadId: string): WorkspaceStore {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) throw new Error(`Unknown hatchling: ${threadId}`);
    return runtime.workspace;
  }

  grantedPaths(threadId: string): string[] {
    return this.runtimes.get(threadId)?.permissions.grantedPaths() ?? [];
  }

  // ----- thread lifecycle -----

  async hatch(profile: HatchlingProfile = {}, seedFiles: readonly WorkspaceFile[] = []): Promise<string> {
    await this.ready;
    const threads = this.threadOrder
      .map((id) => this.runtimes.get(id)!.thread);
    const thread = createHatchling(threads, new Date(this.now()), profile);
    const runtime = this.createRuntime(thread);
    for (const file of seedFiles) {
      // Packages cannot contain protected paths; this is defense in depth.
      if (isProtectedAgentPath(file.path)) continue;
      try {
        await runtime.workspace.writeFile(file.path, file.content);
      } catch {
        /* a full store must not abort the hatch; the file list stays visible in the preview */
      }
    }
    await saveThreads(this.meta, this.currentThreads());
    this.emit();
    return thread.id;
  }

  /** Hatches a new hatchling from a validated portable agent package. */
  async hatchFromPackage(pkg: PortableAgentPackage): Promise<string> {
    const profile = hatchProfileFromPackage(pkg);
    const id = await this.hatch(profile, profile.seedFiles);
    this.recordJournalFor(id, {
      category: "source",
      outcome: "completed",
      summary: `Hatched from portable agent ${pkg.manifest.id}@${pkg.manifest.version}`,
      evidence: { package_sha256: pkg.sha256, files: pkg.files.length }
    });
    return id;
  }

  /** Packages a hatchling's profile + workspace for download or publish. */
  async exportPortableHatchling(threadId: string, meta: PortableExportMeta = {}): Promise<PortableAgentPackage> {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) throw new Error("Unknown hatchling.");
    const paths = (await runtime.workspace.listFiles()).filter((path) => !isProtectedAgentPath(path));
    const files = await Promise.all(paths.map(async (path) => ({
      path,
      content: await runtime.workspace.readFile(path)
    })));
    return buildPortableHatchling(runtime.thread, files, meta);
  }

  private recordJournalFor(threadId: string, input: Parameters<typeof appendRunJournalEvent>[1]): void {
    const runtime = this.runtimes.get(threadId);
    if (runtime) this.recordJournal(runtime, input);
  }

  async rename(threadId: string, name: string): Promise<void> {
    const runtime = this.runtimes.get(threadId);
    const trimmed = name.trim().slice(0, 24);
    if (!runtime || !trimmed) return;
    runtime.thread = { ...runtime.thread, name: trimmed };
    await saveThreads(this.meta, this.currentThreads());
    this.emit();
  }

  /** Removes a hatchling and everything it owned. `main` stays forever. */
  async removeHatchling(threadId: string): Promise<void> {
    if (threadId === MAIN_THREAD_ID) throw new Error("The first hatchling cannot be removed.");
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return;
    runtime.abort?.abort();
    await runtime.workspace.clear();
    await clearThreadTranscript(threadId, this.meta);
    this.runtimes.delete(threadId);
    this.threadOrder = this.threadOrder.filter((id) => id !== threadId);
    if (this.selected === threadId) this.selected = MAIN_THREAD_ID;
    await saveThreads(this.meta, this.currentThreads());
    this.emit();
  }

  private currentThreads(): HatchlingThread[] {
    return this.threadOrder
      .map((id) => this.runtimes.get(id))
      .filter((runtime): runtime is ThreadRuntime => Boolean(runtime))
      .map((runtime) => runtime.thread);
  }

  // ----- items & persistence -----

  private pushItem(runtime: ThreadRuntime, item: Omit<ChatItem, "id">): number {
    const id = runtime.nextId;
    runtime.nextId += 1;
    runtime.items = [...runtime.items, { ...item, id }];
    this.emit();
    return id;
  }

  notice(threadId: string, text: string, tone: "info" | "error" = "info"): void {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return;
    this.pushItem(runtime, { kind: "notice", text, tone });
    this.scheduleSave(runtime);
  }

  private scheduleSave(runtime: ThreadRuntime): void {
    if (runtime.saveTimer !== null) clearTimeout(runtime.saveTimer);
    runtime.saveTimer = setTimeout(() => {
      runtime.saveTimer = null;
      if (runtime.running) return; // saved again at run end
      void saveThreadTranscript(runtime.thread.id, {
        provider: this.deps.getConfig().provider,
        items: runtime.items.map((item) => ({
          ...item,
          streaming: false,
          toolState: item.toolState === "running" ? "done" as const : item.toolState
        })),
        messages: runtime.messages,
        nextId: runtime.nextId
      }, this.meta);
    }, SAVE_DEBOUNCE_MS);
  }

  async newChat(threadId: string): Promise<void> {
    const runtime = this.runtimes.get(threadId);
    if (!runtime || runtime.running) return;
    runtime.messages = [];
    runtime.items = [];
    runtime.citations = new Map();
    runtime.mood = "idle";
    runtime.lastActivity = "";
    await clearThreadTranscript(threadId, this.meta);
    this.emit();
  }

  /** A different provider means a different wire format: wire history resets, visible items stay. */
  handleProviderSwitch(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.messages = [];
    }
    this.emit();
  }

  async revertWrite(threadId: string, itemId: number): Promise<boolean> {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return false;
    const item = runtime.items.find((entry) => entry.id === itemId);
    const write = item?.write;
    if (!item || !write || write.reverted || write.creates) return false;
    await runtime.workspace.writeFile(write.path, write.before);
    this.recordJournal(runtime, {
      category: "effect",
      outcome: "cancelled",
      summary: `Reverted ${write.path} to its previous content`,
      evidence: { path: write.path }
    });
    runtime.writeCount += 1;
    runtime.items = runtime.items.map((entry) => (
      entry.id === itemId && entry.write ? { ...entry, write: { ...entry.write, reverted: true } } : entry
    ));
    this.pushItem(runtime, { kind: "notice", text: `Reverted ${write.path} to its previous content.`, tone: "info" });
    this.scheduleSave(runtime);
    return true;
  }

  // ----- MCP -----

  mcpStatus(): McpServerStatus[] {
    return this.mcp.status();
  }

  connectMcp(serverId: string, options: { url?: string; bearerToken?: string } = {}): Promise<number> {
    return this.mcp.connect(serverId, options);
  }

  disconnectMcp(serverId: string): Promise<void> {
    return this.mcp.disconnect(serverId);
  }

  // ----- schedule management -----

  async setSchedule(threadId: string, patch: Partial<ThreadSchedule>): Promise<void> {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return;
    runtime.thread = {
      ...runtime.thread,
      schedule: { ...runtime.thread.schedule, ...patch }
    };
    runtime.autoSkipNote = null;
    await saveThreads(this.meta, this.currentThreads());
    this.emit();
  }

  async resetScheduleBudget(threadId: string, maxAutoRuns?: number): Promise<void> {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return;
    runtime.thread = {
      ...runtime.thread,
      schedule: resetAutoRunBudget(runtime.thread.schedule, maxAutoRuns)
    };
    await saveThreads(this.meta, this.currentThreads());
    this.emit();
  }

  // ----- running -----

  private runningCount(): number {
    let count = 0;
    for (const runtime of this.runtimes.values()) if (runtime.running) count += 1;
    return count;
  }

  stop(threadId: string): void {
    this.runtimes.get(threadId)?.abort?.abort();
  }

  stopAll(): void {
    for (const runtime of this.runtimes.values()) runtime.abort?.abort();
  }

  isRunning(threadId: string): boolean {
    return this.runtimes.get(threadId)?.running ?? false;
  }

  async send(threadId: string, task: string): Promise<void> {
    await this.ready;
    const runtime = this.runtimes.get(threadId);
    const trimmed = task.trim();
    if (!runtime || runtime.running || !trimmed) return;
    this.pushItem(runtime, { kind: "user", text: trimmed });
    await this.runLoop(runtime, trimmed, "manual");
  }

  /** Appends to the thread's journal; never lets bookkeeping break a run. */
  private recordJournal(runtime: ThreadRuntime, input: Parameters<typeof appendRunJournalEvent>[1]): void {
    const bounded = { ...input, summary: (input.summary.trim() || "(event)").slice(0, 256) };
    try {
      runtime.journal = appendRunJournalEvent(runtime.journal, bounded);
    } catch {
      try {
        let rotated = appendRunJournalEvent(createRunJournal(), {
          category: "system",
          outcome: "info",
          summary: "Journal rotated after reaching its bounds; earlier events were discarded."
        });
        rotated = appendRunJournalEvent(rotated, bounded);
        runtime.journal = rotated;
      } catch {
        // Give up on this one event.
      }
    }
  }

  /** The thread's current run journal, or null for an unknown thread. */
  runJournal(threadId: string): RunJournal | null {
    return this.runtimes.get(threadId)?.journal ?? null;
  }

  /** Serializes the thread's journal for download (credential-redacted). */
  exportRunJournal(threadId: string): { fileName: string; json: string } | null {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return null;
    const task = [...runtime.items].reverse().find((entry) => entry.kind === "user")?.text ?? "";
    const json = serializeRunJournal(runtime.journal, {
      task,
      source: {
        kind: "artifact",
        connectorId: null,
        resource: `hatchling:${runtime.thread.name}`,
        sourceSha256: null
      }
    });
    return { fileName: `wasmhatch-run-${runtime.journal.runId.slice("run_journal_".length).slice(0, 12)}.json`, json };
  }

  private setMood(runtime: ThreadRuntime, mood: HatchlingMood, activity?: string): void {
    runtime.mood = mood;
    runtime.moodChangedAt = this.now();
    if (activity !== undefined) runtime.lastActivity = activity;
    this.emit();
  }

  /** Provider-native search owns the web_search name; the Tavily fallback steps aside. */
  private nativeSearchActive(config: RunConfig): boolean {
    if (config.provider === "builtin") return false;
    return config.webSearch && getCloudProvider(config.provider).webSearch !== undefined;
  }

  private buildTools(runtime: ThreadRuntime): { tools: AgentToolDefinition[]; mcp: McpConnectedServer[] } {
    const mcp = this.mcp.activeServers();
    const tools = assembleHatchlingTools({
      capabilities: runtime.thread.capabilities,
      mcpServers: mcp,
      googleConnected: this.deps.google.isConnected(),
      googlePickerAvailable: Boolean(this.deps.google.requestFilePick),
      googleSensitiveEnabled: this.deps.google.sensitiveEnabled,
      slackWebhookConnected: Boolean(this.deps.slack?.getWebhookUrl()),
      slackTokenConnected: Boolean(this.deps.slack?.getToken?.()),
      tavilyFallbackActive: Boolean(this.deps.web?.getTavilyKey()) && !this.nativeSearchActive(this.deps.getConfig()),
      jinaConnected: Boolean(this.deps.web?.getJinaKey())
    });
    return { tools, mcp };
  }

  private buildExecutor(runtime: ThreadRuntime, runKind: "manual" | "auto", mcp: McpConnectedServer[]): AgentToolExecutor {
    return createHatchlingToolExecutor({
      threadId: runtime.thread.id,
      workspace: runtime.workspace,
      permissions: runtime.permissions,
      gate: this.deps.gate,
      // Scheduled runs never gate: nobody is present to answer, and the
      // scheduler refuses to start them outside autonomous mode anyway.
      policy: () => (runKind === "auto" ? "autonomous" : this.deps.getConfig().writeMode),
      onAppliedWrite: (write) => {
        runtime.items = [...runtime.items, {
          id: runtime.nextId,
          kind: "write",
          text: `${write.creates ? "Created" : "Updated"} ${write.path}`,
          write: { ...write, reverted: false }
        }];
        runtime.nextId += 1;
        runtime.writeCount += 1;
        this.recordJournal(runtime, {
          category: "effect",
          outcome: "committed",
          summary: `${write.creates ? "Created" : "Updated"} ${write.path}`,
          evidence: { path: write.path, created: write.creates }
        });
        this.setMood(runtime, "write", `${write.creates ? "Created" : "Updated"} ${write.path}`);
      },
      onArtifact: ({ title, html }) => {
        this.artifactCounter += 1;
        this.recordJournal(runtime, {
          category: "export",
          outcome: "completed",
          summary: `HTML artifact — ${title}`,
          evidence: { bytes: html.length }
        });
        this.deps.onArtifact({ id: `artifact-${this.artifactCounter}`, title, html, createdIndex: this.artifactCounter });
      },
      tickets: this.tickets,
      google: this.deps.google,
      slack: this.deps.slack,
      web: this.deps.web,
      mcpServers: mcp,
      recordJournal: (input) => this.recordJournal(runtime, input)
    });
  }

  private handleLoopEvent(runtime: ThreadRuntime, event: AgentLoopEvent): void {
    if (event.type === "turn-start") {
      this.setMood(runtime, "thinking", "Thinking…");
    } else if (event.type === "text-delta") {
      const last = runtime.items[runtime.items.length - 1];
      if (last && last.kind === "assistant" && last.streaming) {
        runtime.items = [...runtime.items.slice(0, -1), { ...last, text: last.text + event.text }];
      } else {
        runtime.items = [...runtime.items, { id: runtime.nextId, kind: "assistant", text: event.text, streaming: true }];
        runtime.nextId += 1;
      }
      this.emit();
    } else if (event.type === "tool-call") {
      const summary = summarizeToolCall(event.name, event.args);
      runtime.items = [...runtime.items, {
        id: runtime.nextId,
        kind: "tool",
        text: summary,
        toolName: event.name,
        toolState: "running",
        callId: event.callId
      }];
      runtime.nextId += 1;
      this.setMood(runtime, "tool", summary);
    } else if (event.type === "tool-result") {
      runtime.items = runtime.items.map((item) => (
        item.kind === "tool" && item.callId === event.callId
          ? { ...item, toolState: event.isError ? "error" : "done" }
          : item
      ));
      this.emit();
    } else if (event.type === "citation") {
      if (!runtime.citations.has(event.url)) runtime.citations.set(event.url, event.title);
    } else if (event.type === "final") {
      runtime.items = runtime.items.map((item) => (item.streaming ? { ...item, streaming: false } : item));
      if (runtime.citations.size) {
        const sources = [...runtime.citations.entries()].map(([url, title]) => ({ url, title }));
        runtime.citations = new Map();
        runtime.items = [...runtime.items, { id: runtime.nextId, kind: "sources", text: "Sources", sources }];
        runtime.nextId += 1;
      }
      this.emit();
    }
  }

  /** Runs one loop for one hatchling. Returns true when the run did not throw. */
  private async runLoop(runtime: ThreadRuntime, task: string, runKind: "manual" | "auto"): Promise<boolean> {
    const config = this.deps.getConfig();
    runtime.running = true;
    runtime.runKind = runKind;
    runtime.citations = new Map();
    runtime.autoSkipNote = null;
    const controller = new AbortController();
    runtime.abort = controller;
    this.setMood(runtime, "thinking", runKind === "auto" ? "Auto work check-in…" : "Thinking…");
    this.recordJournal(runtime, {
      category: "model",
      outcome: "info",
      summary: runKind === "auto" ? "Auto work run started" : "Manual run started",
      detail: task,
      evidence: { provider: config.provider, run_kind: runKind }
    });
    let succeeded = false;
    try {
      if (config.provider === "builtin") {
        succeeded = await this.runBuiltin(runtime, task, config, controller.signal);
      } else {
        succeeded = await this.runCloud(runtime, task, runKind, config, controller.signal);
      }
      this.recordJournal(runtime, {
        category: "model",
        outcome: succeeded ? "completed" : "cancelled",
        summary: succeeded ? "Run finished" : "Run ended without completing"
      });
    } catch (error) {
      this.pushItem(runtime, {
        kind: "notice",
        text: error instanceof Error ? error.message : "The run failed unexpectedly.",
        tone: "error"
      });
      this.recordJournal(runtime, {
        category: "system",
        outcome: "failed",
        summary: "Run failed",
        detail: error instanceof Error ? error.message : String(error)
      });
      this.setMood(runtime, "error", "Something went wrong");
    } finally {
      runtime.items = runtime.items.map((item) => (item.streaming ? { ...item, streaming: false } : item));
      runtime.running = false;
      runtime.runKind = null;
      runtime.abort = null;
      runtime.lastRunEndedAt = this.now();
      if (runtime.mood !== "error") this.setMood(runtime, "done", runtime.lastActivity || "Finished");
      await saveThreadTranscript(runtime.thread.id, {
        provider: config.provider,
        items: runtime.items.map((item) => ({
          ...item,
          streaming: false,
          toolState: item.toolState === "running" ? "done" as const : item.toolState
        })),
        messages: runtime.messages,
        nextId: runtime.nextId
      }, this.meta);
      this.emit();
    }
    return succeeded;
  }

  private swarmPromptContext(runtime: ThreadRuntime, scheduled: boolean) {
    const coworkers = this.currentThreads()
      .filter((thread) => thread.id !== runtime.thread.id)
      .map((thread) => thread.name);
    return { name: runtime.thread.name, coworkers, scheduled };
  }

  private async runCloud(
    runtime: ThreadRuntime,
    task: string,
    runKind: "manual" | "auto",
    config: RunConfig,
    signal: AbortSignal
  ): Promise<boolean> {
    if (config.provider === "builtin") return false;
    const def = getCloudProvider(config.provider);
    const key = config.apiKey.trim();
    if (!def.keyless && !key) {
      this.pushItem(runtime, {
        kind: "notice",
        text: "Add your API key first — it stays in this tab's memory and is sent only to the selected provider.",
        tone: "error"
      });
      return false;
    }
    const nativeSearch = config.webSearch && def.webSearch !== undefined;
    const fallbackSearch = !nativeSearch && Boolean(this.deps.web?.getTavilyKey());
    const providerImpl = this.deps.createCloudProvider
      ? this.deps.createCloudProvider(config)
      : def.adapter === "anthropic"
        ? createAnthropicProvider({ apiKey: key, webSearch: nativeSearch && def.webSearch === "server-tool" })
        : def.adapter === "openai-responses"
          ? createOpenAiResponsesProvider({ apiKey: key, baseUrl: def.baseUrl, id: def.id })
          : createOpenAiCompatibleProvider({
            apiKey: key,
            baseUrl: def.baseUrl,
            id: def.id,
            maxTokensParam: def.maxTokensParam,
            webPlugin: nativeSearch && def.webSearch === "plugin"
          });
    const { tools, mcp } = this.buildTools(runtime);
    const policy = runKind === "auto" ? "autonomous" : config.writeMode;
    const result = await runAgentLoop({
      provider: providerImpl,
      model: config.model.trim() || def.defaultModel,
      system: systemPrompt(
        policy,
        { search: nativeSearch || fallbackSearch, fetchPage: Boolean(this.deps.web?.getJinaKey()) },
        this.swarmPromptContext(runtime, runKind === "auto"),
        runtime.thread.instructions
      ),
      messages: runtime.messages.length ? runtime.messages : undefined,
      task,
      tools,
      execute: this.buildExecutor(runtime, runKind, mcp),
      onEvent: (event) => this.handleLoopEvent(runtime, event),
      signal
    });
    runtime.messages = result.messages;
    if (result.status === "cancelled") {
      this.pushItem(runtime, { kind: "notice", text: "Run stopped. The conversation is intact — continue whenever you like.", tone: "info" });
    }
    if (result.status === "budget-exhausted") {
      this.pushItem(runtime, { kind: "notice", text: "The run paused at its soft budget. Send another message to continue from where it stopped.", tone: "info" });
    }
    return true;
  }

  private async runBuiltin(
    runtime: ThreadRuntime,
    task: string,
    config: RunConfig,
    signal: AbortSignal
  ): Promise<boolean> {
    const api = this.deps.getBuiltinApi?.();
    if (!api || config.builtinAvailability !== "available") {
      this.pushItem(runtime, {
        kind: "notice",
        text: config.builtinAvailability === "downloadable" || config.builtinAvailability === "downloading"
          ? "Chrome can run this on-device but is still downloading the model. Try again shortly, or switch to a BYOK provider."
          : "Chrome built-in AI is not available in this browser. Switch to Anthropic or OpenAI with your own key.",
        tone: "error"
      });
      return false;
    }
    const { tools, mcp } = this.buildTools(runtime);
    const execute = this.buildExecutor(runtime, "manual", mcp);
    const createSession = async (): Promise<BuiltinAiSessionLike> => {
      const session = await callWithLanguageFallback((languageOptions) => api.create({
        ...languageOptions,
        signal,
        initialPrompts: [{
          role: "system",
          content: systemPrompt(
            this.deps.getConfig().writeMode,
            { search: Boolean(this.deps.web?.getTavilyKey()), fetchPage: Boolean(this.deps.web?.getJinaKey()) },
            this.swarmPromptContext(runtime, false),
            runtime.thread.instructions
          )
        }]
      }));
      return {
        prompt: (promptInput, options) => session.prompt(promptInput, {
          signal: options?.signal ?? signal,
          responseConstraint: options?.responseConstraint,
          omitResponseConstraintInput: false
        }),
        destroy: () => session.destroy()
      };
    };
    const result = await runBuiltinAiToolLoop({
      task,
      tools: tools as unknown as BuiltinTool[],
      execute: async (name, args) => {
        const outcome = await execute(name, args, { signal });
        return outcome.isError ? `Error: ${outcome.content}` : outcome.content;
      },
      createSession,
      signal,
      onEvent: (event) => {
        if (event.type === "tool-call") {
          const summary = summarizeToolCall(event.tool, event.arguments);
          runtime.items = [...runtime.items, {
            id: runtime.nextId,
            kind: "tool",
            text: summary,
            toolName: event.tool,
            toolState: "running",
            callId: `builtin-${event.step}`
          }];
          runtime.nextId += 1;
          this.setMood(runtime, "tool", summary);
        } else if (event.type === "tool-result") {
          runtime.items = runtime.items.map((item) => (
            item.kind === "tool" && item.callId === `builtin-${event.step}`
              ? { ...item, toolState: "done" }
              : item
          ));
          this.emit();
        } else if (event.type === "final") {
          runtime.items = [...runtime.items, { id: runtime.nextId, kind: "assistant", text: event.answer }];
          runtime.nextId += 1;
          this.emit();
        }
      }
    });
    if (result.status === "max-steps-exhausted") {
      this.pushItem(runtime, {
        kind: "notice",
        text: "The on-device run reached its step budget. Ask a smaller follow-up or switch to a BYOK provider.",
        tone: "info"
      });
    }
    return true;
  }

  // ----- scheduler -----

  private autoRunReadiness(config: RunConfig): string | null {
    if (config.writeMode !== "autonomous") {
      return "Auto work runs only in Fast (autonomous) mode — nobody is here to approve careful-mode writes.";
    }
    if (config.provider === "builtin") {
      return config.builtinAvailability === "available" ? null : "Auto work needs the on-device model to be ready.";
    }
    const def = getCloudProvider(config.provider);
    if (!def.keyless && !config.apiKey.trim()) return "Add an API key to let auto work run.";
    return null;
  }

  private async onTick(): Promise<void> {
    if (this.disposed) return;
    await this.ready;
    const now = this.now();
    // Relax "done" faces back to idle.
    for (const runtime of this.runtimes.values()) {
      if (runtime.mood === "done" && now - runtime.moodChangedAt > DONE_MOOD_DECAY_MS) {
        runtime.mood = "idle";
      }
    }
    if (!this.globalPause && this.runningCount() < MAX_CONCURRENT_RUNS) {
      const config = this.deps.getConfig();
      const readinessNote = this.autoRunReadiness(config);
      for (const threadId of this.threadOrder) {
        const runtime = this.runtimes.get(threadId);
        if (!runtime) continue;
        const status = evaluateSchedule({
          schedule: runtime.thread.schedule,
          lastRunEndedAt: runtime.lastRunEndedAt,
          running: runtime.running,
          now
        });
        if (!status.due) continue;
        if (readinessNote) {
          runtime.autoSkipNote = readinessNote;
          continue;
        }
        // One auto start per tick: a natural stagger for provider rate limits.
        void this.startAutoRun(runtime);
        break;
      }
    }
    this.emit();
  }

  private async startAutoRun(runtime: ThreadRuntime): Promise<void> {
    const prompt = runtime.thread.schedule.prompt;
    this.pushItem(runtime, { kind: "notice", text: `Auto work check-in (every ${runtime.thread.schedule.intervalMinutes} min).`, tone: "info" });
    const succeeded = await this.runLoop(runtime, prompt, "auto");
    const { schedule, autoDisabled } = applyAutoRunOutcome(runtime.thread.schedule, succeeded);
    runtime.thread = { ...runtime.thread, schedule };
    if (autoDisabled) {
      this.pushItem(runtime, {
        kind: "notice",
        text: "Auto work turned itself off after repeated failures. Fix the cause (key, provider, network) and switch it back on.",
        tone: "error"
      });
    } else if (schedule.autoRuns >= schedule.maxAutoRuns) {
      this.pushItem(runtime, {
        kind: "notice",
        text: `Auto work reached its ${schedule.maxAutoRuns}-run budget and is waiting. Reset the budget to continue.`,
        tone: "info"
      });
    }
    await saveThreads(this.meta, this.currentThreads());
    this.emit();
  }
}
