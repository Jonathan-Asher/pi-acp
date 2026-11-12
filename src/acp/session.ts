import type {
  AgentSideConnection,
  ContentBlock,
  McpServer,
  PermissionOption,
  SessionUpdate,
  StopReason,
  ToolCallContent,
  ToolCallLocation,
  ToolKind
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { piChildEnv, SUBAGENTS_TEMP_ROOT_ENV } from '../pi-rpc/env.js'
import { PiRpcProcess, PiRpcSpawnError, type PiRpcEvent, type PromptDisposition } from '../pi-rpc/process.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { AirTasks, type AsyncTaskProgress } from './live/air.js'
import { BgJobTracker, isTerminalJobState, JOB_TOOLS, type BackgroundJobSnapshot } from './live/bg-jobs.js'
import {
  BG_JOB_EXIT,
  INJECTED_USER_TYPE,
  legacyJobReport,
  noticeRunIds,
  noticeSummary,
  triggerKindOf,
  wakeReason,
  type LegacyJobReport,
  type TriggerKind
} from './live/notices.js'
import { sessionHeaderId } from './live/session-header.js'
import { isTerminalStatus, SubagentTracker, SUBAGENT_TOOLS, type SubagentRunSnapshot } from './live/subagents.js'
import {
  boundedJson,
  clipText,
  compact,
  contentText,
  firstLine,
  isRecord,
  LIVE_VERSION,
  NOTICE_TEXT_MAX_CHARS,
  num,
  str,
  type JsonRecord
} from './live/wire.js'
import { SessionStore } from './session-store.js'
import { assistantStopOf, piStopError, turnOutcome, type PiAssistantStop, type TurnOutcome } from './stop-reason.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'
import {
  bashCommand,
  bashExitCode,
  bashOutputDelta,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'
import { toolResultImages, toolResultToText, withoutImageData } from './translate/pi-tools.js'

/** What the ACP client negotiated that changes what a session sends. */
export type SessionFeatures = {
  /** The client advertised AIR `asyncTasks`: publish jobs, async runs and agent turns as AIR tasks. */
  asyncTasks: boolean
}

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AgentSideConnection
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  piCommand?: string
  features?: SessionFeatures
}

export type { StopReason }

/** Why pi started a run by itself, as `_meta.piAcp.agentTurn.trigger` reports it. */
export type AgentTurnTrigger = {
  kind: TriggerKind
  reason: string
  customType?: string
  hidden?: boolean
  summary?: string
  toolCallIds?: string[]
}

/**
 * A run pi started with no `session/prompt` in flight (an "agent turn"): an
 * extension woke it, e.g. pi-subagents with a completion notice or pi-bg-jobs
 * with a job's exit.
 */
type AgentTurn = {
  id: string
  /** The ACP turn sequence number it opened. */
  seq: number
  startedAt: number
  trigger?: AgentTurnTrigger
  announced: boolean
  /** Announce once the prompt turn still settling has answered its client. */
  announceDeferred: boolean
  ended: boolean
}

/** How an agent turn ended (`_meta.piAcp.agentTurn.endReason`). */
export type AgentTurnEndReason = 'settled' | 'cancelled' | 'promptJoined' | 'processExited'

/** Activity-only changes of a run card go out at most this often; status changes go out at once. */
const ANCHOR_THROTTLE_MS = 2000
/** Foreground sub-agent progress (`tool_execution_update`) is forwarded at most this often. */
const PARTIAL_THROTTLE_MS = 500
/** A run's `status.json` is read at most this often. */
const STATUS_FILE_MIN_INTERVAL_MS = 2000
const SUBAGENT_WIDGET = 'subagent-async'
const SUBAGENT_WIDGET_PREFIX = 'PI_SUBAGENT_ASYNC_JSON:'
const JOBS_WIDGET = 'bg-jobs'
const JOBS_WIDGET_PREFIX = 'PI_BG_JOBS_JSON:'
const FIRE_AND_FORGET_UI = new Set(['setWidget', 'setStatus', 'setTitle', 'set_editor_text'])
const AUTO_COMPACTION_STARTED = 'Context nearing limit, running automatic compaction...'
const AUTO_COMPACTION_FINISHED = 'Automatic compaction finished; context was summarized to continue the session.'
const COMPACTION_SUMMARY_MAX_CHARS = 8000

/**
 * How `_session/steering` disposed of a message (the wire `outcome`):
 * - `injected`: pushed into the running turn. The owning `session/prompt` stays in
 *   flight until pi has processed it.
 * - `promptRequired`: no turn was running (or it was ending) and the client opted
 *   into `idleBehavior: "promptRequired"`. Nothing was consumed; the client
 *   resubmits the message as a normal `session/prompt`.
 * - `startedNewTurn`: no turn was running and the client did not opt in, so the
 *   message was started as a turn of its own (the protocol default).
 */
export type SteerOutcome = 'injected' | 'promptRequired' | 'startedNewTurn'

type QueuedMessage = { text: string; images: unknown[] }

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function userMessageText(message: unknown): string {
  const content = (message as any)?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
    .map((c: any) => c.text as string)
    .join('')
}

type PendingTurn = {
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type QueuedTurn = {
  message: string
  images: unknown[]
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type PermissionResponse = Awaited<ReturnType<AgentSideConnection['requestPermission']>>

const CONFIRM_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
  { optionId: 'no', name: 'No', kind: 'reject_once' }
]
const EXTENSION_UI_RAW_INPUT_KEYS = ['title', 'message', 'options', 'placeholder', 'prefill'] as const
const CHOICE_OPTION_PREFIX = 'choice-'

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined

  const first = text.indexOf(needle)
  if (first < 0) return undefined

  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined

  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

function getToolPath(args: unknown): string | undefined {
  const record = args as { path?: unknown; file_path?: unknown } | null | undefined
  if (typeof record?.path === 'string') return record.path
  if (typeof record?.file_path === 'string') return record.file_path
  return undefined
}

// Match pi's current edit schema: { path, edits: [{ oldText, newText }] }, with
// legacy top-level oldText/newText still accepted. Pi also normalizes stringified edits.
// https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts
function getParsedEdits(args: unknown): Array<{ oldText: string; newText: string }> {
  const record = args as { oldText?: unknown; newText?: unknown; edits?: unknown } | null | undefined
  const parsed: Array<{ oldText: string; newText: string }> = []

  if (typeof record?.oldText === 'string' && typeof record?.newText === 'string') {
    parsed.push({ oldText: record.oldText, newText: record.newText })
  }

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const item = edit as { oldText?: unknown; newText?: unknown } | null | undefined
      if (typeof item?.oldText === 'string' && typeof item?.newText === 'string') {
        parsed.push({ oldText: item.oldText, newText: item.newText })
      }
    }
  }

  return parsed
}

function getEditOldTexts(args: unknown): string[] {
  const record = args as { oldText?: unknown; edits?: unknown } | null | undefined
  const oldTexts = getParsedEdits(args).map(edit => edit.oldText)

  if (typeof record?.oldText === 'string' && !oldTexts.includes(record.oldText)) oldTexts.push(record.oldText)

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const oldText = (edit as { oldText?: unknown } | null | undefined)?.oldText
      if (typeof oldText === 'string' && !oldTexts.includes(oldText)) oldTexts.push(oldText)
    }
  }

  return oldTexts
}

function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const path = getToolPath(args)
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

export class SessionManager {
  private sessions = new Map<string, PiAcpSession>()
  private readonly store = new SessionStore()

  /** Dispose all sessions and their underlying pi subprocesses. */
  disposeAll(): void {
    for (const [id] of this.sessions) this.close(id)
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    try {
      s.proc.dispose?.()
    } catch {
      // ignore
    }
    s.dispose()
    this.sessions.delete(sessionId)
  }

  /** Close all sessions except the one with `keepSessionId`. */
  closeAllExcept(keepSessionId: string): void {
    for (const [id] of this.sessions) {
      if (id === keepSessionId) continue
      this.close(id)
    }
  }

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand
      })
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      throw e
    }

    let state: any = null
    try {
      state = (await proc.getState()) as any
    } catch {
      state = null
    }

    const sessionId = typeof state?.sessionId === 'string' ? state.sessionId : crypto.randomUUID()
    const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null

    if (sessionFile) {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile })
    }

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      features: params.features
    })

    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): PiAcpSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    return s
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(sessionId: string, params: SessionCreateParams & { proc: PiRpcProcess }): PiAcpSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      features: params.features
    })

    this.sessions.set(sessionId, session)
    return session
  }
}

