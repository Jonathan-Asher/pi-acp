/**
 * Live state of pi-subagents runs, keyed by the `subagent` tool call that
 * launched each one (the run's anchor).
 *
 * Inputs, in the order pi produces them: the launch call's arguments, its
 * partial results (foreground runs stream `details.progress`), its result
 * (`details.runId/asyncId/asyncDir/results/workflowChildren`), the
 * `subagent-async` RPC widget (`PI_SUBAGENT_ASYNC_JSON`, about once a second
 * while an async run is active), a run's `status.json` (read on demand), and
 * the notices pi-subagents adds to the conversation (`subagent-notify`,
 * `subagent-incremental-child-notify`, supervisor requests and replies).
 *
 * Output: one snapshot per anchor (`_meta.piAcp.subagentRun`) in the shape of
 * codeg's history card (`codeg.subagentRun`): the run's status, result and
 * error, and one row per child (workflow lane, parallel task, chain step) with
 * its agent, model, status, activity, session and questions.
 *
 * Pure: no I/O except the optional `sessionIdOf` lookup, so session/load can
 * replay a transcript through the same code.
 */
import {
  noticeError,
  noticeResultPreview,
  SUBAGENT_CHILD_NOTIFY,
  SUBAGENT_NOTIFY,
  SUPERVISOR_REPLY,
  SUPERVISOR_REQUEST
} from './notices.js'
import {
  clip,
  compact,
  contentText,
  firstLine,
  isRecord,
  LIVE_VERSION,
  num,
  ROW_TEXT_MAX_CHARS,
  str,
  type JsonRecord
} from './wire.js'

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused' | 'stopped'

const TERMINAL: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'paused', 'stopped'])
const RUN_RESULT_MAX_CHARS = 8000
const LAUNCH_KEYS = ['agent', 'task', 'tasks', 'chain', 'workflowScript', 'workflowScriptPath', 'workflow'] as const
export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['subagent', 'subagent_supervisor', 'bg_wait'])

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL.has(status)
}

/** pi-subagents' many status spellings, on the history card's scale. */
export function normalizeRunStatus(value: unknown): RunStatus | undefined {
  switch (value) {
    case 'queued':
    case 'pending':
      return 'pending'
    case 'running':
    case 'active':
    case 'detached':
      return 'running'
    case 'complete':
    case 'completed':
    case 'done':
    case 'success':
      return 'completed'
    case 'failed':
    case 'error':
    case 'rejected':
    case 'partial':
      return 'failed'
    case 'paused':
      return 'paused'
    case 'stopped':
    case 'interrupted':
    case 'cancelled':
    case 'canceled':
      return 'stopped'
    default:
      return undefined
  }
}

/** Whether a `subagent` call runs something rather than managing runs (`action` set). */
export function isLaunch(args: unknown): boolean {
  if (!isRecord(args)) return false
  if (str(args.action)) return false
  return LAUNCH_KEYS.some(key => args[key] !== undefined && args[key] !== null)
}

export function modeOfArgs(args: JsonRecord): string {
  const has = (key: string) => args[key] !== undefined && args[key] !== null
  if (has('workflowScript') || has('workflowScriptPath') || has('workflow')) return 'workflow'
  if (has('tasks')) return 'parallel'
  if (has('chain')) return 'chain'
  return 'single'
}

/** `_meta.piAcp.subagent`: what a pi-subagents tool call is, sent on all of its updates. */
export type SubagentMarker = {
  version: number
  role: 'run' | 'control'
  tool: string
  action?: string
  mode?: string
  async?: boolean
  agents?: string[]
  label?: string
  runId?: string
  /** A control call's run: the `subagent` launch it acts on, when known. */
  anchorToolCallId?: string
}

export type Exchange = { requestId?: string; question: string; answer?: string }

/** One row of a run card (`children[]`). Keys and labels follow codeg's history fold. */
export type ChildRow = {
  key: string
  label: string
  agent?: string
  status: RunStatus
  runId?: string
  task?: string
  model?: string
  thinking?: string
  activity?: { currentTool?: string; toolCount?: number; lastActivityAt?: number }
  progressText?: string
  startedAt?: number
  endedAt?: number
  durationMs?: number
  tokens?: number
  turns?: number
  sessionFile?: string
  sessionId?: string
  error?: string
  result?: string
  exchanges?: Exchange[]
  attention?: string[]
}

/** `_meta.piAcp.subagentRun`: everything a run card shows, replaced whole on every update. */
export type SubagentRunSnapshot = {
  version: number
  toolCallId: string
  runId?: string
  mode: string
  async: boolean
  status: RunStatus
  agent: string
  agents?: string[]
  task?: string
  startedAt?: number
  endedAt?: number
  durationMs?: number
  tokens?: number
  toolCount?: number
  turnCount?: number
  activity?: { currentTool?: string; lastActivityAt?: number }
  result?: string
  error?: string
  sessionFile?: string
  sessionId?: string
  asyncDir?: string
  children: ChildRow[]
}

