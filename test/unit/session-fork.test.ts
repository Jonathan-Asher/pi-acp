import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ForkPointError,
  buildBranchedSession,
  forkEndId,
  forkSessionFile,
  parseSessionJsonl,
  resolveForkTarget,
  uuidv7,
  type SessionEntry
} from '../../src/acp/session-fork.js'
import { PiAcpAgent, readForkPoint } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

const fp = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`

function msg(id: string, parentId: string | null, role: string, content: unknown, extra: object = {}): SessionEntry {
  return { type: 'message', id, parentId, timestamp: '2026-10-21T00:00:00.000Z', message: { role, content, ...extra } }
}
const text = (t: string) => [{ type: 'text', text: t }]

/**
 * u1 → a1 → u2 → a2 (tool call) → r2 → mc (model change) → a3 → u3 → a4
 * Two turns after the first, the second with a tool round trip.
 */
function linearSession(): SessionEntry[] {
  return [
    msg('u1', null, 'user', text('first')),
    msg('a1', 'u1', 'assistant', text('answer one')),
    msg('u2', 'a1', 'user', text('second')),
    msg('a2', 'u2', 'assistant', [
      { type: 'text', text: 'let me look' },
      { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }
    ]),
    msg('r2', 'a2', 'toolResult', text('ok'), { toolCallId: 'c1' }),
    { type: 'model_change', id: 'mc', parentId: 'r2', provider: 'p', modelId: 'm' },
    msg('a3', 'mc', 'assistant', text('done')),
    msg('u3', 'a3', 'user', text('third')),
    msg('a4', 'u3', 'assistant', text('answer one'))
  ]
}

const jsonl = (header: object, entries: SessionEntry[]) =>
  [header, ...entries].map(e => JSON.stringify(e)).join('\n') + '\n'

test('session-fork: parse skips blank, torn and non-object lines', () => {
  const raw = '{"type":"session","id":"s","version":3}\n\n{"type":"message","id":"a"}\n{"type":"mess'
  const { header, entries } = parseSessionJsonl(raw)
  assert.equal(header?.id, 's')
  assert.deepEqual(
    entries.map(e => e.id),
    ['a']
  )
})

test('session-fork: messageId names an assistant entry exactly', () => {
  assert.equal(resolveForkTarget(linearSession(), { messageId: 'a2' }), 'a2')
})

test('session-fork: a messageId that is not an assistant entry falls through to the fingerprint', () => {
  const entries = linearSession()
  assert.equal(resolveForkTarget(entries, { messageId: 'u2', messageFingerprint: fp('done') }), 'a3')
  assert.equal(resolveForkTarget(entries, { messageId: 'turn-5', messageFingerprint: fp('done') }), 'a3')
})

test('session-fork: fingerprint occurrence counts repeated answers on the active branch', () => {
  const entries = linearSession()
  assert.equal(resolveForkTarget(entries, { messageFingerprint: fp('answer one') }), 'a1')
  assert.equal(resolveForkTarget(entries, { messageFingerprint: fp('answer one'), messageOccurrence: 2 }), 'a4')
})

test('session-fork: an unresolvable point is refused, never forked at the tail', () => {
  const entries = linearSession()
  assert.throws(() => resolveForkTarget(entries, { messageId: 'nope' }), ForkPointError)
  assert.throws(() => resolveForkTarget(entries, { messageFingerprint: fp('never said') }), ForkPointError)
  assert.throws(
    () => resolveForkTarget(entries, { messageFingerprint: fp('answer one'), messageOccurrence: 3 }),
    ForkPointError
  )
})

test('session-fork: the fork keeps the reply tool results and settings, and stops at the next message', () => {
  const entries = linearSession()
  // The reply before u2: exactly a1, as pi's own fork-before-u2 would keep.
  assert.equal(forkEndId(entries, 'a1'), 'a1')
  // A reply that called a tool keeps its result and the model change after it.
  assert.equal(forkEndId(entries, 'a2'), 'mc')
  assert.equal(forkEndId(entries, 'a4'), 'a4')
})

test('session-fork: an off-branch reply ends along its most recent child', () => {
  // a1 has two children: u2 (old branch) and u2b (active); fork the old branch's reply.
  const entries: SessionEntry[] = [
    msg('u1', null, 'user', text('q')),
    msg('a1', 'u1', 'assistant', text('a')),
    msg('u2', 'a1', 'user', text('old')),
    msg('a2', 'u2', 'assistant', [{ type: 'toolCall', id: 'c', name: 'read', arguments: {} }]),
    msg('r2', 'a2', 'toolResult', text('x')),
    msg('u2b', 'a1', 'user', text('new')),
    msg('a2b', 'u2b', 'assistant', text('b'))
  ]
  assert.equal(forkEndId(entries, 'a2'), 'r2')
})

test('session-fork: branched session re-chains around labels and re-creates kept labels', () => {
  const entries: SessionEntry[] = [
    msg('u1', null, 'user', text('q')),
    { type: 'label', id: 'l1', parentId: 'u1', targetId: 'u1', label: 'start', timestamp: 't1' },
    msg('a1', 'l1', 'assistant', text('a')),
    { type: 'compaction', id: 'c1', parentId: 'a1', firstKeptEntryId: 'l1', summary: 's' },
    { type: 'label', id: 'l2', parentId: 'c1', targetId: 'zz', label: 'gone', timestamp: 't2' }
  ]
  const out = buildBranchedSession({
    header: { type: 'session', version: 3, id: 'old' },
    entries,
    leafId: 'c1',
    sessionId: 'new-id',
    timestamp: '2026-10-21T00:00:00.000Z',
    cwd: '/w',
    parentSession: '/s/old.jsonl'
  })
  assert.deepEqual(out[0], {
    type: 'session',
    version: 3,
    id: 'new-id',
    timestamp: '2026-10-21T00:00:00.000Z',
    cwd: '/w',
    parentSession: '/s/old.jsonl'
  })
  const body = out.slice(1)
  assert.deepEqual(
    body.map(e => [e.id, e.parentId]),
    [
      ['u1', null],
      ['a1', 'u1'],
      ['c1', 'a1'],
      [body[3]!.id, 'c1']
    ]
  )
  assert.equal(body[2]!.firstKeptEntryId, 'a1')
  assert.equal(body[3]!.type, 'label')
  assert.equal(body[3]!.targetId, 'u1')
  assert.equal(body[3]!.label, 'start')
})

test('session-fork: uuidv7 is time ordered and well formed', () => {
  const a = uuidv7(1_700_000_000_000)
  const b = uuidv7(1_700_000_000_001)
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.ok(a < b)
})

test('session-fork: forkSessionFile writes a sibling file and leaves the source untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-fork-'))
  const source = join(dir, '2026-10-21T00-00-00-000Z_src.jsonl')
  const raw = jsonl({ type: 'session', version: 3, id: 'src', timestamp: 't', cwd: '/proj' }, linearSession())
  writeFileSync(source, raw + '{"type":"message","id":"torn"', 'utf8')
  const before = readFileSync(source, 'utf8')

  const forked = forkSessionFile({ sessionFile: source, point: { messageId: 'a1' }, cwd: '/elsewhere' })
  assert.equal(readFileSync(source, 'utf8'), before)
  assert.equal(forked.leafId, 'a1')
  assert.equal(forked.cwd, '/proj')
  assert.ok(forked.sessionFile.startsWith(dir))
  assert.ok(forked.sessionFile.endsWith(`_${forked.sessionId}.jsonl`))

  const { header, entries } = parseSessionJsonl(readFileSync(forked.sessionFile, 'utf8'))
  assert.equal(header?.id, forked.sessionId)
  assert.equal(header?.parentSession, source)
  assert.deepEqual(
    entries.map(e => e.id),
    ['u1', 'a1']
  )

  // No point: the whole active branch, like pi's clone.
  const tail = forkSessionFile({ sessionFile: source, cwd: '/proj' })
  assert.equal(tail.leafId, 'a4')
  assert.equal(readdirSync(dir).length, 3)
})

test('session-fork: forkSessionFile refuses a missing file and a point it cannot name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-fork-miss-'))
  assert.throws(() => forkSessionFile({ sessionFile: join(dir, 'none.jsonl'), cwd: '/p' }), ForkPointError)
  const source = join(dir, 's.jsonl')
  writeFileSync(source, jsonl({ type: 'session', version: 3, id: 's', cwd: '/p' }, linearSession()))
  assert.throws(
    () =>
      forkSessionFile({ sessionFile: source, point: { messageId: 'x', messageFingerprint: fp('nope') }, cwd: '/p' }),
    ForkPointError
  )
  assert.equal(readdirSync(dir).length, 1)
})

test('readForkPoint: reads the AIR fork block, nested or flat, and nothing else', () => {
  assert.equal(readForkPoint({}), undefined)
  assert.equal(readForkPoint({ _meta: { other: 1 } }), undefined)
  assert.deepEqual(
    readForkPoint({ _meta: { jetbrains: { air: { fork: { messageId: 'a1', messageOccurrence: 2 } } } } }),
    {
      messageId: 'a1',
      messageFingerprint: undefined,
      messageOccurrence: 2
    }
  )
  assert.deepEqual(readForkPoint({ _meta: { 'jetbrains.air.fork': { messageFingerprint: 'sha256:00' } } }), {
    messageId: undefined,
    messageFingerprint: 'sha256:00',
    messageOccurrence: undefined
  })
})

test('PiAcpAgent: initialize advertises strict, while-running forks', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const res: any = await agent.initialize({ protocolVersion: 1 } as any)
  assert.deepEqual(res._meta.forkPoint, { strict: true, whileRunning: true })
  assert.deepEqual(res.agentCapabilities.sessionCapabilities.fork, {})
})

test('PiAcpAgent: unstable_forkSession refuses an unresolvable point with invalid_params and writes nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-fork-agent-'))
  const dir = join(root, 'sessions', '--proj--')
  mkdirSync(dir, { recursive: true })
  const source = join(dir, 's.jsonl')
  writeFileSync(source, jsonl({ type: 'session', version: 3, id: 'src', cwd: '/proj' }, linearSession()))

  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).store = {
    get: (id: string) => (id === 'src' ? { sessionId: id, cwd: '/proj', sessionFile: source } : null),
    upsert() {
      throw new Error('must not register a fork that failed')
    },
    delete() {}
  }
  await assert.rejects(
    agent.unstable_forkSession({
      sessionId: 'src',
      cwd: '/proj',
      _meta: { jetbrains: { air: { fork: { version: 1, messageId: 'turn-9' } } } }
    } as any),
    (e: any) => e?.code === -32602
  )
  assert.deepEqual(readdirSync(dir), ['s.jsonl'])
})