export class PiAcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]

  private startupInfo: string | null = null
  private startupInfoSent = false

  proc: PiRpcProcess
  private readonly conn: AgentSideConnection
  private readonly fileCommands: FileSlashCommand[]

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null
  private readonly turnQueue: QueuedTurn[] = []
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, 'pending' | 'in_progress'>()

  // pi can emit multiple `turn_end` and `agent_end` events for a single user prompt
  // when retry, compaction, or queued continuations run. The session-level prompt
  // completes only when `agent_settled` is emitted.
  private inAgentLoop = false

  // How the current turn's latest assistant message stopped. Retries, overflow
  // recovery and steered continuations each add a newer one, so the value at
  // `agent_settled` is the run's final outcome.
  private lastAssistantStop: PiAssistantStop | null = null

  // Steering (`_session/steering`). pi's own steering and follow-up queues, as of
  // its last `queue_update`: a steered message leaves the queue when the agent loop
  // turns it into a user message. Anything still queued when pi settles was parked
  // by the turn-end race and is handled in `settleTurn()`.
  private piSteeringQueue: string[] = []
  private piFollowUpQueue: string[] = []
  // Images of the messages we steered, keyed by the text pi reports in its queue.
  // `clear_queue` only returns text, so re-sending a parked message needs them.
  private steeredImages = new Map<string, unknown[][]>()
  // `steer` requests sent to pi that it has not acknowledged yet.
  private readonly inflightSteers = new Set<Promise<void>>()
  // Set from pi's `agent_settled` until the ACP turn is either resolved or
  // continued. New steering is refused in that window.
  private settling = false

  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
  // events may need to be implemented in pi in the future.
  private fileSnapshots = new Map<string, { path: string; oldText: string | null }>()
  private fileMutationToolCallIds = new Set<string>()
  private bashToolCallIds = new Set<string>()
  private bashOutputSnapshots = new Map<string, string>()

  // ── Turns pi starts by itself, and prompts that meet them ───────────────
  // A pi run (agent_start .. agent_settled) is underway.
  private runActive = false
  // A prompt (or a parked-steer continuation) was sent that will start its own
  // run: the next agent_start belongs to the pending turn even while it settles.
  private expectingOwnRun = false
  // The pending turn's run has started (an extension command that pi handled
  // without starting one ends the turn on its `handled` response).
  private turnSawAgentStart = false
  private agentTurn: AgentTurn | null = null
  // A parked steer is being continued as part of the agent turn.
  private agentContinuing = false
  // Who owns the run underway: the client's pending prompt, or an agent turn.
  private runOwner: 'prompt' | 'agent' | null = null
  // Updates of a run pi started while the client's prompt was still settling,
  // held until that prompt has its answer (they are not part of it).
  private deferredUpdates: SessionUpdate[] | null = null
  // A prompt sent into a running agent turn, until pi says what it did with it.
  private joining: QueuedTurn | null = null
  // The agent turn the pending prompt took over (it settles as that prompt's turn).
  private joinedAgentTurn: AgentTurn | null = null
  // Every prompt turn and agent turn opens a new sequence number; a tool call
  // belongs to the turn it started in.
  private turnSeq = 0
  // User messages the client sent (prompts, steers) that pi has not echoed yet;
  // any other user message is one an extension sent.
  private readonly clientTexts = new Map<string, number>()
  private clientMessagesOutstanding = 0
  // An extension command (`/name ...`) is being handled: its notices are its reply.
  private commandWindow: { command: string } | null = null

  // ── Live sub-agent runs and background jobs ─────────────────────────────
  private readonly subagents: SubagentTracker
  private readonly jobs = new BgJobTracker()
  private readonly air: AirTasks
  private readonly anchorEmits = new Map<
    string,
    { json?: string; sig?: string; at: number; timer?: ReturnType<typeof setTimeout> }
  >()
  private readonly partialUpdates = new Map<
    string,
    { at: number; timer?: ReturnType<typeof setTimeout>; partial?: unknown }
  >()
  private readonly statusReads = new Map<string, number>()
  // Per run: which children (and states) lacked a session file at the last read.
  private readonly statusReadKeys = new Map<string, string>()
  private compaction: { id: string; reason?: string; startedAt: number } | null = null
  private compactionSeq = 0
  private extensionCommands: { names: Set<string>; at: number } | null = null
  private disposed = false

  /**
   * Point this session at a different pi subprocess. Used by session/fork:
   * the live subprocess (which pi already switched onto the forked branch)
   * is handed to the new session id, and the original session gets a fresh
   * subprocess bound to its own session file.
   */
  swapProc(proc: PiRpcProcess): void {
    this.proc = proc
  }

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve()

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AgentSideConnection
    fileCommands?: FileSlashCommand[]
    features?: SessionFeatures
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    this.fileCommands = opts.fileCommands ?? []
    this.subagents = new SubagentTracker({ sessionIdOf: sessionHeaderId })
    this.air = new AirTasks(Boolean(opts.features?.asyncTasks), update => this.emit(update as unknown as SessionUpdate))

    this.proc.onEvent(ev => this.handlePiEvent(ev))
    // Test doubles may not implement onExit.
    ;(this.proc as { onExit?: PiRpcProcess['onExit'] }).onExit?.(info => this.onProcessExit(info))
  }

  /** Stop timers. The pi process is the manager's to end. */
  dispose(): void {
    this.disposed = true
    for (const state of this.anchorEmits.values()) if (state.timer) clearTimeout(state.timer)
    for (const state of this.partialUpdates.values()) if (state.timer) clearTimeout(state.timer)
    this.air.dispose()
  }

  setStartupInfo(text: string) {
    this.startupInfo = text
    this.startupInfoSent = false
  }

  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending(): void {
    if (this.startupInfoSent || !this.startupInfo) return
    this.startupInfoSent = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  async prompt(message: string, images: unknown[] = []): Promise<StopReason> {
    // pi RPC mode disables slash command expansion, so we do it here.
    const expandedMessage = expandSlashCommand(message, this.fileCommands)

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: QueuedTurn = { message: expandedMessage, images, resolve, reject }

      // If a turn is already running, enqueue.
      if (this.pendingTurn || this.joining) {
        this.turnQueue.push(queued)

        // Best-effort: notify client that a prompt was queued.
        // This doesn't work in Zed yet, needs to be revisited
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Queued message (position ${this.turnQueue.length}).`
          }
        })

        // Also publish queue depth via session info metadata.
        // This also not visible in the client
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
        })

        return
      }

      // pi is running a turn it started by itself: the prompt joins that run
      // (pi rejects a plain prompt while it streams) and owns it from then on.
      if (this.agentTurnOpen()) {
        this.joinAgentTurn(queued)
        return
      }

      // No turn is running; start immediately.
      this.startTurn(queued)
    })

    return turnPromise
  }

  /**
   * Steer the running turn (`_session/steering`): queue the message in pi, which
   * delivers it after the current assistant turn's tool calls, before the next LLM
   * call. The turn's `session/prompt` resolves only once pi settles, so it stays in
   * flight across the steered work.
   */
  async steer(message: string, images: unknown[] = [], opts: { promptRequired?: boolean } = {}): Promise<SteerOutcome> {
    if (!this.canSteer()) {
      if (opts.promptRequired) return 'promptRequired'
      void this.prompt(message, images).catch(() => {})
      return 'startedNewTurn'
    }

    const text = expandSlashCommand(message, this.fileCommands)
    this.rememberSteeredImages(text, images)
    this.noteClientMessage(text)
    const sent = this.proc.steer(text, images)
    const tracked = sent.then(
      () => undefined,
      () => undefined
    )
    this.inflightSteers.add(tracked)
    try {
      await sent
    } catch (err) {
      // pi refused the message before queueing it (it rejects extension commands,
      // which only run through `prompt`), so nothing was consumed.
      this.takeSteeredImages(text)
      this.forgetClientMessage(text)
      if (opts.promptRequired) return 'promptRequired'
      throw err
    } finally {
      this.inflightSteers.delete(tracked)
    }
    return 'injected'
  }

  /** A turn is running that a steer can join: the client's own, or one pi started by itself. */
  private canSteer(): boolean {
    const running = this.pendingTurn !== null || this.joining !== null || this.agentTurnOpen()
    return running && !this.settling && !this.cancelRequested
  }

  private agentTurnOpen(): boolean {
    return this.agentTurn !== null && !this.agentTurn.ended
  }

  // ── Client messages vs. messages extensions send ────────────────────────

  private noteClientMessage(text: string): void {
    this.clientTexts.set(text, (this.clientTexts.get(text) ?? 0) + 1)
    this.clientMessagesOutstanding += 1
  }

  private forgetClientMessage(text: string): void {
    const n = this.clientTexts.get(text)
    if (!n) return
    if (n <= 1) this.clientTexts.delete(text)
    else this.clientTexts.set(text, n - 1)
    this.clientMessagesOutstanding = Math.max(0, this.clientMessagesOutstanding - 1)
  }

  /**
   * Whether a user message pi just recorded is one the client sent. pi may have
   * rewritten it (skill commands and prompt templates expand inside pi), so a
   * message that matches no text still counts as the client's while one of its
   * messages is outstanding.
   */
  private takeClientMessage(text: string): boolean {
    if (this.clientTexts.has(text)) {
      this.forgetClientMessage(text)
      return true
    }
    if (this.clientMessagesOutstanding > 0) {
      const oldest = this.clientTexts.keys().next().value
      if (oldest !== undefined) this.forgetClientMessage(oldest)
      else this.clientMessagesOutstanding -= 1
      return true
    }
    return false
  }

  private clearClientMessages(): void {
    this.clientTexts.clear()
    this.clientMessagesOutstanding = 0
  }

  private rememberSteeredImages(text: string, images: unknown[]): void {
    const list = this.steeredImages.get(text) ?? []
    list.push(images)
    this.steeredImages.set(text, list)
  }

  private takeSteeredImages(text: string): unknown[] {
    const list = this.steeredImages.get(text)
    if (!list || list.length === 0) return []
    const images = list.shift() ?? []
    if (list.length === 0) this.steeredImages.delete(text)
    return images
  }

  private async waitForInflightSteers(): Promise<void> {
    while (this.inflightSteers.size > 0) {
      await Promise.all([...this.inflightSteers])
    }
  }

  private hasQueuedPiMessages(): boolean {
    return this.piSteeringQueue.length > 0 || this.piFollowUpQueue.length > 0
  }

  /**
   * Pull every message out of pi's queues so it cannot surface in a later turn.
   * Returns them in delivery order (steering first), with the images we sent.
   */
  private async takeQueuedPiMessages(): Promise<QueuedMessage[]> {
    let cleared: { steering: string[]; followUp: string[] }
    try {
      cleared = await this.proc.clearQueue()
    } catch {
      return []
    }
    return [...cleared.steering, ...cleared.followUp].map(text => ({ text, images: this.takeSteeredImages(text) }))
  }

  /**
   * pi settled while steered messages were still queued: the steer reached pi after
   * its agent loop had made its last check for queued messages, so pi would park
   * them until some later prompt. Run them now instead, as part of the same ACP
   * turn (the `session/prompt` whose client was told `injected` keeps owning it).
   * That is what pi itself does when a message lands a moment earlier.
   */
  private async continueTurnWith(messages: QueuedMessage[], opts: { agentTurn?: boolean } = {}): Promise<boolean> {
    const [first, ...rest] = messages
    if (!first) return false
    if (opts.agentTurn) this.agentContinuing = true
    else this.expectingOwnRun = true
    try {
      const disposition = await this.proc.prompt(first.text, first.images, { streamingBehavior: 'steer' })
      if (disposition === 'queued') {
        // pi was already running again (a run it started by itself): the
        // message joined that run, which is now this turn's.
        this.agentContinuing = false
        this.expectingOwnRun = false
        const agentTurn = this.agentTurn
        if (!opts.agentTurn && this.pendingTurn && agentTurn && !agentTurn.ended) {
          this.joinedAgentTurn = agentTurn
          this.endAgentTurn(agentTurn, 'promptJoined', { stopReason: 'end_turn' })
          this.releaseDeferred()
          this.turnSawAgentStart = true
          if (this.runActive) this.runOwner = 'prompt'
        }
      }
    } catch {
      this.expectingOwnRun = false
      this.agentContinuing = false
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `Could not deliver the steered message${messages.length > 1 ? 's' : ''}:\n\n${messages
            .map(m => m.text)
            .join('\n\n')}`
        }
      })
      return false
    }
    for (const m of rest) {
      this.rememberSteeredImages(m.text, m.images)
      const sent = this.proc.steer(m.text, m.images).catch(() => {
        this.takeSteeredImages(m.text)
      })
      this.inflightSteers.add(sent)
      void sent.finally(() => this.inflightSteers.delete(sent))
    }
    return true
  }

  /**
   * pi settled the pending prompt's run. `stop` is how that run's last
   * assistant message ended, read when `agent_settled` arrived (pi may already
   * be starting a run of its own while this settles).
   */
  private async settleTurn(stop: PiAssistantStop | null): Promise<void> {
    try {
      // A steer that was on its way when pi settled lands in pi's queue after the
      // fact; wait until pi has acknowledged every one so the queue mirror is final.
      await this.waitForInflightSteers()

      if (this.pendingTurn && this.hasQueuedPiMessages()) {
        const parked = await this.takeQueuedPiMessages()
        if (parked.length > 0 && !this.cancelRequested) {
          // Keep the ACP turn open; pi's next `agent_settled` settles it.
          if (await this.continueTurnWith(parked)) return
        }
      }

      // Ensure all updates derived from pi events are delivered before we resolve
      // the ACP `session/prompt` request.
      await this.flushEmits()
      this.finishPendingTurn(turnOutcome(stop, this.cancelRequested))
    } finally {
      this.settling = false
    }

    this.startNextQueued()
  }

  /** Answer the pending `session/prompt` and close its turn. */
  private finishPendingTurn(outcome: TurnOutcome): void {
    const turn = this.pendingTurn
    this.pendingTurn = null
    this.joinedAgentTurn = null
    this.inAgentLoop = false
    this.expectingOwnRun = false
    this.turnSawAgentStart = false
    this.steeredImages.clear()
    this.clearClientMessages()
    if ('error' in outcome) turn?.reject(outcome.error)
    else turn?.resolve(outcome.stopReason)
    this.scheduleDeferredRelease()
  }

  /**
   * A run pi started while the client's prompt settled is announced, and its
   * held updates sent, once the client has the prompt's answer, so none of it
   * reads as part of that prompt.
   */
  private scheduleDeferredRelease(): void {
    if (!this.deferredUpdates && !this.agentTurn?.announceDeferred) return
    setTimeout(() => this.releaseDeferred(), 0)
  }

  private releaseDeferred(): void {
    const held = this.deferredUpdates
    this.deferredUpdates = null
    const agentTurn = this.agentTurn
    if (agentTurn?.announceDeferred && !agentTurn.announced && !agentTurn.ended && !this.pendingTurn) {
      this.announceAgentTurn(agentTurn, agentTurn.trigger ?? unknownTrigger())
    }
    for (const update of held ?? []) this.emitNow(update)
  }

  /** Start the next queued prompt, or report the session idle. */
  private startNextQueued(): void {
    const next = this.turnQueue.shift()
    if (next) {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `Starting queued message. (${this.turnQueue.length} remaining)` }
      })
      if (this.agentTurnOpen()) this.joinAgentTurn(next)
      else this.startTurn(next)
    } else if (!this.agentTurnOpen()) {
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: false } }
      })
    }
  }

  async cancel(): Promise<void> {
    // Cancel current and clear any queued prompts.
    this.cancelRequested = true

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      for (const t of queued) t.resolve('cancelled')

      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Cleared queued prompts.' }
      })
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      })
    }

    // Steered messages still waiting in pi's queue would be picked up by pi's
    // post-abort continuation and run after the user stopped the turn.
    const running = this.pendingTurn !== null || this.agentTurnOpen()
    if (running && (this.inflightSteers.size > 0 || this.hasQueuedPiMessages())) {
      await this.waitForInflightSteers()
      await this.takeQueuedPiMessages()
    }

    // Abort the currently running turn (if any). If nothing is running, this is a no-op.
    // A run pi started by itself stops the same way; its agent turn ends `cancelled`.
    await this.proc.abort()
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested
  }

  private emit(update: SessionUpdate): void {
    if (this.deferredUpdates) {
      this.deferredUpdates.push(update)
      return
    }
    this.emitNow(update)
  }

  private emitNow(update: SessionUpdate): void {
    // Serialize update delivery.
    this.lastEmit = this.lastEmit
      .then(() =>
        this.conn.sessionUpdate({
          sessionId: this.sessionId,
          update
        })
      )
      .catch(() => {
        // Ignore notification errors (client may have gone away). We still want
        // prompt completion.
      })
  }

  private async flushEmits(): Promise<void> {
    await this.lastEmit
  }

  private emitBashToolCall(params: {
    sessionUpdate: 'tool_call' | 'tool_call_update'
    toolCallId: string
    toolName: string
    args: unknown
    status: 'pending' | 'in_progress'
    locations?: ToolCallLocation[]
    includeTerminal: boolean
  }): void {
    this.bashToolCallIds.add(params.toolCallId)
    this.emit({
      sessionUpdate: params.sessionUpdate,
      toolCallId: params.toolCallId,
      title: bashCommand(params.args) ?? params.toolName,
      kind: 'execute',
      status: params.status,
      locations: params.locations,
      ...(params.includeTerminal ? { content: bashTerminalContent(params.toolCallId) } : {}),
      ...(params.includeTerminal ? { _meta: bashTerminalInfoMeta(params.toolCallId, this.cwd) } : {})
    })
  }

  private emitBashOutputUpdate(params: {
    toolCallId: string
    status: 'in_progress' | 'completed' | 'failed'
    result: unknown
    isError?: boolean
  }): void {
    const text = bashResultText(params.result)
    const previous = this.bashOutputSnapshots.get(params.toolCallId) ?? ''
    const delta = bashOutputDelta(previous, text)
    this.bashOutputSnapshots.set(params.toolCallId, text)

    this.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: params.toolCallId,
      status: params.status,
      _meta: {
        ...(delta ? bashTerminalOutputMeta(params.toolCallId, delta) : {}),
        ...(params.status === 'completed' || params.status === 'failed'
          ? bashTerminalExitMeta(params.toolCallId, bashExitCode(params.result, Boolean(params.isError)))
          : {})
      }
    })
  }

  private cleanupToolCall(toolCallId: string): void {
    this.currentToolCalls.delete(toolCallId)
    this.fileSnapshots.delete(toolCallId)
    this.fileMutationToolCallIds.delete(toolCallId)
    this.bashToolCallIds.delete(toolCallId)
    this.bashOutputSnapshots.delete(toolCallId)
  }

  /** Open a turn for the client's prompt (its `session/prompt` resolves when pi settles). */
  private beginPromptTurn(t: QueuedTurn): void {
    this.pendingTurn = { resolve: t.resolve, reject: t.reject }
    this.turnSeq += 1
    this.lastAssistantStop = null
    this.turnSawAgentStart = false
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.inAgentLoop = false

    this.beginPromptTurn(t)
    const owner = this.pendingTurn
    this.noteClientMessage(t.message)
    this.expectingOwnRun = true
    const command = extensionCommandName(t.message)
    if (command) this.commandWindow = { command }

    // Publish queue depth (0 because we're starting the turn now).
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    })

    // Kick off pi, but completion is determined by pi events, not the RPC response.
    // The prompt RPC only acknowledges acceptance; retry, compaction, or queued
    // continuations may emit multiple `agent_end` events before `agent_settled`.
    // `steer`: if pi started a run by itself a moment ago, the prompt joins it
    // instead of being refused (pi ignores the option while idle).
    this.proc.prompt(t.message, t.images, { streamingBehavior: 'steer' }).then(
      disposition => {
        if (command) this.commandWindow = null
        this.onPromptDisposition(owner, t, disposition)
      },
      err => {
        if (command) this.commandWindow = null
        this.expectingOwnRun = false
        // If the subprocess errors before we get `agent_settled`, treat as error unless cancelled.
        // Also ensure we flush any already-enqueued updates first.
        void (async () => {
          // A steer accepted before pi refused the prompt is parked in pi's queue
          // with no run to deliver it; do not let it leak into the next turn.
          await this.waitForInflightSteers()
          if (this.hasQueuedPiMessages()) await this.takeQueuedPiMessages()
          this.steeredImages.clear()
          await this.flushEmits()
        })().finally(() => {
          if (this.pendingTurn !== owner) return
          // If this looks like an auth/config issue, surface AUTH_REQUIRED so clients can offer terminal login.
          const authErr = maybeAuthRequiredError(err)
          if (authErr) {
            this.pendingTurn?.reject(authErr)
          } else if (this.cancelRequested) {
            this.pendingTurn?.resolve('cancelled')
          } else {
            // pi refused the prompt or exited before taking it: tell the client why.
            this.pendingTurn?.reject(piStopError(String((err as any)?.message ?? err)))
          }

          this.pendingTurn = null
          this.inAgentLoop = false
          this.clearClientMessages()
          this.scheduleDeferredRelease()

          // If the prompt failed, do not automatically proceed—pi may be unhealthy.
          // But we still clear the queueDepth metadata.
          this.emit({
            sessionUpdate: 'session_info_update',
            _meta: { piAcp: { queueDepth: this.turnQueue.length, running: false } }
          })
        })
        void err
      }
    )
  }

  /**
   * pi answered the prompt that opened `owner`. An extension command (or an input
   * handler) that pi `handled` without starting a run ends the turn here: no
   * `agent_settled` will come for it.
   */
  private onPromptDisposition(
    owner: PendingTurn | null,
    t: QueuedTurn,
    disposition: PromptDisposition | undefined
  ): void {
    if (disposition !== 'handled') return
    this.forgetClientMessage(t.message)
    if (this.pendingTurn !== owner || this.turnSawAgentStart || this.runActive || this.settling) return
    this.expectingOwnRun = false
    this.settling = true
    void (async () => {
      try {
        await this.flushEmits()
        if (this.pendingTurn === owner) {
          this.finishPendingTurn({ stopReason: this.cancelRequested ? 'cancelled' : 'end_turn' })
        }
      } finally {
        this.settling = false
      }
      this.startNextQueued()
    })()
  }

  /**
   * The client prompted while pi runs a turn it started by itself. pi refuses a
   * plain prompt while it streams, so the message is steered into the run, and
   * the prompt owns the run from then on (its `session/prompt` resolves when pi
   * settles). An extension command runs at once and ends the prompt on its own.
   */
  private joinAgentTurn(t: QueuedTurn): void {
    this.joining = t
    this.cancelRequested = false
    this.noteClientMessage(t.message)
    this.rememberSteeredImages(t.message, t.images)
    const command = extensionCommandName(t.message)
    if (command) this.commandWindow = { command }
    const handled = this.proc.prompt(t.message, t.images, { streamingBehavior: 'steer' }).then(
      disposition => {
        if (command) this.commandWindow = null
        this.onJoinDisposition(t, disposition)
      },
      err => {
        if (command) this.commandWindow = null
        this.joining = null
        this.takeSteeredImages(t.message)
        this.forgetClientMessage(t.message)
        t.reject(maybeAuthRequiredError(err) ?? piStopError(String((err as Error)?.message ?? err)))
        this.startNextQueued()
      }
    )
    // A settle of the agent turn waits for this, so it knows who owns the run.
    this.inflightSteers.add(handled)
    void handled.finally(() => this.inflightSteers.delete(handled))
  }

  private onJoinDisposition(t: QueuedTurn, disposition: PromptDisposition | undefined): void {
    this.joining = null
    if (disposition === 'handled') {
      // An extension command: it ran beside the agent's turn, which goes on.
      this.takeSteeredImages(t.message)
      this.forgetClientMessage(t.message)
      t.resolve(this.cancelRequested ? 'cancelled' : 'end_turn')
      this.startNextQueued()
      return
    }
    if (disposition === 'queued') {
      // The message is in pi's steering queue: the run is the prompt's now.
      const agentTurn = this.agentTurn
      this.beginPromptTurn(t)
      this.turnSawAgentStart = true
      if (this.runActive) this.runOwner = 'prompt'
      if (agentTurn && !agentTurn.ended) {
        this.joinedAgentTurn = agentTurn
        this.endAgentTurn(agentTurn, 'promptJoined', { stopReason: 'end_turn' })
      }
      this.releaseDeferred()
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
      })
      if (!this.runActive && !this.settling) {
        // pi had settled already, and parked the message: run it now.
        this.settling = true
        void this.settleTurn(this.lastAssistantStop)
      }
      return
    }
    // `started` (or an older pi): pi was idle by the time it read the prompt, so
    // the prompt runs on its own. The agent turn (if any) settles by itself.
    this.takeSteeredImages(t.message)
    this.beginPromptTurn(t)
    this.expectingOwnRun = !this.runActive
    if (this.runActive) this.turnSawAgentStart = true
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    })
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = String((ev as any).type ?? '')

    switch (type) {
      case 'message_update': {
        const ame = (ev as any).assistantMessageEvent

        // Stream assistant text.
        if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        // Surface tool calls ASAP so clients (e.g. Zed) can show a tool-in-use/loading UI
        // while the model is still streaming tool call args.
        if (ame?.type === 'toolcall_start' || ame?.type === 'toolcall_delta' || ame?.type === 'toolcall_end') {
          const toolCall =
            // pi sometimes includes the tool call directly on the event
            (ame as any)?.toolCall ??
            // ...and always includes it in the partial assistant message at contentIndex
            (ame as any)?.partial?.content?.[(ame as any)?.contentIndex ?? 0]

          const toolCallId = String((toolCall as any)?.id ?? '')
          const toolName = String((toolCall as any)?.name ?? 'tool')

          if (toolCallId) {
            const rawInput =
              (toolCall as any)?.arguments && typeof (toolCall as any).arguments === 'object'
                ? (toolCall as any).arguments
                : (() => {
                    const s = String((toolCall as any)?.partialArgs ?? '')
                    if (!s) return undefined
                    try {
                      return JSON.parse(s)
                    } catch {
                      return { partialArgs: s }
                    }
                  })()

            const locations = toToolCallLocations(rawInput, this.cwd)
            const existingStatus = this.currentToolCalls.get(toolCallId)
            // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
            const status = existingStatus ?? 'pending'
            // Sub-agent and job tools carry `_meta.piAcp` from the moment their
            // arguments are complete, so the client can draw the right card at once.
            const argsComplete = isRecord((toolCall as any)?.arguments)
            const live = argsComplete
              ? this.liveToolStart(toolCallId, toolName, rawInput)
              : this.liveToolMeta(toolCallId)

            if (isBashTool(toolName)) {
              if (!existingStatus) this.currentToolCalls.set(toolCallId, 'pending')
              this.emitBashToolCall({
                sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
                toolCallId,
                toolName,
                args: rawInput,
                status,
                locations,
                includeTerminal: !existingStatus
              })
            } else if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, 'pending')
              this.emit({
                sessionUpdate: 'tool_call',
                toolCallId,
                title: toolName,
                kind: toToolKind(toolName),
                status,
                locations,
                rawInput,
                ...this.liveMetaField(toolCallId, live)
              })
            } else {
              // Best-effort: keep rawInput updated while args are streaming.
              // Keep the existing status (pending or in_progress).
              this.emit({
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status,
                locations,
                rawInput,
                ...this.liveMetaField(toolCallId, live)
              })
            }
          }

          break
        }

        // Ignore other delta/event types for now.
        break
      }

      case 'tool_execution_start': {
        const toolCallId = String((ev as any).toolCallId ?? crypto.randomUUID())
        const toolName = String((ev as any).toolName ?? 'tool')
        const args = (ev as any).args
        let line: number | undefined

        if (isBashTool(toolName)) {
          const locations = toToolCallLocations(args, this.cwd)
          const existingStatus = this.currentToolCalls.get(toolCallId)
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emitBashToolCall({
            sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
            toolCallId,
            toolName,
            args,
            status: 'in_progress',
            locations,
            includeTerminal: !existingStatus
          })
          break
        }

        // Capture pre-mutation file contents so we can emit a structured ACP diff.
        const isFileMutation = toolName === 'edit' || toolName === 'write'
        let snapshotOldText: string | null | undefined
        if (isFileMutation) {
          this.fileMutationToolCallIds.add(toolCallId)
          const p = getToolPath(args)
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              snapshotOldText = readFileSync(abs, 'utf8')
              this.fileSnapshots.set(toolCallId, { path: p, oldText: snapshotOldText })

              if (toolName === 'edit') {
                for (const needle of getEditOldTexts(args)) {
                  line = findUniqueLineNumber(snapshotOldText, needle)
                  if (typeof line === 'number') break
                }
              }
            } catch {
              snapshotOldText = null
              this.fileSnapshots.set(toolCallId, { path: p, oldText: null })
            }
          }
        }

        const locations = toToolCallLocations(args, this.cwd, line)
        const live = this.liveToolStart(toolCallId, toolName, args)

        // If we already surfaced the tool call while the model streamed it, just transition.
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolName,
            kind: toToolKind(toolName),
            status: 'in_progress',
            locations,
            rawInput: args,
            ...this.liveMetaField(toolCallId, live)
          })
        } else {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'in_progress',
            locations,
            rawInput: args,
            ...this.liveMetaField(toolCallId, live)
          })
        }

        break
      }

      case 'tool_execution_update': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const partial = (ev as any).partialResult
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({ toolCallId, status: 'in_progress', result: partial })
          break
        }

        if (this.subagents.isAnchor(toolCallId)) {
          // A foreground run streams its children's progress; forward it at a
          // sane rate, with the run card.
          this.subagents.onToolUpdate(toolCallId, partial)
          this.forwardPartialThrottled(toolCallId, partial)
          break
        }

        this.emitToolPartial(toolCallId, partial)
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({
            toolCallId,
            status: isError ? 'failed' : 'completed',
            result,
            isError
          })
          this.cleanupToolCall(toolCallId)
          break
        }

        const text = toolResultToText(result)

        const snapshot = this.fileSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined
        let hasStructuredDiff = false

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
            const newText = readFileSync(abs, 'utf8')
            if (snapshot.oldText === null || newText !== snapshot.oldText) {
              hasStructuredDiff = true
              content = [
                {
                  type: 'diff',
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                }
              ]
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        if (!content && !hasStructuredDiff && text) {
          content = [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]
        }

        // Pictures a tool returned (e.g. `read` of an image) go as image
        // content, so the client can show them while the turn runs.
        const images = toolResultImages(result)
        if (images.length) content = [...(content ?? []), ...images]

        const changedAnchors = this.liveToolEnd(
          toolCallId,
          String((ev as any).toolName ?? ''),
          result,
          isError,
          num((ev as any).durationMs)
        )

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          content,
          ...(hasStructuredDiff ? {} : { rawOutput: withoutImageData(result) }),
          ...this.liveMetaField(toolCallId, this.liveToolMeta(toolCallId))
        })
        this.syncAir(toolCallId)
        for (const anchor of changedAnchors) if (anchor !== toolCallId) this.emitAnchor(anchor, { urgent: true })

        this.cleanupToolCall(toolCallId)
        break
      }

      case 'extension_ui_request': {
        void this.handleExtensionUiRequest(ev).catch(() => {
          const id = stringProp(ev, 'id')
          if (!id) {
            return
          }

          void this.proc.sendExtensionUiResponse({ id, cancelled: true }).catch(() => {})
        })
        break
      }

      case 'auto_retry_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatAutoRetryMessage(ev) } satisfies ContentBlock
        })
        break
      }

      case 'auto_retry_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Retry finished, resuming.' } satisfies ContentBlock
        })
        break
      }

      case 'compaction_start':
      case 'auto_compaction_start': {
        // pi 0.85+ (and 1.x) send `compaction_*`; `auto_compaction_*` is the older name.
        this.onCompactionStart(ev, type === 'auto_compaction_start')
        break
      }

      case 'compaction_end':
      case 'auto_compaction_end': {
        this.onCompactionEnd(ev, type === 'auto_compaction_end')
        break
      }

      case 'agent_start': {
        this.inAgentLoop = true
        if (this.runActive) break // a retry or continuation inside the same run
        this.runActive = true
        if (this.pendingTurn && (!this.settling || this.expectingOwnRun)) {
          this.runOwner = 'prompt'
          this.turnSawAgentStart = true
          this.expectingOwnRun = false
          break
        }
        if (this.agentTurnOpen() && this.agentContinuing) {
          this.runOwner = 'agent'
          this.agentContinuing = false
          break
        }
        // No prompt of the client's started this run: pi started it by itself.
        this.openAgentTurn()
        this.runOwner = 'agent'
        break
      }

      case 'turn_end': {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here; wait for `agent_settled`.
        break
      }

      case 'agent_end': {
        // One low-level run ended. Pi may still retry, compact, or process a queued
        // continuation, so keep the ACP turn open until `agent_settled`.
        this.inAgentLoop = false
        break
      }

      case 'agent_settled': {
        this.inAgentLoop = false
        this.runActive = false
        const owner = this.runOwner
        this.runOwner = null
        const stop = this.lastAssistantStop
        const aborted = (ev as any).aborted === true
        const agentTurn = this.agentTurn
        if (agentTurn && !agentTurn.ended && (owner === 'agent' || !this.pendingTurn)) {
          this.settling = true
          void this.settleAgentTurn(agentTurn, stop, aborted)
        } else if (this.pendingTurn) {
          this.settling = true
          void this.settleTurn(stop)
        }
        // Otherwise a prompt to join the run was on its way: its answer
        // decides (onJoinDisposition).
        break
      }

      case 'queue_update': {
        this.piSteeringQueue = stringList((ev as any).steering)
        this.piFollowUpQueue = stringList((ev as any).followUp)
        break
      }

      case 'message_start': {
        const msg = (ev as any).message
        // pi turned a queued message into a user message: it is consumed.
        if (msg?.role === 'user') this.takeSteeredImages(userMessageText(msg))
        // The first message of a run pi started by itself says why it started.
        const agentTurn = this.agentTurn
        if (agentTurn && !agentTurn.announced && !agentTurn.announceDeferred && !agentTurn.ended) {
          if (isRecord(msg) && msg.role !== 'system') this.announceAgentTurn(agentTurn, this.triggerOf(msg))
        }
        break
      }

      case 'message_end': {
        const msg = (ev as any).message
        const stop = assistantStopOf(msg)
        if (stop && (this.pendingTurn || this.agentTurnOpen())) this.lastAssistantStop = stop
        if (isRecord(msg) && msg.role === 'custom') this.onCustomMessage(msg)
        else if (isRecord(msg) && msg.role === 'user') this.onUserMessage(msg)
        break
      }

      case 'entry_appended': {
        const entry = (ev as any).entry
        if (isRecord(entry) && entry.type === 'custom') this.onCustomEntry(entry)
        break
      }

      default:
        break
    }
  }

  // ── Live channel: tool calls that anchor sub-agent runs and jobs ────────

  /** A sub-agent or job tool call is known (args complete): track it, return its `_meta.piAcp`. */
  private liveToolStart(toolCallId: string, toolName: string, args: unknown): JsonRecord | undefined {
    if (SUBAGENT_TOOLS.has(toolName)) this.subagents.onToolStart(toolCallId, toolName, args, this.turnSeq)
    else if (JOB_TOOLS.has(toolName)) this.jobs.onToolStart(toolCallId, toolName, args, this.turnSeq)
    return this.liveToolMeta(toolCallId)
  }

  /** The whole `_meta.piAcp` of a tracked tool call (every update carries all of it). */
  private liveToolMeta(toolCallId: string): JsonRecord | undefined {
    const marker = this.subagents.markerFor(toolCallId)
    if (marker) return compact({ subagent: marker, subagentRun: this.subagents.snapshot(toolCallId) })
    const job = this.jobs.snapshot(toolCallId)
    if (job) return { backgroundJob: job }
    const control = this.jobs.controlFor(toolCallId)
    if (control) return { backgroundJobControl: control }
    return undefined
  }

  /** `{_meta}` to spread into a tool update; records the run or job state it carries as sent. */
  private liveMetaField(toolCallId: string, live: JsonRecord | undefined): { _meta?: JsonRecord } {
    if (!live) return {}
    const payload = live.subagentRun ?? live.backgroundJob
    if (payload) {
      const state = this.anchorEmits.get(toolCallId) ?? { at: 0 }
      if (state.timer) clearTimeout(state.timer)
      state.timer = undefined
      state.json = JSON.stringify(payload)
      state.sig = anchorSignificance(live)
      state.at = Date.now()
      this.anchorEmits.set(toolCallId, state)
    }
    return { _meta: { piAcp: live } }
  }

  /** A tracked tool call returned. Returns the anchors whose card changed. */
  private liveToolEnd(
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
    durationMs: number | undefined
  ): string[] {
    const partial = this.partialUpdates.get(toolCallId)
    if (partial?.timer) clearTimeout(partial.timer)
    this.partialUpdates.delete(toolCallId)
    if (this.subagents.isAnchor(toolCallId)) {
      this.subagents.onToolEnd(toolCallId, result, isError, durationMs)
      return [toolCallId]
    }
    const name =
      toolName || (this.jobs.isAnchor(toolCallId) ? 'bgj_run' : (this.jobs.controlFor(toolCallId)?.tool ?? ''))
    if (JOB_TOOLS.has(name)) return this.jobs.onToolEnd(toolCallId, name, result, isError)
    return []
  }

  /** A non-bash tool's partial result, as pi-acp has always forwarded it. */
  private emitToolPartial(toolCallId: string, partial: unknown): void {
    const text = this.fileMutationToolCallIds.has(toolCallId) ? '' : toolResultToText(partial)

    this.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'in_progress',
      content: text ? ([{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]) : undefined,
      ...(this.fileMutationToolCallIds.has(toolCallId) ? {} : { rawOutput: partial }),
      ...this.liveMetaField(toolCallId, this.liveToolMeta(toolCallId))
    })
  }

  /** Foreground sub-agent progress: at most one update per PARTIAL_THROTTLE_MS, the latest wins. */
  private forwardPartialThrottled(toolCallId: string, partial: unknown): void {
    const state = this.partialUpdates.get(toolCallId) ?? { at: 0 }
    this.partialUpdates.set(toolCallId, state)
    const now = Date.now()
    const due = state.at + PARTIAL_THROTTLE_MS
    if (!state.timer && now >= due) {
      state.at = now
      state.partial = undefined
      this.emitToolPartial(toolCallId, partial)
      return
    }
    state.partial = partial
    if (state.timer) return
    state.timer = setTimeout(
      () => {
        state.timer = undefined
        const latest = state.partial
        state.partial = undefined
        if (latest === undefined || !this.currentToolCalls.has(toolCallId)) return
        state.at = Date.now()
        this.emitToolPartial(toolCallId, latest)
      },
      Math.max(0, due - now)
    )
    state.timer.unref?.()
  }

  /**
   * Send an anchor's run or job card if it changed. Status changes (and
   * `urgent` ones) go at once; activity-only changes at most every
   * ANCHOR_THROTTLE_MS. While the anchor's own turn runs, the card rides a
   * `tool_call_update` of that call; after it, a `session_info_update` (an
   * update for a call the client no longer holds in a live turn would read as a
   * new tool call).
   */
  private emitAnchor(toolCallId: string, opts: { urgent?: boolean } = {}): void {
    if (this.disposed) return
    const live = this.liveToolMeta(toolCallId)
    const payload = live?.subagentRun ?? live?.backgroundJob
    if (!live || !payload) return
    const json = JSON.stringify(payload)
    const state = this.anchorEmits.get(toolCallId) ?? { at: 0 }
    this.anchorEmits.set(toolCallId, state)
    if (state.json === json) return
    const sig = anchorSignificance(live)
    const now = Date.now()
    const due = state.at + ANCHOR_THROTTLE_MS
    if (opts.urgent || sig !== state.sig || now >= due) {
      if (state.timer) clearTimeout(state.timer)
      state.timer = undefined
      state.json = json
      state.sig = sig
      state.at = now
      if (this.anchorInCurrentTurn(toolCallId)) {
        this.emit({ sessionUpdate: 'tool_call_update', toolCallId, _meta: { piAcp: live } })
      } else {
        const card = live.subagentRun ? { subagentRun: live.subagentRun } : { backgroundJob: live.backgroundJob }
        this.emit({ sessionUpdate: 'session_info_update', _meta: { piAcp: card } })
      }
      this.syncAir(toolCallId)
      return
    }
    if (state.timer) return
    state.timer = setTimeout(() => {
      state.timer = undefined
      this.emitAnchor(toolCallId, { urgent: true })
    }, due - now)
    state.timer.unref?.()
  }

  private anchorInCurrentTurn(toolCallId: string): boolean {
    const seq = this.subagents.turnSeqOf(toolCallId) ?? this.jobs.turnSeqOf(toolCallId)
    if (seq === undefined || seq !== this.turnSeq) return false
    return this.pendingTurn !== null || this.agentTurnOpen()
  }

  /** Mirror an async run or a job into the AIR task list (when the client asked for it). */
  private syncAir(toolCallId: string): void {
    if (!this.air.enabled) return
    const run = this.subagents.snapshot(toolCallId)
    if (run) {
      if (!run.async || !run.runId) return
      const id = run.runId
      if (isTerminalStatus(run.status)) {
        const state = run.status === 'completed' ? 'completed' : run.status === 'failed' ? 'failed' : 'stopped'
        this.air.finish(id, state, run.error ? firstLine(run.error, 200) : undefined)
        return
      }
      if (!this.air.has(id)) {
        this.air.spawn({
          id,
          kind: run.mode === 'workflow' ? 'workflow' : 'subagent',
          name: run.agent,
          description: run.task
            ? firstLine(run.task, 200)
            : run.mode === 'workflow'
              ? 'Workflow run'
              : `${run.agent} sub-agent run`,
          toolCallId
        })
      } else {
        this.air.progress(id, runAirProgress(run))
      }
      return
    }
    const job = this.jobs.snapshot(toolCallId)
    if (!job?.id) return
    if (isTerminalJobState(job.state)) {
      const state = job.state === 'completed' ? 'completed' : job.state === 'killed' ? 'stopped' : 'failed'
      this.air.finish(job.id, state, jobSummary(job))
      return
    }
    if (job.state === 'running' && !this.air.has(job.id)) {
      this.air.spawn({
        id: job.id,
        kind: 'shell',
        name: shortCommand(job.command) ?? job.id,
        description: job.command ?? job.id,
        toolCallId,
        outputFilePath: job.logFile
      })
    }
  }

  /** The RPC status widgets of pi-subagents (`subagent-async`) and pi-bg-jobs (`bg-jobs`). */
  private onWidget(ev: PiRpcEvent): void {
    const key = stringProp(ev, 'widgetKey')
    const lines = (ev as { widgetLines?: unknown }).widgetLines
    if (key === SUBAGENT_WIDGET) {
      // No lines: the widget was cleared, no run is active any more.
      const snapshot = parseWidgetLine(lines, SUBAGENT_WIDGET_PREFIX) ?? { runs: [] }
      const { changed, unknownRunIds, departedRunIds } = this.subagents.onWidget(snapshot)
      for (const anchor of changed) {
        this.emitAnchor(anchor)
        // The widget names no session files; the run's status.json does. Read it
        // when a child without one changes state, not on every tick.
        const run = this.subagents.snapshot(anchor)
        if (!run?.runId) continue
        const missing = run.children.filter(c => c.status !== 'pending' && !c.sessionFile)
        const key = missing.map(c => `${c.key}:${c.status}`).join(',')
        if (missing.length && this.statusReadKeys.get(run.runId) !== key) {
          this.statusReadKeys.set(run.runId, key)
          this.readRunStatus(run.runId, { force: true })
        }
      }
      for (const runId of [...unknownRunIds, ...departedRunIds]) this.readRunStatus(runId)
      return
    }
    if (key === JOBS_WIDGET) {
      const snapshot = parseWidgetLine(lines, JOBS_WIDGET_PREFIX)
      if (!snapshot) return
      for (const anchor of this.jobs.onWidget(snapshot, -1)) this.emitAnchor(anchor, { urgent: true })
    }
  }

  /** Read a run's `status.json` (throttled per run unless `force`) and fold it into its card. */
  private readRunStatus(runId: string, opts: { force?: boolean } = {}): void {
    const now = Date.now()
    if (!opts.force && now - (this.statusReads.get(runId) ?? 0) < STATUS_FILE_MIN_INTERVAL_MS) return
    this.statusReads.set(runId, now)
    const anchor = this.subagents.anchorForRunId(runId)
    const dir = (anchor && this.subagents.asyncDirOf(anchor)) || join(subagentsTempRoot(), 'async-subagent-runs', runId)
    void readFile(join(dir, 'status.json'), 'utf8').then(
      text => {
        if (this.disposed) return
        let status: unknown
        try {
          status = JSON.parse(text)
        } catch {
          return
        }
        const seq = anchor ? (this.subagents.turnSeqOf(anchor) ?? -1) : -1
        const claimed = this.subagents.onStatusFile(runId, status, seq)
        if (claimed) this.emitAnchor(claimed)
      },
      () => {}
    )
  }

  // ── Turns pi starts by itself ───────────────────────────────────────────

  private openAgentTurn(): void {
    const previous = this.agentTurn
    if (previous && !previous.ended) {
      // pi started another run before the last one finished settling: that one is over.
      this.endAgentTurn(previous, 'settled', turnOutcome(this.lastAssistantStop, this.cancelRequested))
    }
    this.cancelRequested = false
    this.lastAssistantStop = null
    this.agentContinuing = false
    this.turnSeq += 1
    // The client's prompt is still settling: hold this run's updates until it is answered.
    if (this.pendingTurn) this.deferredUpdates ??= []
    this.agentTurn = {
      id: `pi-turn-${crypto.randomUUID()}`,
      seq: this.turnSeq,
      startedAt: Date.now(),
      announced: false,
      announceDeferred: false,
      ended: false
    }
  }

  private announceAgentTurn(turn: AgentTurn, trigger: AgentTurnTrigger): void {
    if (turn.announced || turn.ended) return
    turn.trigger = trigger
    if (this.pendingTurn) {
      // The client's prompt is still settling: answer it first (finishPendingTurn).
      turn.announceDeferred = true
      return
    }
    turn.announceDeferred = false
    turn.announced = true
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: {
        piAcp: {
          running: true,
          agentTurn: compact({
            version: LIVE_VERSION,
            id: turn.id,
            state: 'running',
            startedAt: turn.startedAt,
            trigger
          })
        }
      }
    })
    this.air.spawn({
      id: turn.id,
      kind: 'turn',
      name: 'Pi is working',
      description: trigger.summary ? `${trigger.reason}: ${trigger.summary}` : trigger.reason
    })
  }

  private endAgentTurn(turn: AgentTurn, endReason: AgentTurnEndReason, outcome: TurnOutcome): void {
    if (turn.ended) return
    if (endReason !== 'promptJoined' && this.deferredUpdates && this.agentTurn === turn && !this.pendingTurn) {
      this.releaseDeferred()
    }
    turn.ended = true
    if (this.agentTurn === turn) this.agentTurn = null
    if (!turn.announced) {
      // A prompt took the run over before it said anything: there is nothing to end.
      if (endReason === 'promptJoined') return
      turn.announceDeferred = false
      turn.announced = true
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: {
          piAcp: {
            running: true,
            agentTurn: compact({
              version: LIVE_VERSION,
              id: turn.id,
              state: 'running',
              startedAt: turn.startedAt,
              trigger: turn.trigger ?? unknownTrigger()
            })
          }
        }
      })
      const trigger = turn.trigger ?? unknownTrigger()
      this.air.spawn({ id: turn.id, kind: 'turn', name: 'Pi is working', description: trigger.reason })
    }
    const stopReason = 'error' in outcome ? 'error' : outcome.stopReason
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: {
        piAcp: {
          running: this.pendingTurn !== null || this.joining !== null,
          agentTurn: compact({
            version: LIVE_VERSION,
            id: turn.id,
            state: 'ended',
            endReason,
            stopReason,
            errorMessage: 'error' in outcome ? outcome.error.message : undefined,
            durationMs: Date.now() - turn.startedAt
          })
        }
      }
    })
    this.air.finish(turn.id, stopReason === 'cancelled' ? 'stopped' : stopReason === 'error' ? 'failed' : 'completed')
    if (endReason !== 'promptJoined') this.clearClientMessages()
  }

  /** pi settled a run it started by itself. */
  private async settleAgentTurn(turn: AgentTurn, stop: PiAssistantStop | null, aborted: boolean): Promise<void> {
    try {
      // A steer, or a prompt joining the run, may still be on its way.
      await this.waitForInflightSteers()
      if (this.pendingTurn && this.joinedAgentTurn === turn) {
        // A prompt took this run over: it settles as that prompt's turn.
        await this.settleTurn(stop)
        return
      }
      if (turn.ended) return
      if (this.agentTurn === turn && this.hasQueuedPiMessages() && !this.cancelRequested) {
        // A steer reached pi after its last queue check: run it in this turn.
        const parked = await this.takeQueuedPiMessages()
        if (parked.length > 0 && (await this.continueTurnWith(parked, { agentTurn: true }))) return
      }
      await this.flushEmits()
      const cancelled = this.cancelRequested || aborted
      this.endAgentTurn(turn, cancelled ? 'cancelled' : 'settled', turnOutcome(stop, cancelled))
      this.cancelRequested = false
    } finally {
      this.settling = false
    }
    if (!this.pendingTurn && !this.joining) this.startNextQueued()
  }

  /** Why a run pi started by itself started: its first message. */
  private triggerOf(msg: JsonRecord): AgentTurnTrigger {
    const text = contentText(msg.content)
    if (msg.role === 'custom') {
      const customType = str(msg.customType) ?? 'custom'
      const kind = triggerKindOf(customType)
      const toolCallIds = this.noticeAnchors(customType, msg.details, text)
      return compact({
        kind,
        reason: wakeReason(kind),
        customType,
        hidden: msg.display === false ? true : undefined,
        summary: noticeSummary(customType, msg.details, text),
        toolCallIds: toolCallIds.length ? toolCallIds : undefined
      })
    }
    if (msg.role === 'user') {
      const report = legacyJobReport(text)
      const kind: TriggerKind = report ? 'jobExit' : 'injectedUser'
      const anchor = report ? this.jobs.anchorForJobId(report.jobId) : undefined
      return compact({
        kind,
        reason: wakeReason(kind),
        customType: INJECTED_USER_TYPE,
        summary: noticeSummary(INJECTED_USER_TYPE, undefined, text),
        toolCallIds: anchor ? [anchor] : undefined
      })
    }
    return unknownTrigger()
  }

  // ── Extension notices ───────────────────────────────────────────────────

  /** The anchors (launch tool calls) a notice reports on. */
  private noticeAnchors(customType: string, details: unknown, text: string): string[] {
    const ids = new Set<string>()
    if (customType.startsWith('subagent')) {
      for (const anchor of this.subagents.anchorsOf(noticeRunIds(customType, details, text))) ids.add(anchor)
    }
    if (customType === BG_JOB_EXIT && isRecord(details)) {
      const jobId = str(details.id)
      const anchor = jobId ? this.jobs.anchorForJobId(jobId) : undefined
      const toolCallId = anchor ?? str(details.toolCallId)
      if (toolCallId) ids.add(toolCallId)
    }
    return [...ids]
  }

  /** A `custom` message (pi's `message_end`): an extension's notice to the model. */
  private onCustomMessage(msg: JsonRecord): void {
    const customType = str(msg.customType) ?? 'custom'
    const text = contentText(msg.content)
    const details = msg.details
    const display = msg.display !== false
    const changed = new Set(this.subagents.onCustomMessage(customType, details, text))
    if (customType === BG_JOB_EXIT) for (const anchor of this.jobs.onExitRecord(details, text)) changed.add(anchor)
    const window = this.commandWindow
    this.forwardNotice({
      role: 'custom',
      customType,
      display,
      details,
      text,
      timestamp: num(msg.timestamp),
      toolCallIds: this.noticeAnchors(customType, details, text),
      commandReply: Boolean(window && display)
    })
    if (window && display && text.trim()) {
      // An extension command that answers with a message (pi-subagents' slash
      // commands do): that message is the command's reply.
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
        _meta: {
          piAcp: {
            commandReply: { version: LIVE_VERSION, command: window.command, source: 'customMessage', customType }
          }
        }
      })
    }
    for (const anchor of changed) this.emitAnchor(anchor, { urgent: true })
  }

  /**
   * A user message (pi's `message_end`). The client's own prompts and steers are
   * not echoed; one an extension sent (`pi.sendUserMessage`, and older
   * pi-bg-jobs exit reports) is forwarded as a notice, never as the user's words.
   */
  private onUserMessage(msg: JsonRecord): void {
    const text = userMessageText(msg)
    const report = legacyJobReport(text)
    if (!report && this.takeClientMessage(text)) return
    const changed: string[] = report ? this.jobs.onLegacyReport(report, text) : []
    const anchor = report ? this.jobs.anchorForJobId(report.jobId) : undefined
    this.forwardNotice({
      role: 'user',
      customType: INJECTED_USER_TYPE,
      display: true,
      details: report ? { legacyJobReport: report satisfies LegacyJobReport } : undefined,
      text,
      timestamp: num(msg.timestamp),
      toolCallIds: anchor ? [anchor] : []
    })
    for (const id of changed) this.emitAnchor(id, { urgent: true })
  }

  /** `_meta.piAcp.customMessage`: a notice, hidden ones included, with its structured details. */
  private forwardNotice(n: {
    role: 'custom' | 'user'
    customType: string
    display: boolean
    details: unknown
    text: string
    timestamp?: number
    toolCallIds: string[]
    commandReply?: boolean
  }): void {
    const details = boundedJson(n.details)
    const text = clipText(n.text, NOTICE_TEXT_MAX_CHARS)
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: {
        piAcp: {
          customMessage: compact({
            version: LIVE_VERSION,
            role: n.role,
            customType: n.customType,
            display: n.display,
            hidden: n.display ? undefined : true,
            details: details.value,
            detailsTruncated: details.truncated || undefined,
            text: text.text,
            textTruncated: text.truncated || undefined,
            timestamp: n.timestamp,
            toolCallIds: n.toolCallIds.length ? n.toolCallIds : undefined,
            agentTurnId: this.agentTurnOpen() ? this.agentTurn!.id : undefined,
            commandReply: n.commandReply || undefined
          })
        }
      }
    })
  }

  /** A custom session entry an extension appended (not in the model's context). */
  private onCustomEntry(entry: JsonRecord): void {
    const customType = str(entry.customType) ?? 'custom'
    const data = entry.data
    const changed = new Set(this.subagents.onCustomEntry(customType, data))
    if (customType === BG_JOB_EXIT) for (const anchor of this.jobs.onExitRecord(data)) changed.add(anchor)
    const toolCallIds = new Set([
      ...changed,
      ...(customType === BG_JOB_EXIT ? this.noticeAnchors(customType, data, '') : [])
    ])
    const bounded = boundedJson(data)
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: {
        piAcp: {
          customEntry: compact({
            version: LIVE_VERSION,
            customType,
            id: str(entry.id),
            timestamp: str(entry.timestamp),
            data: bounded.value,
            dataTruncated: bounded.truncated || undefined,
            toolCallIds: toolCallIds.size ? [...toolCallIds] : undefined
          })
        }
      }
    })
    for (const anchor of changed) this.emitAnchor(anchor, { urgent: true })
  }

  // ── Compaction ──────────────────────────────────────────────────────────

  private onCompactionStart(ev: PiRpcEvent, legacy: boolean): void {
    const reason = str((ev as JsonRecord).reason) ?? (legacy ? 'threshold' : undefined)
    this.compactionSeq += 1
    const compaction = {
      id: `pi-compaction-${this.compactionSeq}-${crypto.randomUUID().slice(0, 8)}`,
      reason,
      startedAt: Date.now()
    }
    this.compaction = compaction
    // The sentence clients already know (codeg drops it from the prose); `/compact`
    // reports its own result.
    if (reason !== 'manual') {
      this.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: AUTO_COMPACTION_STARTED } })
    }
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: {
        piAcp: {
          compaction: compact({
            version: LIVE_VERSION,
            id: compaction.id,
            status: 'in_progress',
            reason,
            startedAt: compaction.startedAt
          })
        }
      }
    })
  }

  private onCompactionEnd(ev: PiRpcEvent, legacy: boolean): void {
    const e = ev as JsonRecord
    const started = this.compaction
    this.compaction = null
    const reason = str(e.reason) ?? started?.reason ?? (legacy ? 'threshold' : undefined)
    const result = isRecord(e.result) ? e.result : undefined
    const status = result || legacy ? 'completed' : e.aborted === true ? 'cancelled' : 'failed'
    if (reason !== 'manual' && status === 'completed') {
      this.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: AUTO_COMPACTION_FINISHED } })
    }
    const summary = str(result?.summary)
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: {
        piAcp: {
          compaction: compact({
            version: LIVE_VERSION,
            id: started?.id ?? `pi-compaction-${++this.compactionSeq}-${crypto.randomUUID().slice(0, 8)}`,
            status,
            reason,
            tokensBefore: num(result?.tokensBefore),
            estimatedTokensAfter: num(result?.estimatedTokensAfter),
            summary: summary ? clipText(summary, COMPACTION_SUMMARY_MAX_CHARS).text : undefined,
            willRetry: e.willRetry === true ? true : undefined,
            errorMessage: str(e.errorMessage),
            durationMs: started ? Date.now() - started.startedAt : undefined
          })
        }
      }
    })
  }

  // ── Stop for AIR tasks, and the end of the pi process ───────────────────

  /**
   * `_session/async_task/stop`: stop a turn pi started by itself (like a
   * cancel), a job (`/bgj-kill`), or an async sub-agent run (`/subagents-stop`).
   * The commands run inside pi with no model turn.
   */
  async stopAsyncTask(asyncTaskId: string): Promise<{ stopped: boolean }> {
    const turn = this.agentTurn
    if (turn && !turn.ended && turn.id === asyncTaskId) {
      await this.cancel()
      return { stopped: true }
    }
    const jobAnchor = this.jobs.anchorForJobId(asyncTaskId)
    if (jobAnchor && this.jobs.stateOf(jobAnchor) === 'running') {
      return { stopped: await this.runExtensionCommand('bgj-kill', asyncTaskId) }
    }
    const runAnchor = this.subagents.anchorForRunId(asyncTaskId)
    const runStatus = runAnchor ? this.subagents.statusOf(runAnchor) : undefined
    if (runStatus && !isTerminalStatus(runStatus)) {
      return { stopped: await this.runExtensionCommand('subagents-stop', asyncTaskId) }
    }
    return { stopped: false }
  }

  private async runExtensionCommand(name: string, arg: string): Promise<boolean> {
    // Only a command pi knows: anything else would reach the model as a prompt.
    if (!(await this.hasExtensionCommand(name))) return false
    try {
      return (await this.proc.prompt(`/${name} ${arg}`, [], { streamingBehavior: 'steer' })) === 'handled'
    } catch {
      return false
    }
  }

  private async hasExtensionCommand(name: string): Promise<boolean> {
    const now = Date.now()
    if (!this.extensionCommands || now - this.extensionCommands.at > 60_000) {
      try {
        const data = (await this.proc.getCommands()) as unknown
        const commands = isRecord(data) && Array.isArray(data.commands) ? data.commands.filter(isRecord) : []
        const names = new Set(commands.map(c => str(c.name)).filter((n): n is string => Boolean(n)))
        this.extensionCommands = { names, at: now }
      } catch {
        return false
      }
    }
    return this.extensionCommands.names.has(name)
  }

  /** The pi process is gone: end what it was running, and answer whoever waits. */
  private onProcessExit(info: { code: number | null; signal: NodeJS.Signals | null }): void {
    const reason = `pi exited (code=${info.code}, signal=${info.signal})`
    this.releaseDeferred()
    const turn = this.agentTurn
    if (turn && !turn.ended) this.endAgentTurn(turn, 'processExited', { error: piStopError(reason) })
    this.air.finishAll('stopped')
    const pending = this.pendingTurn
    this.pendingTurn = null
    pending?.reject(piStopError(reason))
    const joining = this.joining
    this.joining = null
    joining?.reject(piStopError(reason))
    for (const queued of this.turnQueue.splice(0, this.turnQueue.length)) queued.reject(piStopError(reason))
    this.runActive = false
    this.settling = false
    this.dispose()
  }

  private async handleExtensionUiRequest(ev: PiRpcEvent): Promise<void> {
    const id = stringProp(ev, 'id')
    const method = stringProp(ev, 'method')
    if (!id) {
      return
    }

    // Fire-and-forget methods (pi expects no response). Two widgets carry the
    // RPC status trees of pi-subagents and pi-bg-jobs; the rest are TUI chrome.
    if (method && FIRE_AND_FORGET_UI.has(method)) {
      if (method === 'setWidget') this.onWidget(ev)
      return
    }

    if (method === 'select') {
      await this.handleExtensionSelect(ev, id)
      return
    }

    if (method === 'confirm') {
      await this.handleExtensionConfirm(ev, id)
      return
    }

    if (method === 'input' || method === 'editor') {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `Pi ${method} UI request is not supported in ACP yet; cancelling it.`
        } satisfies ContentBlock
      })
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    if (method === 'notify') {
      const level = stringProp(ev, 'notifyType') ?? 'info'
      const window = this.commandWindow
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: stringProp(ev, 'message') ?? 'Pi notification' } satisfies ContentBlock,
        // While an extension command runs, its notifications are its reply
        // (`/jobs` lists the jobs this way): plain text the user asked for,
        // not a passing notification.
        _meta: window
          ? {
              piAcp: {
                commandReply: { version: LIVE_VERSION, command: window.command, source: 'notify', level }
              }
            }
          : { piAcp: { notify: { level } } }
      })
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, cancelled: true })
  }

  private async handleExtensionSelect(ev: PiRpcEvent, id: string): Promise<void> {
    const rawOptions = ev.options
    const options = Array.isArray(rawOptions) ? rawOptions.map(option => String(option)) : []
    if (!options.length) {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    const permissionOptions: PermissionOption[] = options.map((name, index) => ({
      optionId: `${CHOICE_OPTION_PREFIX}${index}`,
      name,
      kind: 'allow_once'
    }))

    const selected = await this.requestExtensionPermission(id, ev, permissionOptions)
    if (selected === null) {
      return
    }

    const selectedOptionId = selected.outcome.outcome === 'selected' ? selected.outcome.optionId : null
    const index = selectedOptionId === null ? null : optionIndex(selectedOptionId)
    const value = index === null ? null : (options.at(index) ?? null)
    await this.proc.sendExtensionUiResponse(value === null ? { id, cancelled: true } : { id, value })
  }

  private async handleExtensionConfirm(ev: PiRpcEvent, id: string): Promise<void> {
    const selected = await this.requestExtensionPermission(id, ev, CONFIRM_PERMISSION_OPTIONS)
    if (selected === null) {
      return
    }

    if (selected.outcome.outcome === 'cancelled') {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, confirmed: selected.outcome.optionId === 'yes' })
  }

  private async requestExtensionPermission(
    id: string,
    ev: PiRpcEvent,
    options: PermissionOption[]
  ): Promise<PermissionResponse | null> {
    try {
      return await this.conn.requestPermission({
        sessionId: this.sessionId,
        toolCall: extensionUiToolCall(id, ev),
        options
      })
    } catch {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return null
    }
  }
}

function extensionUiToolCall(id: string, ev: PiRpcEvent) {
  const method = stringProp(ev, 'method') ?? 'ui'
  const title = stringProp(ev, 'title') ?? `Pi ${method}`
  const rawInput: Record<string, unknown> = { method }

  for (const key of EXTENSION_UI_RAW_INPUT_KEYS) {
    if (Object.hasOwn(ev, key)) rawInput[key] = ev[key]
  }

  return {
    toolCallId: `pi-ui-${id}`,
    title,
    kind: 'other' as const,
    status: 'pending' as const,
    rawInput
  }
}

function stringProp(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

function optionIndex(optionId: string): number | null {
  if (!optionId.startsWith(CHOICE_OPTION_PREFIX)) {
    return null
  }

  const rawIndex = optionId.slice(CHOICE_OPTION_PREFIX.length)
  if (!rawIndex) {
    return null
  }

  const index = Number(rawIndex)
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex ? index : null
}

function formatAutoRetryMessage(ev: PiRpcEvent): string {
  const attempt = Number((ev as any).attempt)
  const maxAttempts = Number((ev as any).maxAttempts)
  const delayMs = Number((ev as any).delayMs)

  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return 'Retrying...'
  }

  let delaySeconds = Math.round(delayMs / 1000)
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`
}

/** Where pi-subagents keeps async run state for the pi child this adapter starts. */
function subagentsTempRoot(): string {
  return piChildEnv(process.env)[SUBAGENTS_TEMP_ROOT_ENV] ?? ''
}

/** `name` for a prompt that may be an extension command (`/name args`). */
function extensionCommandName(text: string): string | undefined {
  return /^\/([A-Za-z0-9][\w:.-]*)/.exec(text.trimStart())?.[1]
}

function unknownTrigger(): AgentTurnTrigger {
  return { kind: 'unknown', reason: wakeReason('unknown') }
}

/** The JSON after `prefix` in a widget's lines. */
function parseWidgetLine(lines: unknown, prefix: string): unknown {
  if (!Array.isArray(lines)) return undefined
  for (const line of lines) {
    if (typeof line !== 'string' || !line.startsWith(prefix)) continue
    try {
      return JSON.parse(line.slice(prefix.length))
    } catch {
      return undefined
    }
  }
  return undefined
}

/** What a client must see at once (status, sessions, results); other changes may wait. */
function anchorSignificance(live: JsonRecord): string {
  const run = live.subagentRun as SubagentRunSnapshot | undefined
  if (run) {
    return JSON.stringify([
      run.status,
      run.runId,
      run.error,
      run.result?.length,
      run.sessionFile,
      run.sessionId,
      run.children.map(c => [
        c.key,
        c.status,
        c.model,
        c.sessionFile,
        c.sessionId,
        c.error,
        c.result?.length,
        c.exchanges?.length,
        c.exchanges?.filter(x => x.answer).length
      ])
    ])
  }
  return JSON.stringify((live.backgroundJob as BackgroundJobSnapshot | undefined) ?? null)
}

function runAirProgress(run: SubagentRunSnapshot): AsyncTaskProgress {
  const done = run.children.filter(c => isTerminalStatus(c.status)).length
  const current = run.activity?.currentTool ?? run.children.find(c => c.activity?.currentTool)?.activity?.currentTool
  const usage =
    run.tokens !== undefined && run.toolCount !== undefined && run.startedAt !== undefined
      ? { totalTokens: run.tokens, toolUses: run.toolCount, durationMs: Math.max(0, Date.now() - run.startedAt) }
      : undefined
  return compact({
    summary: run.children.length > 1 ? `${done}/${run.children.length} done` : undefined,
    lastToolName: current,
    usage
  })
}

function jobSummary(job: BackgroundJobSnapshot): string | undefined {
  const seconds = job.durationMs !== undefined ? Math.round(job.durationMs / 1000) : undefined
  const ran = seconds !== undefined ? ` · ${seconds}s` : ''
  if (job.state === 'killed') return `killed${job.killedBy ? ` (${job.killedBy})` : ''}${ran}`
  if (typeof job.exitCode === 'number') return `exit ${job.exitCode}${ran}`
  return job.state + ran
}

function shortCommand(command: string | undefined): string | undefined {
  if (!command) return undefined
  return clipText(command.split('\n')[0]!.trim(), 80).text || undefined
}

function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
      return 'execute'
    default:
      return 'other'
  }
}