type ChildState = Omit<ChildRow, 'label' | 'activity' | 'exchanges' | 'attention'> & {
  currentTool?: string
  toolCount?: number
  turnCount?: number
  lastActivityAt?: number
  exchanges: Exchange[]
  index?: number
}

type RunState = {
  toolCallId: string
  turnSeq: number
  args: JsonRecord
  marker: SubagentMarker
  mode: string
  async: boolean
  launched: boolean
  runId?: string
  asyncDir?: string
  status: RunStatus
  task?: string
  startedAt?: number
  endedAt?: number
  durationMs?: number
  tokens?: number
  toolCount?: number
  turnCount?: number
  currentTool?: string
  lastActivityAt?: number
  result?: string
  error?: string
  children: Map<string, ChildState>
}

export type TrackerOptions = {
  now?: () => number
  /** The id in a child session file's header, or undefined while it does not exist yet. */
  sessionIdOf?: (sessionFile: string) => string | undefined
}

export class SubagentTracker {
  private readonly runs = new Map<string, RunState>()
  /** Run ids (the run's, its workflow's, its children's) → the anchor's tool call id. */
  private readonly anchorByRunId = new Map<string, string>()
  private readonly markers = new Map<string, SubagentMarker>()
  /** Supervisor request id → the anchor, so the parent's reply finds its run. */
  private readonly anchorByRequest = new Map<string, string>()
  private readonly now: () => number
  private readonly sessionIdOf?: (sessionFile: string) => string | undefined
  /** Run ids the last widget snapshot listed, to notice runs that left it. */
  private widgetRunIds = new Set<string>()

  constructor(opts: TrackerOptions = {}) {
    this.now = opts.now ?? Date.now
    this.sessionIdOf = opts.sessionIdOf
  }

  // ── Tool calls ─────────────────────────────────────────────────────────

  /** A pi-subagents tool call started. Returns its marker (or undefined for other tools). */
  onToolStart(toolCallId: string, toolName: string, args: unknown, turnSeq: number): SubagentMarker | undefined {
    if (!SUBAGENT_TOOLS.has(toolName)) return undefined
    const a: JsonRecord = isRecord(args) ? args : {}
    const existing = this.runs.get(toolCallId)
    if (toolName === 'subagent' && isLaunch(a)) {
      const mode = modeOfArgs(a)
      const agents = agentsOfArgs(a)
      const marker: SubagentMarker = compact({
        version: LIVE_VERSION,
        role: 'run' as const,
        tool: toolName,
        mode,
        async: a.async === true ? true : a.async === false ? false : undefined,
        agents: agents.length ? agents : undefined,
        label: str(a.agent) ?? (agents.length && agents.every(x => x === agents[0]) ? agents[0] : mode)
      })
      this.markers.set(toolCallId, marker)
      if (existing) {
        existing.args = a
        existing.marker = marker
        return marker
      }
      const run: RunState = {
        toolCallId,
        turnSeq,
        args: a,
        marker,
        mode,
        async: a.async === true,
        launched: false,
        status: 'pending',
        task: str(a.task),
        startedAt: this.now(),
        children: new Map()
      }
      seedChildren(run)
      this.runs.set(toolCallId, run)
      return marker
    }
    const runId = str(a.id) ?? str(a.runId)
    const requestId = str(a.replyTo) ?? str(a.requestId)
    const anchor = (runId && this.anchorByRunId.get(runId)) || (requestId && this.anchorByRequest.get(requestId))
    const marker: SubagentMarker = compact({
      version: LIVE_VERSION,
      role: 'control' as const,
      tool: toolName,
      action: str(a.action),
      runId,
      anchorToolCallId: anchor || undefined
    })
    this.markers.set(toolCallId, marker)
    return marker
  }

  markerFor(toolCallId: string): SubagentMarker | undefined {
    return this.markers.get(toolCallId)
  }

  isAnchor(toolCallId: string): boolean {
    return this.runs.has(toolCallId)
  }

  /** A foreground run reported progress (`tool_execution_update`). */
  onToolUpdate(toolCallId: string, partial: unknown): boolean {
    const run = this.runs.get(toolCallId)
    if (!run || !isRecord(partial)) return false
    const details = isRecord(partial.details) ? partial.details : undefined
    if (!details) return false
    if (run.status === 'pending') run.status = 'running'
    this.applyDetails(run, details, false)
    return true
  }

