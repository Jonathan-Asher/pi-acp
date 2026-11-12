/**
 * `session/load` replay of the live channel: the same `_meta.piAcp` data a
 * client gets live, rebuilt from the transcript, so a reloaded session looks
 * like one that was watched.
 *
 * The transcript (`get_messages`) is run through the same trackers the live
 * path uses; the custom entries of the active branch (`get_entries`: supervisor
 * replies, jobs that ended silently) are folded in afterwards. Sub-agent and
 * job anchors then carry their FINAL card, notices are forwarded as
 * `customMessage` records, and a run pi started by itself is bracketed by
 * `agentTurn` running/ended records, the way codeg's history parser draws its
 * "woken by" marker (a notice that arrived while pi was idle and was answered).
 *
 * Not replayed: the widgets' moment-to-moment activity, AIR tasks (nothing is
 * running), and entries other than `custom` ones.
 */
import { BgJobTracker, JOB_TOOLS } from './live/bg-jobs.js'
import {
  BG_JOB_EXIT,
  INJECTED_USER_TYPE,
  legacyJobReport,
  noticeRunIds,
  noticeSummary,
  triggerKindOf,
  wakeReason,
  type TriggerKind
} from './live/notices.js'
import { SubagentTracker, SUBAGENT_TOOLS } from './live/subagents.js'
import { normalizePiAssistantText, normalizePiMessageText } from './translate/pi-messages.js'
import {
  boundedJson,
  clipText,
  compact,
  contentText,
  isRecord,
  LIVE_VERSION,
  NOTICE_TEXT_MAX_CHARS,
  num,
  str,
  type JsonRecord
} from './live/wire.js'

export type ReplayStep =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'toolResult'; message: JsonRecord; args?: unknown; live?: JsonRecord }
  | { kind: 'info'; meta: JsonRecord }

type AgentTurnReplay = { id: string; startedAt?: number }

/**
 * Plan the replay of `messages` (pi's `get_messages`) with the `custom` entries
 * of the active branch. Steps come out in transcript order.
 */
