/**
 * Fork a pi session file at an exact entry, without a pi process.
 *
 * pi's own RPC forks only "before a user message" (`fork`) or "at the leaf"
 * (`clone`), and only from inside the pi process that has the session open.
 * ACP clients name a fork point by an AGENT message (`ForkPoint`, below), so
 * the RPC route can only land at the end of that reply's turn, and forking a
 * session that is busy in another process means opening its file in a second
 * pi, which may append to it on startup.
 *
 * This module does what pi's `SessionManager.createBranchedSession` does —
 * copy the path from the root to one entry into a new session file — reading
 * the source file and never writing to it. That makes a fork exact at any
 * reply and safe while another process is still appending to the source.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizePiAssistantText } from './translate/pi-messages.js'

/**
 * The fork point an ACP client sends in `_meta["jetbrains.air.fork"]`:
 * `messageId` names an agent message (for pi: the session entry id of an
 * assistant message), `messageFingerprint` is `sha256:<hex>` of that
 * message's text, and `messageOccurrence` the 1-based index among assistant
 * messages on the active branch sharing the fingerprint.
 */
export type ForkPoint = {
  messageId?: string
  messageFingerprint?: string
  messageOccurrence?: number
}

export type SessionEntry = {
  type: string
  id?: string
  parentId?: string | null
  [key: string]: unknown
}

/** A fork point that names nothing in the session. Maps to ACP `invalid_params`. */
export class ForkPointError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ForkPointError'
  }
}

/**
 * Parse a pi session JSONL. Blank and malformed lines are skipped, as pi's
 * own loader does — a session another process is appending to can end in a
 * half-written line.
 */
export function parseSessionJsonl(text: string): { header: SessionEntry | null; entries: SessionEntry[] } {
  let header: SessionEntry | null = null
  const entries: SessionEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as SessionEntry
    if (entry.type === 'session') {
      header ??= entry
      continue
    }
    if (typeof entry.type !== 'string') continue
    entries.push(entry)
  }
  return { header, entries }
}

function indexById(entries: SessionEntry[]): Map<string, SessionEntry> {
  const byId = new Map<string, SessionEntry>()
  for (const entry of entries) {
    if (typeof entry.id === 'string') byId.set(entry.id, entry)
  }
  return byId
}

/** The path from the root to `fromId`, root first — pi's `getBranch`. */
function branchTo(fromId: string, byId: Map<string, SessionEntry>): SessionEntry[] {
  const path: SessionEntry[] = []
  const seen = new Set<string>()
  let current = byId.get(fromId)
  while (current && typeof current.id === 'string' && !seen.has(current.id)) {
    seen.add(current.id)
    path.push(current)
    current = typeof current.parentId === 'string' ? byId.get(current.parentId) : undefined
  }
  return path.reverse()
}

/** pi's leaf: the last entry in the file. */
function leafIdOf(entries: SessionEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const id = entries[i]!.id
    if (typeof id === 'string') return id
  }
  return undefined
}

function messageRole(entry: SessionEntry): string | undefined {
  if (entry.type !== 'message') return undefined
  const message = entry.message as { role?: unknown } | undefined
  return typeof message?.role === 'string' ? message.role : undefined
}

function isAssistantMessage(entry: SessionEntry): boolean {
  return messageRole(entry) === 'assistant'
}

/**
 * Whether `entry` still belongs to the reply before it: the reply's tool
 * results, and the bookkeeping pi writes between messages (model and thinking
 * level changes, extension state, labels, session info, compaction and branch
 * summaries). The next user, assistant, `!command` or extension message is
 * where the reply ends.
 */
function belongsToPrecedingReply(entry: SessionEntry): boolean {
  if (entry.type === 'message') return messageRole(entry) === 'toolResult'
  return entry.type !== 'custom_message' && entry.type !== 'session'
}

function fingerprintOf(entry: SessionEntry): string {
  const message = entry.message as { content?: unknown } | undefined
  const text = normalizePiAssistantText(message?.content)
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/**
 * The id of the assistant message a fork point names, or a `ForkPointError`.
 *
 * `messageId` wins when it is an assistant message anywhere in the session.
 * Otherwise the fingerprint picks the `messageOccurrence`-th assistant message
 * on the active branch whose text hashes to it — the same text and count the
 * client fingerprinted from its own transcript.
 */
export function resolveForkTarget(entries: SessionEntry[], point: ForkPoint): string {
  const byId = indexById(entries)
  if (point.messageId) {
    const named = byId.get(point.messageId)
    if (named && isAssistantMessage(named)) return point.messageId
  }

  const fingerprint = point.messageFingerprint ?? ''
  if (fingerprint.startsWith('sha256:')) {
    const occurrence = Math.max(1, Math.trunc(point.messageOccurrence ?? 1))
    const leafId = leafIdOf(entries)
    const path = leafId ? branchTo(leafId, byId) : []
    let seen = 0
    for (const entry of path) {
      if (!isAssistantMessage(entry) || fingerprintOf(entry) !== fingerprint) continue
      seen++
      if (seen === occurrence) return entry.id as string
    }
  }

  throw new ForkPointError('the fork point names no reply in this session')
}

/**
 * Where a fork aimed at the reply `targetId` ends: the reply itself plus
 * what belongs to it ({@link belongsToPrecedingReply}) — its tool results
 * above all, since a session that ends on a tool call with no result is one
 * the provider refuses to continue.
 *
 * Followed along the active branch when the reply is on it; otherwise along
 * the most recently written child, the branch pi itself would have been on.
 */
export function forkEndId(entries: SessionEntry[], targetId: string): string {
  const byId = indexById(entries)
  const leafId = leafIdOf(entries)
  const activePath = leafId ? branchTo(leafId, byId) : []
  const onActive = activePath.findIndex(entry => entry.id === targetId)

  let next: (id: string) => SessionEntry | undefined
  if (onActive >= 0) {
    const position = new Map(activePath.map((entry, i) => [entry.id as string, i]))
    next = id => activePath[(position.get(id) ?? -2) + 1]
  } else {
    const lastChild = new Map<string, SessionEntry>()
    for (const entry of entries) {
      if (typeof entry.parentId === 'string' && typeof entry.id === 'string') lastChild.set(entry.parentId, entry)
    }
    next = id => lastChild.get(id)
  }

  let endId = targetId
  const seen = new Set<string>([targetId])
  for (let entry = next(endId); entry && belongsToPrecedingReply(entry); entry = next(endId)) {
    if (typeof entry.id !== 'string' || seen.has(entry.id)) break
    seen.add(entry.id)
    endId = entry.id
  }
  return endId
}

/** A time-ordered session id, the kind pi gives its own sessions (UUID v7). */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16)
  let ts = BigInt(now)
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn)
    ts >>= 8n
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f)
  bytes[8] = 0x80 | (bytes[8]! & 0x3f)
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function shortId(taken: Set<string>): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8)
    if (!taken.has(id)) return id
  }
  return randomUUID()
}