  /** The launch call returned. `durationMs` is pi's measure of the call (pi 1.x). */
  onToolEnd(toolCallId: string, result: unknown, isError: boolean, durationMs?: number): boolean {
    const run = this.runs.get(toolCallId)
    if (!run) return false
    run.launched = true
    const r: JsonRecord = isRecord(result) ? result : {}
    const details = isRecord(r.details) ? r.details : undefined
    const text = contentText(r.content)
    if (details) this.applyDetails(run, details, true)
    const asyncRun = Boolean(details && (str(details.asyncId) || details.background === true)) && !isError
    if (asyncRun) {
      run.async = true
      if (!isTerminalStatus(run.status)) run.status = run.status === 'pending' ? 'running' : run.status
    } else {
      run.async = false
      run.result = clip(text.trim() || undefined, RUN_RESULT_MAX_CHARS)
      run.endedAt = this.now()
      if (durationMs !== undefined) run.durationMs = Math.round(durationMs)
      else if (run.startedAt) run.durationMs = run.endedAt - run.startedAt
      const status = isError ? 'failed' : foregroundStatus(run, details)
      this.settle(run, status)
      if (isError && !run.error) run.error = firstLine(text, 400) || 'The sub-agent call failed'
    }
    run.marker = { ...run.marker, async: run.async, ...(run.runId ? { runId: run.runId } : {}) }
    this.markers.set(toolCallId, run.marker)
    return true
  }

  // ── The RPC widget ─────────────────────────────────────────────────────

  /**
   * A `subagent-async` widget snapshot (`PI_SUBAGENT_ASYNC_JSON`). Returns the
   * anchors it changed and the run ids it names that no anchor claims yet
   * (runs launched by an earlier pi process; `status.json` names their call).
   */
  onWidget(snapshot: unknown): { changed: string[]; unknownRunIds: string[]; departedRunIds: string[] } {
    const runs = isRecord(snapshot) && Array.isArray(snapshot.runs) ? snapshot.runs.filter(isRecord) : []
    const changed = new Set<string>()
    const unknown: string[] = []
    const seen = new Set<string>()
    for (const node of runs) {
      const id = str(node.id)
      if (!id) continue
      seen.add(id)
      const anchor = this.anchorByRunId.get(id)
      const run = anchor ? this.runs.get(anchor) : undefined
      if (!run) {
        if (!isTerminalStatus(normalizeRunStatus(node.state) ?? 'running')) unknown.push(id)
        continue
      }
      if (this.applyWidgetRun(run, node)) changed.add(run.toolCallId)
    }
    const departed = [...this.widgetRunIds].filter(id => !seen.has(id))
    this.widgetRunIds = seen
    return { changed: [...changed], unknownRunIds: unknown, departedRunIds: departed }
  }

  /**
   * A run's `status.json` (pi-subagents' own record of it). Claims the run for
   * the tool call it names when no launch in this process did, and fills in
   * what the widget leaves out: each child's session file, tokens and error.
   */
  onStatusFile(runId: string, status: unknown, turnSeq: number): string | undefined {
    if (!isRecord(status)) return undefined
    let anchor = this.anchorByRunId.get(runId)
    if (!anchor) {
      const toolCallId = str(status.toolCallId)
      if (!toolCallId) return undefined
      anchor = toolCallId
      if (!this.runs.has(toolCallId)) {
        const steps = Array.isArray(status.steps) ? status.steps.filter(isRecord) : []
        const agents = steps.map(s => str(s.agent)).filter((x): x is string => Boolean(x))
        const mode = str(status.mode) ?? 'single'
        const marker: SubagentMarker = compact({
          version: LIVE_VERSION,
          role: 'run' as const,
          tool: 'subagent',
          mode,
          async: true,
          agents: agents.length ? agents : undefined,
          label: agents.length && agents.every(x => x === agents[0]) ? agents[0] : mode,
          runId
        })
        this.markers.set(toolCallId, marker)
        this.runs.set(toolCallId, {
          toolCallId,
          turnSeq,
          args: {},
          marker,
          mode,
          async: true,
          launched: true,
          runId,
          status: 'running',
          startedAt: num(status.startedAt),
          children: new Map()
        })
      }
      this.claimRunId(runId, toolCallId)
    }
    const run = this.runs.get(anchor)
    if (!run) return undefined
    if (!run.asyncDir) run.asyncDir = str(status.asyncDir)
    const state = normalizeRunStatus(status.state)
    if (state) this.setStatus(run, state)
    run.startedAt ??= num(status.startedAt)
    if (isTerminalStatus(run.status)) run.endedAt ??= num(status.endedAt) ?? num(status.lastUpdate)
    if (run.endedAt && run.startedAt && run.durationMs === undefined) run.durationMs = run.endedAt - run.startedAt
    const total = tokenTotal(status.totalTokens)
    if (total !== undefined) run.tokens = total
    if (str(status.error) && run.status === 'failed') run.error ??= clip(str(status.error), ROW_TEXT_MAX_CHARS)
    const steps = Array.isArray(status.steps) ? status.steps.filter(isRecord) : []
    steps.forEach((step, index) => {
      const child = this.childFor(run, {
        workflowKey: str(step.workflowKey),
        childId: str(step.childId),
        runId: str(step.runId),
        index,
        agent: str(step.agent)
      })
      if (!child) return
      child.agent ??= str(step.agent)
      child.runId ??= str(step.runId)
      if (child.runId) this.claimRunId(child.runId, run.toolCallId)
      const s = normalizeRunStatus(step.status)
      if (s) setChildStatus(child, s)
      child.model = modelName(step) ?? child.model
      child.thinking = str(step.thinking) ?? child.thinking
      child.sessionFile = str(step.sessionFile) ?? child.sessionFile
      child.tokens = tokenTotal(step.tokens) ?? child.tokens
      child.toolCount = num(step.toolCount) ?? child.toolCount
      child.turnCount = num(step.turnCount) ?? child.turnCount
      child.startedAt ??= num(step.startedAt)
      child.endedAt = num(step.endedAt) ?? child.endedAt
      child.durationMs = num(step.durationMs) ?? child.durationMs
      if (str(step.error)) child.error = clip(str(step.error), ROW_TEXT_MAX_CHARS)
      if (str(step.description) && !str(step.description)?.startsWith('['))
        child.task ??= clip(str(step.description), ROW_TEXT_MAX_CHARS)
    })
    this.resolveSessionIds(run)
    return run.toolCallId
  }

