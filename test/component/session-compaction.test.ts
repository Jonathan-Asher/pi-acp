import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession() {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  return { conn, proc }
}

const tick = () => new Promise(resolve => setImmediate(resolve))
const updates = (conn: FakeAgentSideConnection) => conn.updates.map(u => u.update as any)
const texts = (conn: FakeAgentSideConnection) =>
  updates(conn)
    .filter(u => u.sessionUpdate === 'agent_message_chunk')
    .map(u => u.content.text)
const records = (conn: FakeAgentSideConnection) =>
  updates(conn)
    .filter(u => u._meta?.piAcp?.compaction)
    .map(u => u._meta.piAcp.compaction)

test('compaction: pi’s compaction_start / compaction_end (pi 0.85+, 1.x) now reach the client', async () => {
  const { conn, proc } = makeSession()
  proc.emit({ type: 'compaction_start', reason: 'threshold' })
  proc.emit({
    type: 'compaction_end',
    reason: 'threshold',
    result: {
      summary: 'We were fixing the parser.',
      firstKeptEntryId: 'abc',
      tokensBefore: 150000,
      estimatedTokensAfter: 32000,
      details: {}
    },
    aborted: false,
    willRetry: false
  })
  await tick()

  assert.deepEqual(texts(conn), [
    'Context nearing limit, running automatic compaction...',
    'Automatic compaction finished; context was summarized to continue the session.'
  ])
  const [start, end] = records(conn)
  assert.equal(start.status, 'in_progress')
  assert.equal(start.reason, 'threshold')
  assert.equal(end.id, start.id)
  assert.equal(end.status, 'completed')
  assert.equal(end.tokensBefore, 150000)
  assert.equal(end.estimatedTokensAfter, 32000)
  assert.equal(end.summary, 'We were fixing the parser.')
  assert.equal(typeof end.durationMs, 'number')
})

test('compaction: a manual /compact gets the record but not the automatic-compaction sentences', async () => {
  const { conn, proc } = makeSession()
  proc.emit({ type: 'compaction_start', reason: 'manual' })
  proc.emit({
    type: 'compaction_end',
    reason: 'manual',
    result: { summary: 's', tokensBefore: 10 },
    aborted: false,
    willRetry: false
  })
  await tick()
  assert.deepEqual(texts(conn), [])
  assert.deepEqual(
    records(conn).map(r => [r.status, r.reason]),
    [
      ['in_progress', 'manual'],
      ['completed', 'manual']
    ]
  )
})

test('compaction: a failed or aborted compaction is not announced as finished', async () => {
  const { conn, proc } = makeSession()
  proc.emit({ type: 'compaction_start', reason: 'overflow' })
  proc.emit({
    type: 'compaction_end',
    reason: 'overflow',
    aborted: false,
    willRetry: false,
    errorMessage: 'summarizer 503'
  })
  proc.emit({ type: 'compaction_start', reason: 'threshold' })
  proc.emit({ type: 'compaction_end', reason: 'threshold', aborted: true, willRetry: false })
  await tick()
  assert.deepEqual(texts(conn), [
    'Context nearing limit, running automatic compaction...',
    'Context nearing limit, running automatic compaction...'
  ])
  const ends = records(conn).filter(r => r.status !== 'in_progress')
  assert.deepEqual(
    ends.map(r => [r.status, r.errorMessage]),
    [
      ['failed', 'summarizer 503'],
      ['cancelled', undefined]
    ]
  )
})
