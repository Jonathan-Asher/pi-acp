/**
 * Live state of pi-bg-jobs jobs, keyed by the `bgj_run` tool call that started
 * each one (the job's anchor).
 *
 * Inputs: the `bgj_run` call and its result (`details {id, pid, logFile,
 * toolCallId}`), what `bgj_status` / `bgj_wait` / `bgj_kill` read back
 * (`details.job` / `details.jobs`), the `bg-jobs` RPC widget
 * (`PI_BG_JOBS_JSON`, sent on every change), and the `bg-job-exit` notice
 * (custom message) or silent record (custom entry). Older pi-bg-jobs builds
 * reported an exit as a plain user message, which is read too.
 *
 * Output: one snapshot per anchor (`_meta.piAcp.backgroundJob`) in the shape of
 * codeg's history card (`codeg.backgroundJob`). Pure, like the sub-agent tracker.
 */
import type { LegacyJobReport } from './notices.js'
import { clip, compact, contentText, firstLine, isRecord, LIVE_VERSION, num, str, type JsonRecord } from './wire.js'

export type JobState = 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'unknown'

export const JOB_TOOLS: ReadonlySet<string> = new Set(['bgj_run', 'bgj_status', 'bgj_wait', 'bgj_kill'])
const COMMAND_MAX_CHARS = 500
const NOTICE_MAX_CHARS = 4000

export function isTerminalJobState(state: JobState): boolean {
  return state === 'completed' || state === 'failed' || state === 'killed' || state === 'unknown'
}

function normalizeJobState(value: unknown): JobState | undefined {
  switch (value) {
    case 'running':
    case 'completed':
    case 'failed':
    case 'killed':
    case 'unknown':
      return value
    default:
      return undefined
  }
}

/** `_meta.piAcp.backgroundJob`: everything a job chip shows, replaced whole on every update. */
export type BackgroundJobSnapshot = {
  version: number
  tool: 'bgj_run'
  toolCallId: string
  id?: string
  state: JobState
  pid?: number
  command?: string
  cwd?: string
  logFile?: string
  startedAt?: number
  exitedAt?: number
  exitCode?: number | null
  exitSignal?: string
  killedBy?: string
  durationMs?: number
  delivery?: string
  consumedBy?: string
  notice?: string
  error?: string
}

/** `_meta.piAcp.backgroundJobControl`: a `bgj_status` / `bgj_wait` / `bgj_kill` call and the job it reads. */
export type BackgroundJobControl = {
  version: number
  tool: string
  id?: string
  anchorToolCallId?: string
}

type Job = Omit<BackgroundJobSnapshot, 'version' | 'tool'> & { turnSeq: number }