  // ── Notices ────────────────────────────────────────────────────────────

  /** The anchors a notice reports on. */
  anchorsOf(runIds: string[]): string[] {
    const out = new Set<string>()
    for (const id of runIds) {
      const anchor = this.anchorByRunId.get(id)
      if (anchor) out.add(anchor)
    }
    return [...out]
  }

  anchorForRunId(runId: string): string | undefined {
    return this.anchorByRunId.get(runId)
  }

  /** A pi-subagents custom message (`message_end`). Returns the anchors it changed. */
  onCustomMessage(customType: string, details: unknown, text: string): string[] {
    const d: JsonRecord = isRecord(details) ? details : {}
    switch (customType) {
      case SUBAGENT_NOTIFY:
        return this.onRunNotice(d, text)
      case SUBAGENT_CHILD_NOTIFY:
        return this.onChildNotice(d, text)
      case SUPERVISOR_REQUEST:
        return this.onSupervisorRequest(d)
      default:
        return []
    }
  }

  /** A pi-subagents custom entry (`entry_appended`, or replayed). Returns the anchors it changed. */
  onCustomEntry(customType: string, data: unknown): string[] {
    if (customType !== SUPERVISOR_REPLY || !isRecord(data)) return []
    const requestId = str(data.requestId)
    const message = str(data.message)
    if (!requestId || !message) return []
    const anchor = this.anchorByRequest.get(requestId) ?? (str(data.runId) && this.anchorByRunId.get(str(data.runId)!))
    const run = anchor ? this.runs.get(anchor) : undefined
    if (!run) return []
    for (const child of run.children.values()) {
      const exchange = child.exchanges.find(x => x.requestId === requestId)
      if (exchange) {
        exchange.answer = clip(message, ROW_TEXT_MAX_CHARS)
        return [run.toolCallId]
      }
    }
    return []
  }

  private onRunNotice(details: JsonRecord, text: string): string[] {
    const runs = Array.isArray(details.runs) ? details.runs.filter(isRecord) : []
    const changed = new Set<string>()
    for (const notice of runs) {
      const runId = str(notice.runId)
      const workflowRunId = str(notice.workflowRunId)
      const anchor =
        (runId && this.anchorByRunId.get(runId)) || (workflowRunId && this.anchorByRunId.get(workflowRunId))
      const run = anchor ? this.runs.get(anchor) : undefined
      if (!run) continue
      const status = normalizeRunStatus(notice.status) ?? 'completed'
      this.settle(run, status)
      const durationMs = num(notice.durationMs)
      if (durationMs !== undefined) run.durationMs = durationMs
      run.endedAt ??= this.now()
      const sessionFile = str(notice.sessionValue)
      if (sessionFile && sessionFile.endsWith('.jsonl') && run.children.size <= 1) {
        const only = [...run.children.values()][0] ?? this.childFor(run, { index: 0, agent: str(notice.agent) })
        if (only) only.sessionFile = sessionFile
      }
      for (const childRun of Array.isArray(notice.childRuns) ? notice.childRuns.filter(isRecord) : []) {
        const child = this.childFor(run, {
          workflowKey: str(childRun.workflowKey),
          runId: str(childRun.runId) === 'unavailable' ? undefined : str(childRun.runId),
          agent: str(childRun.agent)
        })
        if (!child) continue
        const s = normalizeRunStatus(childRun.status)
        if (s) setChildStatus(child, s)
        const childRunId = str(childRun.runId)
        if (childRunId && childRunId !== 'unavailable') {
          child.runId ??= childRunId
          this.claimRunId(childRunId, run.toolCallId)
        }
      }
      if (runs.length === 1) {
        const preview = noticeResultPreview(text)
        if (preview) run.result = clip(preview, RUN_RESULT_MAX_CHARS)
        if (status !== 'completed') run.error ??= clip(noticeError(text), ROW_TEXT_MAX_CHARS)
        if (run.children.size === 1) {
          const only = [...run.children.values()][0]!
          if (isTerminalStatus(status)) setChildStatus(only, status)
          if (preview && !only.result) only.result = clip(preview, ROW_TEXT_MAX_CHARS)
          if (status !== 'completed' && run.error) only.error ??= run.error
        }
      }
      this.resolveSessionIds(run)
      changed.add(run.toolCallId)
    }
    return [...changed]
  }

