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

import type { ErrorPart } from "@a2ui/agent";
import { A2uiInputLimitError } from "./a2ui/input-limits";
import {
  buildSelfRepairPrompt,
  HatchlingA2uiRuntime,
  type SurfaceActionDispatch,
  type TurnAnswerPart
} from "./a2ui/runtime";
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
  DEFAULT_LOOP_PROMPT,
  loadThreads,
  MAIN_THREAD_ID,
  saveThreads,
  SCHEDULE_LIMITS,
  workspaceRootsForThread,
  type HatchlingProfile,
  type HatchlingThread,
  type ThreadSchedule
} from "./agent-threads";
import type { HtmlArtifact } from "./artifact";
import {
  createBuiltinAiSession,
  runBuiltinAiToolLoop,
  type BuiltinAiSessionLike,
  type ChromeLanguageModelApi,
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
import { activeLocale } from "./i18n";
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
  kind: "user" | "assistant" | "tool" | "notice" | "write" | "sources" | "surface";
  text: string;
  /** Surface identifier when `kind === "surface"`. */
  surfaceId?: string;
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

export interface SwarmDeps {
  getConfig: () => RunConfig;
  /** Careful-mode approval UI; only manual runs ever reach it. */
  gate: PermissionGate;
  onArtifact: (artifact: HtmlArtifact, threadId?: string) => void;
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
  a2ui: HatchlingA2uiRuntime;
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
  runCounter: number;
  removed?: boolean;
  /** In-memory audit trail of this thread's runs; exported on demand. */
  journal: RunJournal;
}

/** At most this many hatchlings run loops at the same moment. */
export const MAX_CONCURRENT_RUNS = 3;
/** A "done" face relaxes back to idle after this long. */
const DONE_MOOD_DECAY_MS = 45_000;
const SAVE_DEBOUNCE_MS = 400;

// The generated catalog prompt exceeds 20K characters even after pruning.
// Nano needs a concise example, leaving its context for the task and tools.
const BUILTIN_A2UI_SNIPPET = [
  "Optional interactive UI uses A2UI Express, never HTML, inside an <a2ui> block in the final answer.",
  "Use these compact components: Text(text=...), Card(child=...), Column(children=[...]), Row(children=[...]), Button(child=Text(text=...), action=Event(\"name\", {})), TextField(label=..., value=$/path), CheckBox(label=..., value=$/path).",
  "Initialize bound values with $/path = value. Assign the outer component to root. Reuse a surface id to update it.",
  "Example:\n<a2ui>\nsurface(\"summary\")\nroot = Card(child=Column(children=[Text(text=\"Ready\"), Button(child=Text(text=\"Continue\"), action=Event(\"continue\", {}))]))\n</a2ui>",
  "Prefer plain text for simple replies; use create_artifact for richer reports and dashboards."
].join("\n");

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
  private providerEpoch = 0;
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
      const restored = await loadThreadTranscript<ChatItem, AgentMessage>(
        thread.id,
        provider,
        this.meta,
        { preserveItemsOnProviderMismatch: true }
      );
      if (restored) {
        runtime.items = restored.items;
        runtime.messages = restored.messages;
        runtime.nextId = restored.nextId;
        if (restored.surfaces) {
          this.restoreStoredSurfaces(runtime, restored.surfaces);
        }
      } else if (thread.id === MAIN_THREAD_ID) {
        // One-time migration of the legacy single-thread localStorage blob.
        const legacy = loadChatTranscript<ChatItem, AgentMessage>(provider);
        if (legacy) {
          runtime.items = legacy.items;
          runtime.messages = legacy.messages;
          runtime.nextId = legacy.nextId;
          if (legacy.surfaces) {
            this.restoreStoredSurfaces(runtime, legacy.surfaces);
          }
          await saveThreadTranscript(thread.id, {
            provider,
            items: runtime.items,
            messages: runtime.messages,
            nextId: runtime.nextId,
            surfaces: runtime.a2ui.serializeSurfaces()
          }, this.meta);
          clearChatTranscript();
        }
      }
    }
    void this.tickets.ready();
    this.emit();
  }

  private restoreStoredSurfaces(runtime: ThreadRuntime, surfaces: readonly unknown[]): void {
    try {
      runtime.a2ui.restoreSurfaces(surfaces, { silent: true });
    } catch (error) {
      if (!(error instanceof A2uiInputLimitError)) throw error;
      runtime.items = [...runtime.items, {
        id: runtime.nextId++, kind: "notice", text: error.message, tone: "error"
      }];
    }
  }

  private recordAppliedWrite(
    runtime: ThreadRuntime,
    write: AppliedWrite,
    persistImmediately = false
  ): void {
    runtime.items = [
      ...runtime.items,
      {
        id: runtime.nextId,
        kind: "write",
        text: `${write.creates ? "Created" : "Updated"} ${write.path}`,
        write: { ...write, reverted: false }
      }
    ];
    runtime.nextId += 1;
    runtime.writeCount += 1;
    this.recordJournal(runtime, {
      category: "effect",
      outcome: "committed",
      summary: `${write.creates ? "Created" : "Updated"} ${write.path}`,
      evidence: { path: write.path, created: write.creates }
    });
    this.setMood(runtime, "write", `${write.creates ? "Created" : "Updated"} ${write.path}`);
    if (persistImmediately) {
      this.scheduleSave(runtime);
      this.emit();
    }
  }

  private createRuntime(thread: HatchlingThread): ThreadRuntime {
    const workspace = createWorkspaceStore(workspaceRootsForThread(thread.id));
    const permissions = new SessionPermissionStore();
    const a2ui = new HatchlingA2uiRuntime({
      getLocale: () => activeLocale(),
      workspace,
      permissions,
      gate: this.deps.gate,
      threadId: thread.id,
      getThreadName: () => this.runtimes.get(thread.id)?.thread.name ?? thread.name,
      getCapabilities: () => this.runtimes.get(thread.id)?.thread.capabilities ?? thread.capabilities,
      getWritePolicy: () => this.deps.getConfig().writeMode,
      google: this.deps.google,
      slack: this.deps.slack,
      getActiveMcpServers: () => this.mcp.activeServers(),
      onAppliedWrite: (write) => {
        const current = this.runtimes.get(thread.id);
        if (current) {
          this.recordAppliedWrite(current, write, true);
        }
      },
      onAudit: (entry) => {
        const current = this.runtimes.get(thread.id);
        if (current) {
          this.recordJournal(current, entry);
        }
      },
      onAction: (dispatch) => {
        void this.dispatchSurfaceAction(thread.id, dispatch);
      },
      onChange: () => {
        const current = this.runtimes.get(thread.id);
        if (current) this.scheduleSave(current);
        this.emit();
      }
    });
    const runtime: ThreadRuntime = {
      thread,
      workspace,
      permissions,
      a2ui,
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
      runCounter: 0,
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
      runtime.a2ui.dispose();
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

  a2uiFor(threadId: string): HatchlingA2uiRuntime | null {
    return this.runtimes.get(threadId)?.a2ui ?? null;
  }

  pinSurfaceToCanvas(threadId: string, surfaceId: string): void {
    this.runtimes.get(threadId)?.a2ui.pinSurface(surfaceId);
  }

  selectCanvasSurface(threadId: string, surfaceId: string): void {
    this.runtimes.get(threadId)?.a2ui.selectCanvasSurface(surfaceId);
  }

  closeCanvasSurface(threadId: string, surfaceId: string): void {
    this.runtimes.get(threadId)?.a2ui.closeCanvasSurface(surfaceId);
  }

  exportSurfaceHtml(
    threadId: string,
    surfaceId: string
  ): { fileName: string; title: string; html: string } | null {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return null;
    const exported = runtime.a2ui.exportSurfaceHtml(surfaceId);
    if (!exported) return null;
    this.recordJournal(runtime, {
      category: "export",
      outcome: "completed",
      summary: `Exported interactive app HTML — ${exported.title}`,
      evidence: { surfaceId, bytes: exported.html.length }
    });
    return exported;
  }

  async dispatchSurfaceAction(threadId: string, dispatch: SurfaceActionDispatch): Promise<void> {
    if (!dispatch.userActivated) return;
    await this.ready;
    const runtime = this.runtimes.get(threadId);
    if (!runtime || runtime.running || runtime.removed) return;
    this.recordJournal(runtime, {
      category: "source",
      outcome: "info",
      summary: `Surface action: ${dispatch.action.name} (${dispatch.action.surfaceId})`,
      evidence: {
        surfaceId: dispatch.action.surfaceId,
        action: dispatch.action.name,
        sourceComponentId: dispatch.action.sourceComponentId
      }
    });
    this.pushItem(runtime, { kind: "user", text: dispatch.userLabel });
    await this.runLoop(runtime, dispatch.agentTask, "manual");
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
    await this.ready;
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
    await this.ready;
    const runtime = this.runtimes.get(threadId);
    const trimmed = name.trim().slice(0, 24);
    if (!runtime || !trimmed) return;
    runtime.thread = { ...runtime.thread, name: trimmed };
    await saveThreads(this.meta, this.currentThreads());
    this.emit();
  }

  /** Removes a hatchling and everything it owned. `main` stays forever. */
  async removeHatchling(threadId: string): Promise<void> {
    await this.ready;
    if (threadId === MAIN_THREAD_ID) throw new Error("The first hatchling cannot be removed.");
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return;
    runtime.removed = true;
    if (runtime.saveTimer !== null) {
      clearTimeout(runtime.saveTimer);
      runtime.saveTimer = null;
    }
    runtime.abort?.abort();
    runtime.a2ui.dispose();
    this.runtimes.delete(threadId);
    this.threadOrder = this.threadOrder.filter((id) => id !== threadId);
    if (this.selected === threadId) this.selected = MAIN_THREAD_ID;
    await runtime.workspace.clear();
    await clearThreadTranscript(threadId, this.meta);
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
    if (runtime.removed) return;
    if (runtime.saveTimer !== null) clearTimeout(runtime.saveTimer);
    runtime.saveTimer = setTimeout(() => {
      runtime.saveTimer = null;
      if (runtime.running || runtime.removed) return; // saved again at run end
      void saveThreadTranscript(runtime.thread.id, {
        provider: this.deps.getConfig().provider,
        items: runtime.items.map((item) => ({
          ...item,
          streaming: false,
          toolState: item.toolState === "running" ? "done" as const : item.toolState
        })),
        messages: runtime.messages,
        nextId: runtime.nextId,
        surfaces: runtime.a2ui.serializeSurfaces()
      }, this.meta);
    }, SAVE_DEBOUNCE_MS);
  }

  async newChat(threadId: string): Promise<void> {
    await this.ready;
    const runtime = this.runtimes.get(threadId);
    if (!runtime || runtime.running) return;
    if (runtime.saveTimer !== null) {
      clearTimeout(runtime.saveTimer);
      runtime.saveTimer = null;
    }
    runtime.messages = [];
    runtime.items = [];
    runtime.citations = new Map();
    runtime.a2ui.clear();
    runtime.mood = "idle";
    runtime.lastActivity = "";
    await clearThreadTranscript(threadId, this.meta);
    this.emit();
  }

  /** A different provider means a different wire format: wire history resets, visible items stay. */
  handleProviderSwitch(): void {
    this.providerEpoch += 1;
    for (const runtime of this.runtimes.values()) {
      runtime.messages = [];
    }
    this.emit();
  }

  async revertWrite(threadId: string, itemId: number): Promise<boolean> {
    await this.ready;
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return false;
    const item = runtime.items.find((entry) => entry.id === itemId);
    const write = item?.write;
    if (!item || !write || write.reverted) return false;
    if (write.after !== undefined) {
      let current: string | null = null;
      try {
        current = await runtime.workspace.readFile(write.path);
      } catch {
        current = null;
      }
      if (current !== write.after) {
        this.pushItem(runtime, {
          kind: "notice",
          text: `Could not undo ${write.path}: the file changed after this write.`,
          tone: "error"
        });
        this.scheduleSave(runtime);
        return false;
      }
    }
    if (write.creates) {
      await runtime.workspace.deleteFile(write.path);
    } else {
      await runtime.workspace.writeFile(write.path, write.before);
    }
    const actionSummary = write.creates
      ? `Removed newly created ${write.path}`
      : `Reverted ${write.path} to its previous content`;
    this.recordJournal(runtime, {
      category: "effect",
      outcome: "cancelled",
      summary: actionSummary,
      evidence: { path: write.path }
    });
    runtime.writeCount += 1;
    runtime.items = runtime.items.map((entry) => (
      entry.id === itemId && entry.write ? { ...entry, write: { ...entry.write, reverted: true } } : entry
    ));
    this.pushItem(runtime, { kind: "notice", text: `${actionSummary}.`, tone: "info" });
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
    await this.ready;
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return;
    const current = runtime.thread.schedule;
    const intervalMinutes = typeof patch.intervalMinutes === "number" && Number.isFinite(patch.intervalMinutes)
      ? Math.min(SCHEDULE_LIMITS.maxIntervalMinutes, Math.max(SCHEDULE_LIMITS.minIntervalMinutes, Math.round(patch.intervalMinutes)))
      : current.intervalMinutes;
    const maxAutoRuns = typeof patch.maxAutoRuns === "number" && Number.isFinite(patch.maxAutoRuns)
      ? Math.min(SCHEDULE_LIMITS.maxMaxAutoRuns, Math.max(1, Math.round(patch.maxAutoRuns)))
      : current.maxAutoRuns;
    const prompt = typeof patch.prompt === "string"
      ? patch.prompt.slice(0, SCHEDULE_LIMITS.maxPromptChars)
      : current.prompt;
    const enabled = typeof patch.enabled === "boolean" ? patch.enabled : current.enabled;
    const autoRuns = typeof patch.autoRuns === "number" && Number.isFinite(patch.autoRuns)
      ? Math.min(SCHEDULE_LIMITS.maxMaxAutoRuns, Math.max(0, Math.round(patch.autoRuns)))
      : current.autoRuns;
    const consecutiveFailures = typeof patch.consecutiveFailures === "number" && Number.isFinite(patch.consecutiveFailures)
      ? Math.min(SCHEDULE_LIMITS.maxConsecutiveFailures, Math.max(0, Math.round(patch.consecutiveFailures)))
      : current.consecutiveFailures;
    runtime.thread = {
      ...runtime.thread,
      schedule: {
        enabled,
        intervalMinutes,
        prompt,
        maxAutoRuns,
        autoRuns,
        consecutiveFailures
      }
    };
    runtime.autoSkipNote = null;
    await saveThreads(this.meta, this.currentThreads());
    this.emit();
  }

  async resetScheduleBudget(threadId: string, maxAutoRuns?: number): Promise<void> {
    await this.ready;
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

  private buildTools(
    runtime: ThreadRuntime,
    runKind: "manual" | "auto" = "manual"
  ): { tools: AgentToolDefinition[]; mcp: McpConnectedServer[] } {
    const mcp = this.mcp.activeServers();
    const tools = assembleHatchlingTools({
      capabilities: runtime.thread.capabilities,
      mcpServers: mcp,
      googleConnected: this.deps.google.isConnected(),
      // Scheduled runs have no human at the screen to click the Google Picker.
      googlePickerAvailable: runKind !== "auto" && Boolean(this.deps.google.requestFilePick),
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
      threadName: runtime.thread.name,
      workspace: runtime.workspace,
      permissions: runtime.permissions,
      gate: this.deps.gate,
      // Scheduled runs never gate: nobody is present to answer, and the
      // scheduler refuses to start them outside autonomous mode anyway.
      policy: () => (runKind === "auto" ? "autonomous" : this.deps.getConfig().writeMode),
      onAppliedWrite: (write) => {
        this.recordAppliedWrite(runtime, write, false);
      },
      onArtifact: ({ title, html }) => {
        this.artifactCounter += 1;
        this.recordJournal(runtime, {
          category: "export",
          outcome: "completed",
          summary: `HTML artifact — ${title}`,
          evidence: { bytes: html.length }
        });
        this.deps.onArtifact(
          { id: `artifact-${this.artifactCounter}`, title, html, createdIndex: this.artifactCounter },
          runtime.thread.id
        );
      },
      tickets: this.tickets,
      google: this.deps.google,
      slack: this.deps.slack,
      web: this.deps.web,
      mcpServers: mcp,
      onMcpUiResult: async ({ server, tool, args, raw, signal }) => {
        if (runKind === "auto") return null;
        const { surfaceIds, assistantNote } = await runtime.a2ui.ingestMcpToolResult({
          server,
          toolName: tool,
          toolArgs: args,
          rawResult: raw,
          signal
        });
        for (const surfaceId of surfaceIds) {
          const alreadyListed = runtime.items.some(
            (entry) => entry.kind === "surface" && entry.surfaceId === surfaceId
          );
          if (!alreadyListed) {
            this.pushItem(runtime, {
              kind: "surface",
              surfaceId,
              text: runtime.a2ui.getSurfaceTitle(surfaceId)
            });
          }
        }
        return assistantNote;
      },
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
        succeeded = await this.runBuiltin(runtime, task, runKind, config, controller.signal);
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
      if (!runtime.removed) {
        if (runtime.mood !== "error") this.setMood(runtime, "done", runtime.lastActivity || "Finished");
        await saveThreadTranscript(runtime.thread.id, {
          provider: config.provider,
          items: runtime.items.map((item) => ({
            ...item,
            streaming: false,
            toolState: item.toolState === "running" ? "done" as const : item.toolState
          })),
          messages: runtime.messages,
          nextId: runtime.nextId,
          surfaces: runtime.a2ui.serializeSurfaces()
        }, this.meta);
      }
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

  private buildItemsFromTurnParts(
    runtime: ThreadRuntime,
    parts: readonly TurnAnswerPart[],
    slotIds: Map<string, number>,
    streaming: boolean
  ): { items: ChatItem[]; updatedSurfaceIds: Set<string> } {
    const items: ChatItem[] = [];
    const updatedSurfaceIds = new Set<string>();
    const allocateId = (key: string): number => {
      const existing = slotIds.get(key);
      if (existing !== undefined) return existing;
      const next = runtime.nextId;
      runtime.nextId += 1;
      slotIds.set(key, next);
      return next;
    };

    parts.forEach((part, index) => {
      if (part.kind === "text") {
        if (!part.text.trim()) return;
        items.push({
          id: allocateId(`text:${index}`),
          kind: "assistant",
          text: part.text,
          streaming
        });
      } else if (part.kind === "surface") {
        updatedSurfaceIds.add(part.surfaceId);
        items.push({
          id: allocateId(`surface:${part.surfaceId}`),
          kind: "surface",
          surfaceId: part.surfaceId,
          text: part.title
        });
      }
    });

    return { items, updatedSurfaceIds };
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
    const { tools, mcp } = this.buildTools(runtime, runKind);
    const policy = runKind === "auto" ? "autonomous" : config.writeMode;
    const startEpoch = this.providerEpoch;
    const system = systemPrompt(
      policy,
      { search: nativeSearch || fallbackSearch, fetchPage: Boolean(this.deps.web?.getJinaKey()) },
      this.swarmPromptContext(runtime, runKind === "auto"),
      runtime.thread.instructions,
      new Date(this.now()),
      runKind === "auto" ? undefined : runtime.a2ui.promptSnippet("cloud")
    );
    const execute = this.buildExecutor(runtime, runKind, mcp);

    const runStreamingPass = async (passTask: string, priorMessages: readonly AgentMessage[] | undefined) => {
      const turnErrors: ErrorPart[] = [];
      let activeSegment: {
        stream: ReturnType<HatchlingA2uiRuntime["openTurnStream"]>;
        anchorItems: ChatItem[];
        slotIds: Map<string, number>;
      } | null = null;

      const syncSegment = (parts: readonly TurnAnswerPart[], streaming: boolean) => {
        if (!activeSegment) return;
        const { items, updatedSurfaceIds } = this.buildItemsFromTurnParts(
          runtime,
          parts,
          activeSegment.slotIds,
          streaming
        );
        const filteredAnchors = updatedSurfaceIds.size > 0
          ? activeSegment.anchorItems.filter(
              (entry) => !(entry.kind === "surface" && entry.surfaceId && updatedSurfaceIds.has(entry.surfaceId))
            )
          : activeSegment.anchorItems;
        runtime.items = [...filteredAnchors, ...items];
      };

      const finalizeSegment = () => {
        if (!activeSegment) return;
        const closed = activeSegment.stream.close();
        if (closed.errors.length > 0) {
          turnErrors.push(...closed.errors);
        }
        syncSegment(closed.parts, false);
        activeSegment = null;
      };

      try {
        const passResult = await runAgentLoop({
          provider: providerImpl,
          model: config.model.trim() || def.defaultModel,
          system,
          messages: priorMessages && priorMessages.length ? priorMessages : undefined,
          task: passTask,
          tools,
          execute,
          onEvent: (event) => {
            if (event.type === "turn-start") {
              finalizeSegment();
              this.setMood(runtime, "thinking", "Thinking…");
              return;
            }
            if (event.type === "text-delta") {
              if (!activeSegment) {
                activeSegment = {
                  stream: runtime.a2ui.openTurnStream("cloud"),
                  anchorItems: runtime.items.slice(),
                  slotIds: new Map()
                };
              }
              const parts = activeSegment.stream.feed(event.text);
              syncSegment(parts, true);
              this.emit();
              return;
            }
            if (event.type === "usage") {
              finalizeSegment();
              return;
            }
            if (event.type === "tool-call" || event.type === "final") {
              finalizeSegment();
            }
            this.handleLoopEvent(runtime, event);
          },
          signal
        });
        return { passResult, turnErrors };
      } finally {
        finalizeSegment();
      }
    };

    let { passResult: result, turnErrors } = await runStreamingPass(task, runtime.messages);

    // ADR-4: Automatic 1-turn self-repair when an `<a2ui>` block fails compilation.
    if (result.status === "completed" && !signal.aborted && turnErrors.length > 0) {
      this.recordJournal(runtime, {
        category: "model",
        outcome: "info",
        summary: "Retrying malformed interactive UI block (1/1)",
        detail: turnErrors.map((entry) => entry.error.message).join("; ")
      });
      const repairPrompt = buildSelfRepairPrompt(turnErrors);
      const retry = await runStreamingPass(repairPrompt, result.messages);
      result = retry.passResult;
      turnErrors = retry.turnErrors;
      if (turnErrors.length > 0 && !signal.aborted) {
        this.pushItem(runtime, {
          kind: "notice",
          text: `Interactive view could not be rendered: ${turnErrors[0].error.message}`,
          tone: "error"
        });
      }
    }

    if (startEpoch === this.providerEpoch && !runtime.removed) {
      runtime.messages = result.messages;
    }
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
    runKind: "manual" | "auto",
    config: RunConfig,
    signal: AbortSignal
  ): Promise<boolean> {
    const api = this.deps.getBuiltinApi?.();
    if (!api || config.builtinAvailability !== "available") {
      this.pushItem(runtime, {
        kind: "notice",
        text: config.builtinAvailability === "downloadable" || config.builtinAvailability === "downloading"
          ? "Prepare Chrome's on-device model in the AI settings, then send your message again. The first use needs a model download."
          : "Chrome built-in AI is not available in this browser. Switch to Anthropic or OpenAI with your own key.",
        tone: "error"
      });
      return false;
    }
    const { tools, mcp } = this.buildTools(runtime, runKind);
    const policy = runKind === "auto" ? "autonomous" : config.writeMode;
    const execute = this.buildExecutor(runtime, runKind, mcp);
    runtime.runCounter += 1;
    const runSeq = runtime.runCounter;
    let activeStep = 0;
    const failedSteps = new Set<number>();
    const createSession = async (): Promise<BuiltinAiSessionLike> => {
      const session = await createBuiltinAiSession({
        signal,
        initialPrompts: [{
          role: "system",
          content: systemPrompt(
            policy,
            { search: Boolean(this.deps.web?.getTavilyKey()), fetchPage: Boolean(this.deps.web?.getJinaKey()) },
            this.swarmPromptContext(runtime, runKind === "auto"),
            runtime.thread.instructions,
            new Date(this.now()),
            runKind === "auto" ? undefined : BUILTIN_A2UI_SNIPPET
          )
        }]
      }, { LanguageModel: api });
      return {
        contextWindow: session.contextWindow,
        contextUsage: session.contextUsage,
        ...(session.measureContextUsage ? {
          measureContextUsage: (promptInput: string, options: Parameters<NonNullable<BuiltinAiSessionLike["measureContextUsage"]>>[1]) =>
            session.measureContextUsage!(promptInput, options)
        } : {}),
        prompt: (promptInput, options) => session.prompt(promptInput, {
          signal: options?.signal ?? signal,
          responseConstraint: options?.responseConstraint,
          // The loop already describes both JSON actions in its prompt. Avoid
          // spending Nano's small context window on a duplicate schema.
          omitResponseConstraintInput: true
        }),
        destroy: () => session.destroy?.()
      };
    };
    let result;
    try {
      result = await runBuiltinAiToolLoop({
        task,
        tools: tools as unknown as BuiltinTool[],
        execute: async (name, args) => {
          const outcome = await execute(name, args, { signal });
          if (outcome.isError) failedSteps.add(activeStep);
          return outcome.isError ? `Error: ${outcome.content}` : outcome.content;
        },
        createSession,
        signal,
        onEvent: (event) => {
          if (event.type === "tool-call") {
            activeStep = event.step;
            const summary = summarizeToolCall(event.tool, event.arguments);
            runtime.items = [...runtime.items, {
              id: runtime.nextId,
              kind: "tool",
              text: summary,
              toolName: event.tool,
              toolState: "running",
              callId: `builtin-${runSeq}-${event.step}`
            }];
            runtime.nextId += 1;
            this.setMood(runtime, "tool", summary);
          } else if (event.type === "tool-result") {
            const isError = failedSteps.has(event.step);
            runtime.items = runtime.items.map((item) => (
              item.kind === "tool" && item.callId === `builtin-${runSeq}-${event.step}`
                ? { ...item, toolState: isError ? "error" : "done" }
                : item
            ));
            this.emit();
          } else if (event.type === "final") {
            const parsed = runtime.a2ui.applyWholeResponse(event.answer, "nano");
            const { items, updatedSurfaceIds } = this.buildItemsFromTurnParts(
              runtime,
              parsed.parts,
              new Map(),
              false
            );
            const filteredPrior = updatedSurfaceIds.size > 0
              ? runtime.items.filter(
                  (entry) => !(entry.kind === "surface" && entry.surfaceId && updatedSurfaceIds.has(entry.surfaceId))
                )
              : runtime.items;
            if (items.length > 0) {
              runtime.items = [...filteredPrior, ...items];
            } else if (parsed.errors.length === 0) {
              runtime.items = [...filteredPrior, { id: runtime.nextId, kind: "assistant", text: event.answer }];
              runtime.nextId += 1;
            }
            if (parsed.errors.length > 0) {
              this.pushItem(runtime, {
                kind: "notice",
                text: `Interactive view could not be rendered: ${parsed.errors[0].error.message}`,
                tone: "error"
              });
            } else {
              this.emit();
            }
          }
        }
      });
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        this.pushItem(runtime, {
          kind: "notice",
          text: "Run stopped. The conversation is intact — continue whenever you like.",
          tone: "info"
        });
        return true;
      }
      throw error;
    }
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
    const prompt = runtime.thread.schedule.prompt.trim() || DEFAULT_LOOP_PROMPT;
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