export function planReplay(
  messages: unknown[],
  customEntries: unknown[] = [],
  opts: { sessionIdOf?: (sessionFile: string) => string | undefined } = {}
): ReplayStep[] {
  let clock = 0
  const subagents = new SubagentTracker({ now: () => clock, sessionIdOf: opts.sessionIdOf })
  const jobs = new BgJobTracker({ now: () => clock })
  const records = messages.filter(isRecord)

  // Pass 1: the tool calls' arguments, and every card's final state.
  const args = new Map<string, { name: string; args: unknown }>()
  for (const m of records) {
    clock = num(m.timestamp) ?? clock
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const block of m.content) {
        if (!isRecord(block) || block.type !== 'toolCall') continue
        const id = str(block.id)
        const name = str(block.name)
        if (!id || !name) continue
        args.set(id, { name, args: block.arguments })
        if (SUBAGENT_TOOLS.has(name)) subagents.onToolStart(id, name, block.arguments, 0)
        else if (JOB_TOOLS.has(name)) jobs.onToolStart(id, name, block.arguments, 0)
      }
    } else if (m.role === 'toolResult') {
      const id = str(m.toolCallId)
      const name = str(m.toolName) ?? args.get(id ?? '')?.name ?? ''
      if (!id) continue
      if (subagents.isAnchor(id)) subagents.onToolEnd(id, m, m.isError === true)
      else if (JOB_TOOLS.has(name)) jobs.onToolEnd(id, name, m, m.isError === true)
    } else if (m.role === 'custom') {
      const customType = str(m.customType) ?? 'custom'
      const text = contentText(m.content)
      subagents.onCustomMessage(customType, m.details, text)
      if (customType === BG_JOB_EXIT) jobs.onExitRecord(m.details, text)
    } else if (m.role === 'user') {
      const text = contentText(m.content)
      const report = legacyJobReport(text)
      if (report) jobs.onLegacyReport(report, text)
    }
  }
  for (const entry of customEntries) {
    if (!isRecord(entry) || entry.type !== 'custom') continue
    const customType = str(entry.customType) ?? 'custom'
    subagents.onCustomEntry(customType, entry.data)
    if (customType === BG_JOB_EXIT) jobs.onExitRecord(entry.data)
  }

  // Pass 2: the steps, with the final cards on the anchors and agent turns
  // around the runs pi started by itself.
  const steps: ReplayStep[] = []
  let runOpen = false
  let agentTurn: AgentTurnReplay | null = null
  let wakes = 0
  const endAgentTurn = (stopReason: string, endReason: string, at?: number) => {
    if (!agentTurn) return
    steps.push({
      kind: 'info',
      meta: {
        agentTurn: compact({
          version: LIVE_VERSION,
          id: agentTurn.id,
          state: 'ended',
          endReason,
          stopReason,
          durationMs: at !== undefined && agentTurn.startedAt !== undefined ? at - agentTurn.startedAt : undefined,
          replay: true
        })
      }
    })
    agentTurn = null
  }

  records.forEach((m, index) => {
    const role = m.role
    const text = contentText(m.content)
    const at = num(m.timestamp)
    const injected = role === 'custom' || (role === 'user' && legacyJobReport(text) !== null)

    if (injected && !runOpen && nextAnswerIsAssistant(records, index)) {
      // pi was idle and this notice woke it.
      runOpen = true
      wakes += 1
      agentTurn = { id: `pi-turn-replay-${wakes}`, startedAt: at }
      steps.push({
        kind: 'info',
        meta: {
          agentTurn: compact({
            version: LIVE_VERSION,
            id: agentTurn.id,
            state: 'running',
            startedAt: at,
            trigger: replayTrigger(m, text, subagents, jobs),
            replay: true
          })
        }
      })
    }

    if (role === 'user') {
      if (injected) {
        const report = legacyJobReport(text)
        const anchor = report ? jobs.anchorForJobId(report.jobId) : undefined
        steps.push({
          kind: 'info',
          meta: {
            customMessage: noticeRecord({
              role: 'user',
              customType: INJECTED_USER_TYPE,
              display: true,
              details: report ? { legacyJobReport: report } : undefined,
              text,
              timestamp: at,
              toolCallIds: anchor ? [anchor] : [],
              agentTurnId: agentTurn?.id
            })
          }
        })
        return
      }
      // The client's own message: a run it starts is not an agent turn.
      endAgentTurn('end_turn', 'promptJoined', at)
      runOpen = true
      const userText = normalizePiMessageText(m.content)
      if (userText) steps.push({ kind: 'user', text: userText })
      return
    }

    if (role === 'custom') {
      const customType = str(m.customType) ?? 'custom'
      steps.push({
        kind: 'info',
        meta: {
          customMessage: noticeRecord({
            role: 'custom',
            customType,
            display: m.display !== false,
            details: m.details,
            text,
            timestamp: at,
            toolCallIds: noticeAnchors(customType, m.details, text, subagents, jobs),
            agentTurnId: agentTurn?.id
          })
        }
      })
      return
    }

    if (role === 'assistant') {
      const assistantText = normalizePiAssistantText(m.content)
      if (assistantText) steps.push({ kind: 'assistant', text: assistantText })
      const callsTools = Array.isArray(m.content) && m.content.some(b => isRecord(b) && b.type === 'toolCall')
      if (!callsTools && m.stopReason !== 'toolUse') {
        runOpen = false
        endAgentTurn(replayStopReason(m.stopReason), m.stopReason === 'aborted' ? 'cancelled' : 'settled', at)
      }
      return
    }

    if (role === 'toolResult') {
      const id = str(m.toolCallId) ?? ''
      const known = args.get(id)
      steps.push({ kind: 'toolResult', message: m, args: known?.args, live: liveMeta(id, subagents, jobs) })
      return
    }

    if (role === 'compactionSummary') {
      steps.push({
        kind: 'info',
        meta: {
          compaction: compact({
            version: LIVE_VERSION,
            id: `pi-compaction-replay-${index}`,
            status: 'completed',
            tokensBefore: num(m.tokensBefore),
            summary: str(m.summary) ? clipText(str(m.summary)!, 8000).text : undefined,
            replay: true
          })
        }
      })
    }
  })
  endAgentTurn('end_turn', 'settled')
  return steps
}