/**
 * The entries of a new session holding the path from the root to `leafId` —
 * a port of pi's `createBranchedSession`: label entries are taken out of the
 * path (re-chaining what followed them) and re-created after it for the
 * entries that kept a label.
 */
export function buildBranchedSession(opts: {
  header: SessionEntry | null
  entries: SessionEntry[]
  leafId: string
  sessionId: string
  timestamp: string
  cwd: string
  parentSession: string
}): SessionEntry[] {
  const byId = indexById(opts.entries)
  const path = branchTo(opts.leafId, byId)
  if (path.length === 0) throw new ForkPointError(`entry ${opts.leafId} is not in this session`)

  const kept: SessionEntry[] = []
  const replacementByLabelId = new Map<string, string>()
  const pendingLabelIds: string[] = []
  let parentId: string | null = null
  for (const entry of path) {
    if (entry.type === 'label') {
      pendingLabelIds.push(entry.id as string)
      continue
    }
    for (const labelId of pendingLabelIds) replacementByLabelId.set(labelId, entry.id as string)
    pendingLabelIds.length = 0
    const firstKept = entry.firstKeptEntryId
    kept.push(
      entry.type === 'compaction' && typeof firstKept === 'string'
        ? { ...entry, parentId, firstKeptEntryId: replacementByLabelId.get(firstKept) ?? firstKept }
        : { ...entry, parentId }
    )
    parentId = entry.id as string
  }

  // Labels as pi resolves them: the last label entry per target wins, and an
  // empty one removes it.
  const labels = new Map<string, { label: unknown; timestamp: unknown }>()
  for (const entry of opts.entries) {
    if (entry.type !== 'label' || typeof entry.targetId !== 'string') continue
    if (entry.label) labels.set(entry.targetId, { label: entry.label, timestamp: entry.timestamp })
    else labels.delete(entry.targetId)
  }
  const taken = new Set(kept.map(entry => entry.id as string))
  const labelEntries: SessionEntry[] = []
  for (const [targetId, { label, timestamp }] of labels) {
    if (!taken.has(targetId)) continue
    const id = shortId(taken)
    taken.add(id)
    labelEntries.push({ type: 'label', id, parentId, timestamp, targetId, label })
    parentId = id
  }

  const header: SessionEntry = {
    type: 'session',
    version: typeof opts.header?.version === 'number' ? opts.header.version : 3,
    id: opts.sessionId,
    timestamp: opts.timestamp,
    cwd: opts.cwd,
    parentSession: opts.parentSession
  }
  return [header, ...kept, ...labelEntries]
}

export type ForkedSessionFile = {
  sessionId: string
  sessionFile: string
  cwd: string
  /** The last entry the fork kept. */
  leafId: string
}

/**
 * Fork the session in `sessionFile` at `point` into a new file next to it.
 * No `point` forks at the leaf (pi's `clone`). The source file is only read.
 */
export function forkSessionFile(opts: {
  sessionFile: string
  point?: ForkPoint
  cwd: string
  now?: Date
}): ForkedSessionFile {
  if (!existsSync(opts.sessionFile)) {
    throw new ForkPointError('the session has no file yet; wait for its first reply')
  }
  const { header, entries } = parseSessionJsonl(readFileSync(opts.sessionFile, 'utf8'))
  if (!entries.some(entry => typeof entry.id === 'string')) {
    throw new ForkPointError('this session predates entry ids; open it in pi once to upgrade it')
  }

  const leafId = opts.point ? forkEndId(entries, resolveForkTarget(entries, opts.point)) : (leafIdOf(entries) as string)

  const now = opts.now ?? new Date()
  const timestamp = now.toISOString()
  const sessionId = uuidv7(now.getTime())
  const cwd = typeof header?.cwd === 'string' && header.cwd ? header.cwd : opts.cwd
  const sessionFile = join(dirname(opts.sessionFile), `${timestamp.replace(/[:.]/g, '-')}_${sessionId}.jsonl`)

  const lines = buildBranchedSession({
    header,
    entries,
    leafId,
    sessionId,
    timestamp,
    cwd,
    parentSession: opts.sessionFile
  })
  writeFileSync(sessionFile, lines.map(entry => `${JSON.stringify(entry)}\n`).join(''), { flag: 'wx' })
  return { sessionId, sessionFile, cwd, leafId }
}