export class BgJobTracker {
  private readonly jobs = new Map<string, Job>()
  private readonly anchorByJobId = new Map<string, string>()
  private readonly controls = new Map<string, BackgroundJobControl>()
  private readonly now: () => number

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now
  }

  /** A job tool call started. Returns the anchor's snapshot or a control marker. */
  onToolStart(
    toolCallId: string,
    toolName: string,
    args: unknown,
    turnSeq: number
  ): { job?: BackgroundJobSnapshot; control?: BackgroundJobControl } | undefined {
    if (!JOB_TOOLS.has(toolName)) return undefined
    const a: JsonRecord = isRecord(args) ? args : {}
    if (toolName === 'bgj_run') {
      if (!this.jobs.has(toolCallId)) {
        this.jobs.set(toolCallId, {
          toolCallId,
          turnSeq,
          state: 'pending',
          command: clip(str(a.command), COMMAND_MAX_CHARS),
          cwd: str(a.cwd)
        })
      }
      return { job: this.snapshot(toolCallId) }
    }
    const id = str(a.id)
    const control: BackgroundJobControl = compact({
      version: LIVE_VERSION,
      tool: toolName,
      id,
      anchorToolCallId: id ? this.anchorByJobId.get(id) : undefined
    })
    this.controls.set(toolCallId, control)
    return { control }
  }

  controlFor(toolCallId: string): BackgroundJobControl | undefined {
    return this.controls.get(toolCallId)
  }

  isAnchor(toolCallId: string): boolean {
    return this.jobs.has(toolCallId)
  }

  /** A job tool call returned. Returns the anchors it changed. */
  onToolEnd(toolCallId: string, toolName: string, result: unknown, isError: boolean): string[] {
    const r: JsonRecord = isRecord(result) ? result : {}
    const details = isRecord(r.details) ? r.details : {}
    if (toolName === 'bgj_run') {
      const job = this.jobs.get(toolCallId)
      if (!job) return []
      if (isError || !str(details.id)) {
        job.state = 'failed'
        job.error = firstLine(contentText(r.content), 400) || 'The job did not start'
        return [toolCallId]
      }
      job.id = str(details.id)
      this.anchorByJobId.set(job.id!, toolCallId)
      job.pid = num(details.pid) ?? job.pid
      job.logFile = str(details.logFile) ?? job.logFile
      if (job.state === 'pending') job.state = 'running'
      job.startedAt ??= this.now()
      return [toolCallId]
    }
    if (isError) return []
    const changed = new Set<string>()
    const records = [
      ...(isRecord(details.job) ? [details.job] : []),
      ...(Array.isArray(details.jobs) ? details.jobs.filter(isRecord) : [])
    ]
    for (const record of records) {
      const anchor = this.apply(record)
      if (anchor) changed.add(anchor)
    }
    return [...changed]
  }

  /** A `bg-jobs` widget snapshot (`PI_BG_JOBS_JSON`). Returns the anchors it changed. */
  onWidget(snapshot: unknown, turnSeq: number): string[] {
    const jobs = isRecord(snapshot) && Array.isArray(snapshot.jobs) ? snapshot.jobs.filter(isRecord) : []
    const changed = new Set<string>()
    for (const record of jobs) {
      const anchor = this.apply(record, turnSeq)
      if (anchor) changed.add(anchor)
    }
    return [...changed]
  }

  /** A `bg-job-exit` notice (custom message) or silent record (custom entry). */
  onExitRecord(details: unknown, noticeText?: string): string[] {
    if (!isRecord(details)) return []
    const id = str(details.id)
    const toolCallId = str(details.toolCallId)
    const known =
      (id && this.anchorByJobId.get(id)) || (toolCallId && this.jobs.has(toolCallId) ? toolCallId : undefined)
    const before = known ? JSON.stringify(this.snapshot(known)) : undefined
    const anchor = this.apply({ ...details, exitedAtMs: details.exitedAtMs ?? this.now() }) ?? known
    if (!anchor) return []
    const job = this.jobs.get(anchor)!
    if (noticeText) job.notice = clip(noticeText, NOTICE_MAX_CHARS)
    return JSON.stringify(this.snapshot(anchor)) === before ? [] : [anchor]
  }

  /** An exit reported by an older pi-bg-jobs as a plain user message. */
  onLegacyReport(report: LegacyJobReport, text: string): string[] {
    const anchor = this.anchorByJobId.get(report.jobId)
    const job = anchor ? this.jobs.get(anchor) : undefined
    if (!job) return []
    job.state = report.state
    job.exitedAt ??= this.now()
    const code = /exit (-?\d+)/.exec(report.summary)
    if (code) job.exitCode = Number(code[1])
    job.notice = clip(text, NOTICE_MAX_CHARS)
    return [anchor!]
  }

  anchorForJobId(id: string): string | undefined {
    return this.anchorByJobId.get(id)
  }

  snapshot(toolCallId: string): BackgroundJobSnapshot | undefined {
    const job = this.jobs.get(toolCallId)
    if (!job) return undefined
    const { turnSeq: _turnSeq, ...rest } = job
    void _turnSeq
    const durationMs =
      job.exitedAt !== undefined && job.startedAt !== undefined ? job.exitedAt - job.startedAt : job.durationMs
    return compact({ version: LIVE_VERSION, tool: 'bgj_run' as const, ...rest, durationMs })
  }

  turnSeqOf(toolCallId: string): number | undefined {
    return this.jobs.get(toolCallId)?.turnSeq
  }

  stateOf(toolCallId: string): JobState | undefined {
    return this.jobs.get(toolCallId)?.state
  }

  /** Jobs still running (for keep-alive and Stop). */
  runningAnchors(): string[] {
    return [...this.jobs.values()].filter(j => j.state === 'running').map(j => j.toolCallId)
  }

  anchors(): string[] {
    return [...this.jobs.keys()]
  }

  jobIdOf(toolCallId: string): string | undefined {
    return this.jobs.get(toolCallId)?.id
  }

  /**
   * Merge one job record (pi-bg-jobs' `Job`, a widget row, or notice details)
   * into its anchor. A job this process never saw start is claimed through the
   * `toolCallId` pi-bg-jobs keeps with it, but only while it still runs: an old
   * finished job is history, not news.
   */
  private apply(record: JsonRecord, turnSeq = 0): string | undefined {
    const id = str(record.id)
    const toolCallId = str(record.toolCallId)
    let anchor =
      (id && this.anchorByJobId.get(id)) || (toolCallId && this.jobs.has(toolCallId) ? toolCallId : undefined)
    const state = normalizeJobState(record.state) ?? stateOfRecord(record)
    if (!anchor) {
      if (!toolCallId || !id || !state || isTerminalJobState(state)) return undefined
      this.jobs.set(toolCallId, { toolCallId, turnSeq, state: 'running' })
      anchor = toolCallId
    }
    const job = this.jobs.get(anchor)!
    if (id && !job.id) {
      job.id = id
      this.anchorByJobId.set(id, anchor)
    }
    const before = JSON.stringify(this.snapshot(anchor))
    if (state && !(isTerminalJobState(job.state) && !isTerminalJobState(state))) job.state = state
    job.pid = num(record.pid) ?? job.pid
    job.command = clip(str(record.command), COMMAND_MAX_CHARS) ?? job.command
    job.cwd = str(record.cwd) ?? job.cwd
    job.logFile = str(record.logFile) ?? job.logFile
    job.startedAt = num(record.startedAtMs) ?? job.startedAt
    job.exitedAt = num(record.exitedAtMs) ?? job.exitedAt
    if (record.exitCode === null || typeof record.exitCode === 'number') job.exitCode = record.exitCode as number | null
    job.exitSignal = str(record.exitSignal) ?? job.exitSignal
    job.killedBy = str(record.killedBy) ?? job.killedBy
    job.delivery = str(record.delivery) ?? job.delivery
    job.consumedBy = str(record.consumedBy) ?? job.consumedBy
    job.durationMs = num(record.durationMs) ?? job.durationMs
    return JSON.stringify(this.snapshot(anchor)) === before ? undefined : anchor
  }
}

/** pi-bg-jobs' `jobState`, for a record that carries no `state`. */
function stateOfRecord(record: JsonRecord): JobState | undefined {
  if (record.exitedAtMs === undefined) return record.startedAtMs !== undefined ? 'running' : undefined
  if (str(record.killedBy)) return 'killed'
  if (record.exitCode === 0) return 'completed'
  if (typeof record.exitCode === 'number' || str(record.exitSignal)) return 'failed'
  return 'unknown'
}