/** The `custom` entries on the branch that ends at `leafId` (all of them without a leaf). */
export function activeBranchCustomEntries(entries: unknown[], leafId: string | null): unknown[] {
  const records = entries.filter(isRecord)
  if (!leafId) return records.filter(e => e.type === 'custom')
  const byId = new Map<string, JsonRecord>()
  for (const e of records) if (typeof e.id === 'string') byId.set(e.id, e)
  const onBranch = new Set<string>()
  let cursor: string | undefined = leafId
  while (cursor && !onBranch.has(cursor)) {
    onBranch.add(cursor)
    const parent: unknown = byId.get(cursor)?.parentId
    cursor = typeof parent === 'string' ? parent : undefined
  }
  return records.filter(e => e.type === 'custom' && typeof e.id === 'string' && onBranch.has(e.id))
}

function liveMeta(toolCallId: string, subagents: SubagentTracker, jobs: BgJobTracker): JsonRecord | undefined {
  const marker = subagents.markerFor(toolCallId)
  if (marker) return compact({ subagent: marker, subagentRun: subagents.snapshot(toolCallId) })
  const job = jobs.snapshot(toolCallId)
  if (job) return { backgroundJob: job }
  const control = jobs.controlFor(toolCallId)
  if (control) return { backgroundJobControl: control }
  return undefined
}

function noticeAnchors(
  customType: string,
  details: unknown,
  text: string,
  subagents: SubagentTracker,
  jobs: BgJobTracker
): string[] {
  const ids = new Set<string>()
  if (customType.startsWith('subagent')) {
    for (const anchor of subagents.anchorsOf(noticeRunIds(customType, details, text))) ids.add(anchor)
  }
  if (customType === BG_JOB_EXIT && isRecord(details)) {
    const jobId = str(details.id)
    const toolCallId = (jobId && jobs.anchorForJobId(jobId)) || str(details.toolCallId)
    if (toolCallId) ids.add(toolCallId)
  }
  return [...ids]
}

function noticeRecord(n: {
  role: 'custom' | 'user'
  customType: string
  display: boolean
  details: unknown
  text: string
  timestamp?: number
  toolCallIds: string[]
  agentTurnId?: string
}): JsonRecord {
  const details = boundedJson(n.details)
  const text = clipText(n.text, NOTICE_TEXT_MAX_CHARS)
  return compact({
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
    agentTurnId: n.agentTurnId,
    replay: true
  })
}

function replayTrigger(m: JsonRecord, text: string, subagents: SubagentTracker, jobs: BgJobTracker): JsonRecord {
  if (m.role === 'user') {
    const report = legacyJobReport(text)
    const anchor = report ? jobs.anchorForJobId(report.jobId) : undefined
    const kind: TriggerKind = report ? 'jobExit' : 'injectedUser'
    return compact({
      kind,
      reason: wakeReason(kind),
      customType: INJECTED_USER_TYPE,
      summary: noticeSummary(INJECTED_USER_TYPE, undefined, text),
      toolCallIds: anchor ? [anchor] : undefined
    })
  }
  const customType = str(m.customType) ?? 'custom'
  const kind = triggerKindOf(customType)
  const toolCallIds = noticeAnchors(customType, m.details, text, subagents, jobs)
  return compact({
    kind,
    reason: wakeReason(kind),
    customType,
    hidden: m.display === false ? true : undefined,
    summary: noticeSummary(customType, m.details, text),
    toolCallIds: toolCallIds.length ? toolCallIds : undefined
  })
}

/** Whether the first message after a run of notices is the assistant's (pi answered them). */
function nextAnswerIsAssistant(records: JsonRecord[], index: number): boolean {
  for (let i = index + 1; i < records.length; i += 1) {
    const r = records[i]!
    if (r.role === 'custom' || r.role === 'system') continue
    if (r.role === 'user' && legacyJobReport(contentText(r.content))) continue
    return r.role === 'assistant'
  }
  return false
}

function replayStopReason(stopReason: unknown): string {
  switch (stopReason) {
    case 'length':
      return 'max_tokens'
    case 'aborted':
      return 'cancelled'
    case 'error':
      return 'error'
    default:
      return 'end_turn'
  }
}