  private onChildNotice(details: JsonRecord, text: string): string[] {
    const key = str(details.childKey)
    const workflowRunId = workflowRunIdOf(text)
    const childRunId = childRunIdOf(text)
    const anchor =
      (workflowRunId && this.anchorByRunId.get(workflowRunId)) || (childRunId && this.anchorByRunId.get(childRunId))
    const run = anchor ? this.runs.get(anchor) : undefined
    if (!run || !key) return []
    const child = this.childFor(run, { workflowKey: key, runId: childRunId })
    if (!child) return []
    const outcome = normalizeRunStatus(details.outcome) ?? (str(details.outcome) ? 'completed' : undefined)
    if (outcome) setChildStatus(child, outcome)
    if (childRunId) {
      child.runId ??= childRunId
      this.claimRunId(childRunId, run.toolCallId)
    }
    const error = noticeError(text)
    if (error && outcome !== 'completed') child.error = clip(error, ROW_TEXT_MAX_CHARS)
    return [run.toolCallId]
  }

  private onSupervisorRequest(details: JsonRecord): string[] {
    const runId = str(details.runId)
    const anchor = runId ? this.anchorByRunId.get(runId) : undefined
    const run = anchor ? this.runs.get(anchor) : undefined
    if (!run) return []
    const requestId = str(details.requestId) ?? str(details.id)
    const question = str(details.requestBody)
    if (!question) return []
    const childIndex = num(details.childIndex)
    const child =
      this.childFor(run, {
        runId: runId !== run.runId ? runId : undefined,
        index: childIndex,
        agent: str(details.agent)
      }) ?? [...run.children.values()][0]
    if (!child) return []
    if (requestId && child.exchanges.some(x => x.requestId === requestId)) return []
    child.exchanges.push({ requestId, question: clip(question, ROW_TEXT_MAX_CHARS)! })
    if (requestId) this.anchorByRequest.set(requestId, run.toolCallId)
    return [run.toolCallId]
  }

  // ── Snapshots ──────────────────────────────────────────────────────────

  snapshot(toolCallId: string): SubagentRunSnapshot | undefined {
    const run = this.runs.get(toolCallId)
    if (!run) return undefined
    const children = [...run.children.values()].map(child => childRow(child))
    const only = children.length === 1 ? children[0] : undefined
    const agents = agentsOfArgs(run.args)
    const childAgents = children.map(c => c.agent).filter((x): x is string => Boolean(x))
    const label =
      str(run.args.agent) ??
      (childAgents.length && childAgents.every(a => a === childAgents[0]) ? childAgents[0]! : run.mode)
    const runActivity =
      run.currentTool || run.lastActivityAt
        ? compact({ currentTool: run.currentTool, lastActivityAt: run.lastActivityAt })
        : undefined
    return compact({
      version: LIVE_VERSION,
      toolCallId,
      runId: run.runId,
      mode: run.mode,
      async: run.async,
      status: run.status,
      agent: label,
      agents: agents.length > 1 ? agents : undefined,
      task: clip(run.task, ROW_TEXT_MAX_CHARS),
      startedAt: run.startedAt,
      endedAt: isTerminalStatus(run.status) ? run.endedAt : undefined,
      durationMs: run.durationMs,
      tokens: run.tokens ?? sumDefined(children.map(c => c.tokens)),
      toolCount: run.toolCount,
      turnCount: run.turnCount,
      activity: isTerminalStatus(run.status) ? undefined : runActivity,
      result: run.result,
      error: run.error,
      sessionFile: only?.sessionFile,
      sessionId: only?.sessionId,
      asyncDir: run.asyncDir,
      children
    })
  }

  /** The anchor's ACP turn (the turn its tool call started in). */
  turnSeqOf(toolCallId: string): number | undefined {
    return this.runs.get(toolCallId)?.turnSeq
  }

  statusOf(toolCallId: string): RunStatus | undefined {
    return this.runs.get(toolCallId)?.status
  }

  /** Async runs that are not finished yet (for keep-alive and Stop). */
  activeAsyncAnchors(): string[] {
    return [...this.runs.values()].filter(r => r.async && !isTerminalStatus(r.status)).map(r => r.toolCallId)
  }

  runIdOf(toolCallId: string): string | undefined {
    return this.runs.get(toolCallId)?.runId
  }

  asyncDirOf(toolCallId: string): string | undefined {
    return this.runs.get(toolCallId)?.asyncDir
  }

