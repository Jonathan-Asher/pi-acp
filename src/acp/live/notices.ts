/**
 * Extension notices: the `custom` messages pi extensions add to the
 * conversation (pi-subagents' completion and supervisor notices, pi-bg-jobs'
 * exit notices, ...) and the plain user messages older pi-bg-jobs builds used
 * instead. They are addressed to the model; this module classifies them so the
 * client can fold them into the card of the work they report on.
 */
import { contentText, firstLine, isRecord, str, type JsonRecord } from './wire.js'

/**
 * Why pi started a run by itself, by the message that started it. The same
 * kinds codeg's history parser gives its "woken by" markers
 * (`codeg.agentWake.triggers[].kind`).
 */
export type TriggerKind =
  | 'subagentSettled'
  | 'subagentQuestion'
  | 'subagentAttention'
  | 'jobExit'
  | 'injectedUser'
  | 'extension'
  | 'unknown'

/** `customType` given to a user message an extension sent (not the client). */
export const INJECTED_USER_TYPE = 'injected-user'

export const SUBAGENT_NOTIFY = 'subagent-notify'
export const SUBAGENT_CHILD_NOTIFY = 'subagent-incremental-child-notify'
export const SUPERVISOR_REQUEST = 'subagent_supervisor_request'
export const SUPERVISOR_REPLY = 'subagent_supervisor_reply'
export const BG_JOB_EXIT = 'bg-job-exit'

export function triggerKindOf(customType: string): TriggerKind {
  switch (customType) {
    case SUPERVISOR_REQUEST:
      return 'subagentQuestion'
    case SUBAGENT_NOTIFY:
    case SUBAGENT_CHILD_NOTIFY:
      return 'subagentSettled'
    case BG_JOB_EXIT:
      return 'jobExit'
    case INJECTED_USER_TYPE:
      return 'injectedUser'
    default:
      return customType.startsWith('subagent') ? 'subagentAttention' : 'extension'
  }
}

/** The one-line reason a client shows on a turn pi started by itself. */
export function wakeReason(kind: TriggerKind): string {
  switch (kind) {
    case 'subagentSettled':
      return 'Woken by sub-agent completion'
    case 'subagentQuestion':
      return "Woken by a sub-agent's question"
    case 'subagentAttention':
      return 'Woken by a sub-agent alert'
    case 'jobExit':
      return 'Woken by job exit'
    case 'injectedUser':
    case 'extension':
      return 'Woken by an extension message'
    default:
      return 'Started by pi'
  }
}

/** A plain user message from a pi-bg-jobs build that predates `bg-job-exit` notices. */
export type LegacyJobReport = { jobId: string; state: 'completed' | 'killed' | 'failed'; summary: string }

const LEGACY_JOB_REPORT =
  /^\s*(?:✅|🛑|❌)\s*Background job (finished|killed|FAILED) \(([^)]*)\)\s*\n\[([A-Za-z0-9_.-]+)\] /

export function legacyJobReport(text: string): LegacyJobReport | null {
  const m = LEGACY_JOB_REPORT.exec(text)
  if (!m) return null
  const verb = m[1]
  return {
    jobId: m[3]!,
    state: verb === 'finished' ? 'completed' : verb === 'killed' ? 'killed' : 'failed',
    summary: m[2]!
  }
}

/** Every run id a pi-subagents notice names in its `details` (and, failing that, its text). */
export function noticeRunIds(customType: string, details: unknown, text: string): string[] {
  const ids = new Set<string>()
  if (isRecord(details)) {
    const runs = Array.isArray(details.runs) ? details.runs : []
    for (const run of runs) {
      if (!isRecord(run)) continue
      for (const key of ['runId', 'workflowRunId'] as const) {
        const id = str(run[key])
        if (id) ids.add(id)
      }
      for (const child of Array.isArray(run.childRuns) ? run.childRuns : []) {
        const id = isRecord(child) ? str(child.runId) : undefined
        if (id && id !== 'unavailable') ids.add(id)
      }
    }
    const runId = str(details.runId)
    if (runId) ids.add(runId)
  }
  if (customType === SUBAGENT_CHILD_NOTIFY || ids.size === 0) {
    for (const label of ['Workflow run:', 'Child run:', 'Run:']) {
      const id = labeledWord(text, label)
      if (id) ids.add(id)
    }
  }
  return [...ids]
}

/** The first word after `label` at the start of a line. */
export function labeledWord(text: string, label: string): string | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(label)) continue
    const word = trimmed.slice(label.length).trim().split(/\s+/)[0]
    if (word) return word.replace(/[.,;]+$/, '')
  }
  return undefined
}

/** A short, human summary of a notice, for a turn's "woken by" line. */
export function noticeSummary(customType: string, details: unknown, text: string): string {
  const d: JsonRecord = isRecord(details) ? details : {}
  switch (customType) {
    case SUBAGENT_NOTIFY: {
      const runs = (Array.isArray(d.runs) ? d.runs : []).filter(isRecord)
      const parts = runs.map(run => `${str(run.agent) ?? 'sub-agent'} ${str(run.status) ?? 'finished'}`)
      if (parts.length) return parts.join(', ')
      break
    }
    case SUBAGENT_CHILD_NOTIFY: {
      const key = str(d.childKey)
      const outcome = str(d.outcome)
      if (key) return `${key} ${outcome ?? 'settled'}`
      break
    }
    case SUPERVISOR_REQUEST: {
      const agent = str(d.agent) ?? 'a sub-agent'
      const body = str(d.requestBody)
      return body ? `${agent} asks: ${firstLine(body, 140)}` : `${agent} asks for a decision`
    }
    case BG_JOB_EXIT: {
      const id = str(d.id) ?? 'job'
      const state = str(d.state) ?? 'ended'
      const code = typeof d.exitCode === 'number' ? ` (exit ${d.exitCode})` : ''
      return `${id} ${state}${code}`
    }
    case INJECTED_USER_TYPE: {
      const report = legacyJobReport(text)
      if (report) return `${report.jobId} ${report.state}`
      break
    }
  }
  return firstLine(text.replace(/\*\*/g, ''), 160)
}

/**
 * The run's own output from a `subagent-notify` text, without the header line,
 * the paths pi-subagents lists after it, and the instructions for the model.
 */
export function noticeResultPreview(text: string): string | undefined {
  const lines = text.split('\n')
  let start = 0
  if (/^(Background task|Detached foreground task) /.test(lines[0] ?? '')) start = 1
  if ((lines[start] ?? '').startsWith('Workflow receipt: ')) start += 1
  let body = lines.slice(start).join('\n')
  const stops = [
    '\nOutput saved to: ',
    '\nRetention-managed async directory: ',
    '\nSession file: ',
    '\nSession files:',
    '\nChild runs:',
    '\nChild outputs:',
    '\nParent action: '
  ]
  let cut = body.length
  for (const stop of stops) {
    const at = body.indexOf(stop)
    if (at !== -1 && at < cut) cut = at
  }
  body = body.slice(0, cut).trim()
  return body ? body : undefined
}

/** The `Error: ...` line of a pi-subagents notice, if it has one. */
export function noticeError(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('Error: ')) return trimmed.slice('Error: '.length).trim() || undefined
    if (trimmed.startsWith('Error (')) return trimmed.replace(/^Error \([^)]*\):\s*/, '') || undefined
  }
  return undefined
}

export function messageText(message: unknown): string {
  return isRecord(message) ? contentText(message.content) : ''
}