  /** Every anchor, in launch order (replay reads them all at the end). */
  anchors(): string[] {
    return [...this.runs.keys()]
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private claimRunId(runId: string, toolCallId: string): void {
    if (!this.anchorByRunId.has(runId)) this.anchorByRunId.set(runId, toolCallId)
  }

  private settle(run: RunState, status: RunStatus): void {
    this.setStatus(run, status)
    if (!isTerminalStatus(run.status)) return
    run.currentTool = undefined
    for (const child of run.children.values()) {
      if (!isTerminalStatus(child.status)) {
        // A run that ended takes its unsettled children with it; a failed run
        // does not make children that never said so failed.
        setChildStatus(child, run.status === 'completed' ? 'completed' : 'stopped')
      }
      child.currentTool = undefined
    }
  }

  private setStatus(run: RunState, status: RunStatus): void {
    if (isTerminalStatus(run.status) && !isTerminalStatus(status)) return
    if (run.status === status) return
    run.status = status
    if (isTerminalStatus(status)) run.endedAt ??= this.now()
  }

  /** Apply a `subagent` result's or partial result's `details`. */
  private applyDetails(run: RunState, d: JsonRecord, final: boolean): void {
    const mode = str(d.mode)
    if (mode && mode !== 'management') run.mode = mode
    const runId = str(d.runId)
    if (runId) {
      run.runId ??= runId
      this.claimRunId(runId, run.toolCallId)
    }
    const asyncId = str(d.asyncId)
    if (asyncId) this.claimRunId(asyncId, run.toolCallId)
    run.asyncDir = str(d.asyncDir) ?? run.asyncDir
    const wc = isRecord(d.workflowChildren) ? d.workflowChildren : undefined
    if (wc) {
      const workflowRunId = str(wc.workflowRunId)
      if (workflowRunId) this.claimRunId(workflowRunId, run.toolCallId)
      for (const c of Array.isArray(wc.children) ? wc.children.filter(isRecord) : []) {
        const child = this.childFor(run, { workflowKey: str(c.childId), runId: str(c.runId), agent: str(c.agent) })
        if (!child) continue
        child.agent ??= str(c.agent)
        child.model = str(c.model) ?? child.model
        child.thinking = str(c.thinking) ?? child.thinking
        const s = normalizeRunStatus(c.state)
        if (s) setChildStatus(child, s)
        const childRunId = str(c.runId)
        if (childRunId) {
          child.runId ??= childRunId
          this.claimRunId(childRunId, run.toolCallId)
        }
        const activity = isRecord(c.activity) ? c.activity : undefined
        if (activity) applyActivity(child, activity)
      }
      const workflowState = normalizeRunStatus(wc.workflowState)
      if (workflowState && (final || !isTerminalStatus(workflowState))) {
        if (!run.async || isTerminalStatus(workflowState)) this.setStatus(run, workflowState)
      }
    }
    const progress = Array.isArray(d.progress) ? d.progress.filter(isRecord) : []
    progress.forEach((p, position) => {
      const index = num(p.index) ?? position
      const child = this.childFor(run, { index, agent: str(p.agent), workflowKey: str(p.workflowKey) })
      if (!child) return
      child.agent ??= str(p.agent)
      const s = normalizeRunStatus(p.status)
      if (s) setChildStatus(child, s)
      child.task ??= clip(str(p.task), ROW_TEXT_MAX_CHARS)
      child.model = str(p.model) ?? child.model
      child.thinking = str(p.thinking) ?? child.thinking
      child.currentTool = isTerminalStatus(child.status) ? undefined : str(p.currentTool)
      child.toolCount = num(p.toolCount) ?? child.toolCount
      child.turnCount = num(p.turnCount) ?? child.turnCount
      child.tokens = num(p.tokens) ?? child.tokens
      child.durationMs = num(p.durationMs) ?? child.durationMs
      child.lastActivityAt = num(p.lastActivityAt) ?? child.lastActivityAt
      child.progressText = str(p.progressText) ?? child.progressText
      if (str(p.error)) child.error = clip(str(p.error), ROW_TEXT_MAX_CHARS)
    })
    const results = Array.isArray(d.results) ? d.results.filter(isRecord) : []
    results.forEach((r, position) => {
      const index = num(r.index) ?? position
      const child = this.childFor(run, {
        index,
        workflowKey: str(r.workflowKey),
        runId: str(r.runId),
        agent: str(r.agent)
      })
      if (!child) return
      child.agent ??= str(r.agent)
      child.task ??= clip(str(r.task), ROW_TEXT_MAX_CHARS)
      const childRunId = str(r.runId)
      if (childRunId) {
        child.runId ??= childRunId
        this.claimRunId(childRunId, run.toolCallId)
      }
      child.model = str(r.model) ?? child.model
      child.thinking = str(r.thinking) ?? child.thinking
      child.sessionFile = str(r.sessionFile) ?? child.sessionFile
      const tokens = usageTokens(r.usage)
      if (tokens !== undefined) child.tokens = tokens
      const turns = isRecord(r.usage) ? num(r.usage.turns) : undefined
      if (turns !== undefined) child.turnCount = turns
      const output = str(r.finalOutput)
      if (output) child.result = clip(output.trim(), ROW_TEXT_MAX_CHARS)
      const error = str(r.error)
      if (error) child.error = clip(error, ROW_TEXT_MAX_CHARS)
      const progressRecord = isRecord(r.progress) ? r.progress : undefined
      if (progressRecord) child.durationMs = num(progressRecord.durationMs) ?? child.durationMs
      if (final || r.detached !== true) {
        const failed = r.exitCode !== undefined && r.exitCode !== 0
        const status: RunStatus | undefined =
          r.stopped === true ? 'stopped' : failed || error ? 'failed' : num(r.exitCode) === 0 ? 'completed' : undefined
        if (status) setChildStatus(child, status)
      }
      child.currentTool = undefined
    })
    const total = usageTokens(d.totalChildUsage)
    if (total !== undefined) run.tokens = total
    this.resolveSessionIds(run)
  }

  private applyWidgetRun(run: RunState, node: JsonRecord): boolean {
    const state = normalizeRunStatus(node.state)
    if (state) this.setStatus(run, state)
    run.startedAt = num(node.startedAt) ?? run.startedAt
    if (isTerminalStatus(run.status)) run.endedAt = num(node.endedAt) ?? run.endedAt
    if (run.endedAt && run.startedAt && isTerminalStatus(run.status) && run.durationMs === undefined) {
      run.durationMs = run.endedAt - run.startedAt
    }
    const activity = isRecord(node.activity) ? node.activity : undefined
    if (activity) {
      run.currentTool = isTerminalStatus(run.status) ? undefined : str(activity.currentTool)
      run.toolCount = num(activity.toolCount) ?? run.toolCount
      run.turnCount = num(activity.turnCount) ?? run.turnCount
      run.lastActivityAt = num(activity.lastActivityAt) ?? run.lastActivityAt
    }
    const nodes = Array.isArray(node.children) ? node.children.filter(isRecord) : []
    nodes.forEach((childNode, position) => {
      if (childNode.kind === 'host-step') return
      // A step node's id is its workflow key, its run id, or `step:<index>`.
      const id = str(childNode.id)
      const stepMatch = id ? /^step:(\d+)$/.exec(id) : null
      const stepIndex = stepMatch ? Number(stepMatch[1]) : undefined
      const isRunNode = childNode.kind === 'subagent' || childNode.kind === 'workflow'
      const runIdRef = id && (isRunNode || looksLikeRunId(id)) ? id : undefined
      const child = this.childFor(run, {
        index: stepIndex ?? (run.mode === 'workflow' ? undefined : position),
        workflowKey: stepIndex === undefined && !runIdRef ? id : undefined,
        runId: runIdRef,
        agent: str(childNode.agent) ?? str(childNode.label)
      })
      if (!child) return
      child.agent ??= str(childNode.agent)
      const s = normalizeRunStatus(childNode.state)
      if (s) setChildStatus(child, s)
      child.model = str(childNode.model) ?? child.model
      child.thinking = str(childNode.thinking) ?? child.thinking
      child.startedAt = num(childNode.startedAt) ?? child.startedAt
      if (isTerminalStatus(child.status)) child.endedAt = num(childNode.endedAt) ?? child.endedAt
      if (child.endedAt && child.startedAt && isTerminalStatus(child.status)) {
        child.durationMs ??= child.endedAt - child.startedAt
      }
      child.progressText = str(childNode.progressText) ?? child.progressText
      const a = isRecord(childNode.activity) ? childNode.activity : undefined
      if (a) applyActivity(child, a)
      if (isTerminalStatus(child.status)) child.currentTool = undefined
    })
    this.resolveSessionIds(run)
    return true
  }

  /**
   * The row for a child described by any of the ids pi-subagents uses for it.
   * Rows are keyed like codeg's history fold: the workflow key when there is
   * one, else `#<index>`.
   */
  private childFor(
    run: RunState,
    ref: { workflowKey?: string; childId?: string; runId?: string; index?: number; agent?: string }
  ): ChildState | undefined {
    const byKey = (key: string | undefined) => (key ? run.children.get(key) : undefined)
    const workflowKey = ref.workflowKey ?? ref.childId
    let child = byKey(workflowKey)
    if (!child && ref.runId) child = [...run.children.values()].find(c => c.runId === ref.runId)
    if (!child && ref.index !== undefined && !workflowKey) child = byKey(`#${ref.index}`)
    if (!child && run.children.size === 1 && run.mode !== 'workflow' && !workflowKey) {
      child = [...run.children.values()][0]
    }
    if (child) return child
    const key = workflowKey ?? (ref.index !== undefined ? `#${ref.index}` : ref.runId)
    if (!key) return undefined
    const created: ChildState = {
      key,
      agent: ref.agent,
      status: 'pending',
      runId: ref.runId,
      index: ref.index,
      exchanges: []
    }
    run.children.set(key, created)
    return created
  }

  private resolveSessionIds(run: RunState): void {
    if (!this.sessionIdOf) return
    for (const child of run.children.values()) {
      if (child.sessionFile && !child.sessionId) child.sessionId = this.sessionIdOf(child.sessionFile)
    }
  }
}

function seedChildren(run: RunState): void {
  const args = run.args
  if (run.mode === 'single') {
    run.children.set('#0', {
      key: '#0',
      agent: str(args.agent),
      task: clip(str(args.task), ROW_TEXT_MAX_CHARS),
      status: 'pending',
      index: 0,
      exchanges: []
    })
    return
  }
  const items = run.mode === 'parallel' ? args.tasks : run.mode === 'chain' ? args.chain : undefined
  if (!Array.isArray(items)) return
  items.forEach((item, index) => {
    const r: JsonRecord = isRecord(item) ? item : {}
    run.children.set(`#${index}`, {
      key: `#${index}`,
      agent: str(r.agent),
      task: clip(str(r.task), ROW_TEXT_MAX_CHARS),
      status: 'pending',
      index,
      exchanges: []
    })
  })
}

function agentsOfArgs(args: JsonRecord): string[] {
  const agents: string[] = []
  const agent = str(args.agent)
  if (agent) agents.push(agent)
  for (const key of ['tasks', 'chain'] as const) {
    const items = args[key]
    if (!Array.isArray(items)) continue
    for (const item of items) {
      const a = isRecord(item) ? str(item.agent) : undefined
      if (a) agents.push(a)
    }
  }
  return agents
}

function foregroundStatus(run: RunState, details: JsonRecord | undefined): RunStatus {
  const wc = details && isRecord(details.workflowChildren) ? details.workflowChildren : undefined
  const workflowState = wc ? normalizeRunStatus(wc.workflowState) : undefined
  if (workflowState && isTerminalStatus(workflowState)) return workflowState
  if (details?.stopped === true) return 'stopped'
  if (details?.timedOut === true) return 'failed'
  // As codeg's history fold decides: failed only when every child failed.
  const children = [...run.children.values()]
  if (children.length && children.every(c => c.status === 'failed')) return 'failed'
  return 'completed'
}

function setChildStatus(child: ChildState, status: RunStatus): void {
  if (isTerminalStatus(child.status) && !isTerminalStatus(status)) return
  child.status = status
}

function applyActivity(child: ChildState, activity: JsonRecord): void {
  child.currentTool = str(activity.currentTool)
  child.toolCount = num(activity.toolCount) ?? child.toolCount
  child.turnCount = num(activity.turnCount) ?? child.turnCount
  child.lastActivityAt = num(activity.lastActivityAt) ?? child.lastActivityAt
}

function childRow(child: ChildState): ChildRow {
  const unanswered = child.exchanges.filter(x => !x.answer).map(x => x.question)
  const terminal = isTerminalStatus(child.status)
  // Turns are `turns` on the row (as on the history card); activity is what changes while it runs.
  const activity =
    !terminal && (child.currentTool || child.toolCount !== undefined || child.lastActivityAt)
      ? compact({
          currentTool: child.currentTool,
          toolCount: child.toolCount,
          lastActivityAt: child.lastActivityAt
        })
      : undefined
  return compact({
    key: child.key,
    label: child.key.startsWith('#') ? (child.agent ?? 'sub-agent') : child.key,
    agent: child.agent,
    status: child.status,
    runId: child.runId,
    task: child.task,
    model: child.model,
    thinking: child.thinking,
    activity,
    progressText: terminal ? undefined : child.progressText,
    startedAt: child.startedAt,
    endedAt: terminal ? child.endedAt : undefined,
    durationMs: child.durationMs,
    tokens: child.tokens,
    turns: child.turnCount,
    sessionFile: child.sessionFile,
    sessionId: child.sessionId,
    error: child.error,
    result: child.result,
    exchanges: child.exchanges.length ? child.exchanges.map(x => compact({ ...x })) : undefined,
    attention: unanswered.length && !terminal ? unanswered : undefined
  })
}

/** pi's own token total: input + output + cache read + cache write. */
function usageTokens(usage: unknown): number | undefined {
  if (!isRecord(usage)) return undefined
  const total = ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((sum, key) => sum + (num(usage[key]) ?? 0), 0)
  return total > 0 ? total : undefined
}

function tokenTotal(tokens: unknown): number | undefined {
  if (typeof tokens === 'number') return tokens
  if (!isRecord(tokens)) return undefined
  return num(tokens.total) ?? usageTokens(tokens)
}

function modelName(step: JsonRecord): string | undefined {
  const resolved = isRecord(step.resolvedModel) ? step.resolvedModel : undefined
  if (resolved && str(resolved.provider) && str(resolved.model)) return `${resolved.provider}/${resolved.model}`
  return str(step.model)
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  const known = values.filter((v): v is number => typeof v === 'number')
  return known.length ? known.reduce((a, b) => a + b, 0) : undefined
}

function looksLikeRunId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

function workflowRunIdOf(text: string): string | undefined {
  return /^\s*Workflow run:\s*(\S+)/m.exec(text)?.[1]
}

function childRunIdOf(text: string): string | undefined {
  return /^\s*Child run:\s*(\S+)/m.exec(text)?.[1]
}
