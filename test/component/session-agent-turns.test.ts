import test from 'node:test'
import assert from 'node:assert/strict'
import type { StopReason } from '@agentclientprotocol/sdk'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession(features = { asyncTasks: false }) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    features
  })
  return { conn, proc, session }
}

const tick = () => new Promise(resolve => setImmediate(resolve))
// Announcements held for a settling prompt go out on a timer.
const settleTicks = async () => {
  for (let i = 0; i < 5; i += 1) await tick()
  await new Promise(resolve => setTimeout(resolve, 5))
  for (let i = 0; i < 5; i += 1) await tick()
}

function track(p: Promise<StopReason>) {
  const state: { settled: boolean; reason?: StopReason; error?: unknown } = { settled: false }
  void p.then(
    r => {
      state.settled = true
      state.reason = r
    },
    e => {
      state.settled = true
      state.error = e
    }
  )
  return state
}

const updates = (conn: FakeAgentSideConnection) => conn.updates.map(u => u.update as any)
const piAcp = (conn: FakeAgentSideConnection) =>
  updates(conn)
    .filter(u => u.sessionUpdate === 'session_info_update')
    .map(u => u._meta?.piAcp ?? {})
const agentTurns = (conn: FakeAgentSideConnection) =>
  piAcp(conn)
    .filter(m => m.agentTurn)
    .map(m => m.agentTurn)
const notices = (conn: FakeAgentSideConnection) =>
  piAcp(conn)
    .filter(m => m.customMessage)
    .map(m => m.customMessage)

const hiddenCompletion = {
  role: 'custom',
  customType: 'subagent-notify',
  content:
    'Background task completed: **scout**\n\nscout:\nNumber of entries: **0**\n\nParent action: Read the saved results above.',
  display: false,
  details: { runs: [{ agent: 'scout', status: 'completed', runId: 'run-1', durationMs: 2659 }] },
  timestamp: 1794501876288
}

const assistant = (stopReason: string, text = '') => ({
  role: 'assistant',
  content: text ? [{ type: 'text', text }] : [],
  stopReason
})

/** pi wakes itself with `message` (a run with no prompt in flight). */
function wake(proc: FakePiRpcProcess, message: Record<string, unknown> = hiddenCompletion) {
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_start', message })
  proc.emit({ type: 'message_end', message })
}

function finishRun(proc: FakePiRpcProcess, stopReason = 'stop', aborted = false) {
  const reply = assistant(stopReason, 'All done.')
  proc.emit({ type: 'message_start', message: reply })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'All done.' } })
  proc.emit({ type: 'message_end', message: reply })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled', aborted })
}

test('agent turn: a hidden sub-agent completion that wakes pi opens a turn with its reason and ends it', async () => {
  const { conn, proc } = makeSession()

  wake(proc)
  finishRun(proc)
  await settleTicks()

  const turns = agentTurns(conn)
  assert.equal(turns.length, 2)
  const [running, ended] = turns
  assert.equal(running.state, 'running')
  assert.match(running.id, /^pi-turn-/)
  assert.deepEqual(running.trigger, {
    kind: 'subagentSettled',
    reason: 'Woken by sub-agent completion',
    customType: 'subagent-notify',
    hidden: true,
    summary: 'scout completed'
  })
  assert.equal(ended.id, running.id)
  assert.equal(ended.state, 'ended')
  assert.equal(ended.endReason, 'settled')
  assert.equal(ended.stopReason, 'end_turn')

  // The hidden notice itself is forwarded, marked hidden, inside the turn.
  const [notice] = notices(conn)
  assert.equal(notice.customType, 'subagent-notify')
  assert.equal(notice.hidden, true)
  assert.equal(notice.display, false)
  assert.deepEqual(notice.details, hiddenCompletion.details)
  assert.equal(notice.agentTurnId, running.id)

  // Order: turn start, notice, the reply, turn end.
  const all = updates(conn)
  const at = (pred: (u: any) => boolean) => all.findIndex(pred)
  const iStart = at(u => u._meta?.piAcp?.agentTurn?.state === 'running')
  const iNotice = at(u => u._meta?.piAcp?.customMessage)
  const iReply = at(u => u.sessionUpdate === 'agent_message_chunk' && u.content?.text === 'All done.')
  const iEnd = at(u => u._meta?.piAcp?.agentTurn?.state === 'ended')
  assert.ok(iStart < iNotice && iNotice < iReply && iReply < iEnd, `order ${iStart} ${iNotice} ${iReply} ${iEnd}`)
})

test('agent turn: a job exit that wakes pi says so, and pi stop reasons carry over', async () => {
  const { conn, proc } = makeSession()
  wake(proc, {
    role: 'custom',
    customType: 'bg-job-exit',
    content: '[bg-jobs] Background job jb-1 completed (exit 0) after 4s.',
    display: true,
    details: { v: 1, id: 'jb-1', toolCallId: 'call-bg', state: 'completed', exitCode: 0 }
  })
  finishRun(proc, 'length')
  await settleTicks()

  const [running, ended] = agentTurns(conn)
  assert.equal(running.trigger.kind, 'jobExit')
  assert.equal(running.trigger.reason, 'Woken by job exit')
  assert.deepEqual(running.trigger.toolCallIds, ['call-bg'])
  assert.equal(ended.stopReason, 'max_tokens')
})

test('agent turn: Stop (session/cancel) aborts it and it ends cancelled', async () => {
  const { conn, proc, session } = makeSession()
  wake(proc)
  await tick()

  await session.cancel()
  assert.equal(proc.abortCount, 1)
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled', aborted: true })
  await settleTicks()

  const ended = agentTurns(conn).at(-1)
  assert.equal(ended.state, 'ended')
  assert.equal(ended.endReason, 'cancelled')
  assert.equal(ended.stopReason, 'cancelled')

  // The cancel does not leak into the next turn pi starts by itself.
  wake(proc)
  finishRun(proc)
  await settleTicks()
  assert.equal(agentTurns(conn).at(-1).stopReason, 'end_turn')
})

test('agent turn: a prompt sent meanwhile joins the run (as a steer) and owns it until pi settles', async () => {
  const { conn, proc, session } = makeSession()
  wake(proc)
  await tick()

  proc.dispositions = ['queued']
  const turn = track(session.prompt('what happened?'))
  await settleTicks()

  assert.deepEqual(proc.prompts.at(-1), { message: 'what happened?', attachments: [] })
  assert.deepEqual(proc.promptOptions.at(-1), { streamingBehavior: 'steer' })
  const ended = agentTurns(conn).at(-1)
  assert.equal(ended.state, 'ended')
  assert.equal(ended.endReason, 'promptJoined')
  assert.equal(turn.settled, false)

  // pi delivers the message; it is the client's, not an extension's.
  const user = { role: 'user', content: [{ type: 'text', text: 'what happened?' }] }
  proc.emit({ type: 'message_start', message: user })
  proc.emit({ type: 'message_end', message: user })
  finishRun(proc)
  await settleTicks()

  assert.equal(turn.reason, 'end_turn')
  assert.equal(notices(conn).filter(n => n.customType === 'injected-user').length, 0)
  assert.equal(agentTurns(conn).length, 2, 'no second agent turn')
})

test('agent turn: a prompt that reaches pi just as it settles runs as that prompt’s turn', async () => {
  const { conn, proc, session } = makeSession()
  wake(proc)
  await tick()

  let release!: () => void
  const gate = new Promise<void>(resolve => (release = resolve))
  const original = proc.prompt.bind(proc)
  let calls = 0
  proc.prompt = async (message: string, attachments: unknown[] = [], opts = {}) => {
    calls += 1
    if (calls > 1) return original(message, attachments, opts)
    proc.prompts.push({ message, attachments })
    proc.promptOptions.push(opts)
    await gate
    // pi had finished its loop: the steer is parked in its queue.
    proc.steeringQueue.push(message)
    proc.emit({ type: 'queue_update', steering: [...proc.steeringQueue], followUp: [] })
    return 'queued'
  }

  const turn = track(session.prompt('late question'))
  finishRun(proc)
  await settleTicks()
  assert.equal(turn.settled, false)

  release()
  await settleTicks()
  assert.equal(proc.clearQueueCount, 1, 'the parked message is taken back out of pi')
  assert.deepEqual(
    proc.prompts.map(p => p.message),
    ['late question', 'late question']
  )
  assert.equal(agentTurns(conn).at(-1).endReason, 'promptJoined')
  assert.equal(turn.settled, false, 'the continuation keeps the prompt open')

  proc.emit({ type: 'agent_start' })
  finishRun(proc)
  await settleTicks()
  assert.equal(turn.reason, 'end_turn')
})

test('agent turn: an extension command sent meanwhile runs beside it', async () => {
  const { conn, proc, session } = makeSession()
  wake(proc)
  await tick()

  proc.dispositions = ['handled']
  assert.equal(await session.prompt('/jobs'), 'end_turn')
  assert.equal(agentTurns(conn).length, 1, 'the agent turn goes on')

  finishRun(proc)
  await settleTicks()
  assert.equal(agentTurns(conn).at(-1).endReason, 'settled')
})

test('agent turn: steering joins it (injected) and pi settles it once', async () => {
  const { conn, proc, session } = makeSession()
  wake(proc)
  await tick()

  assert.equal(await session.steer('also check the tests', [], { promptRequired: true }), 'injected')
  assert.equal(proc.deliverSteer(), 'also check the tests')
  proc.emit({
    type: 'message_end',
    message: { role: 'user', content: [{ type: 'text', text: 'also check the tests' }] }
  })
  finishRun(proc)
  await settleTicks()

  const turns = agentTurns(conn)
  assert.deepEqual(
    turns.map(t => t.state),
    ['running', 'ended']
  )
  assert.equal(notices(conn).filter(n => n.customType === 'injected-user').length, 0)
})

test('agent turn: a run pi starts while the prompt settles is announced after the prompt’s answer', async () => {
  const { conn, proc, session } = makeSession()
  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_end', message: assistant('length') })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  // pi runs a notice it deferred until it settled.
  wake(proc)

  let answeredAt = -1
  const reason = await p.then(r => {
    answeredAt = conn.updates.length
    return r
  })
  assert.equal(reason, 'max_tokens', 'the new run does not change the prompt’s stop reason')
  await settleTicks()

  const all = updates(conn)
  const iStart = all.findIndex(u => u._meta?.piAcp?.agentTurn?.state === 'running')
  const iNotice = all.findIndex(u => u._meta?.piAcp?.customMessage)
  assert.ok(iStart >= answeredAt, 'announced after the prompt answer')
  assert.ok(iNotice > iStart, 'the new run’s notice follows its announcement')

  finishRun(proc)
  await settleTicks()
  assert.equal(agentTurns(conn).at(-1).endReason, 'settled')
})

test('agent turn: an injected user message (an extension’s, or an old bg-jobs report) is a notice, not the user', async () => {
  const { conn, proc } = makeSession()
  const report = {
    role: 'user',
    content: '✅ Background job finished (exit 0, ran 3m 52s)\n[jb-old] completed exit 0 · 3m 52s · make'
  }
  wake(proc, report)
  finishRun(proc)
  await settleTicks()

  const [running] = agentTurns(conn)
  assert.equal(running.trigger.kind, 'jobExit')
  const [notice] = notices(conn)
  assert.equal(notice.customType, 'injected-user')
  assert.equal(notice.role, 'user')
  assert.deepEqual(notice.details, {
    legacyJobReport: { jobId: 'jb-old', state: 'completed', summary: 'exit 0, ran 3m 52s' }
  })
})

test('agent turn: the AIR client gets it as a stoppable "turn" task, and Stop interrupts it', async () => {
  const { conn, proc, session } = makeSession({ asyncTasks: true })
  wake(proc)
  await tick()

  const spawned = updates(conn).find(u => u.sessionUpdate === 'async_task_spawned')
  assert.ok(spawned)
  assert.equal(spawned.taskType, 'turn')
  assert.equal(spawned.name, 'Pi is working')
  assert.equal(spawned.description, 'Woken by sub-agent completion: scout completed')
  assert.equal(spawned.canStop, true)
  assert.equal(spawned.showInTranscript, false)

  assert.deepEqual(await session.stopAsyncTask(spawned.asyncTaskId), { stopped: true })
  assert.equal(proc.abortCount, 1)
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled', aborted: true })
  await settleTicks()

  const state = updates(conn).find(u => u.sessionUpdate === 'async_task_state_update')
  assert.deepEqual(state, {
    sessionUpdate: 'async_task_state_update',
    asyncTaskId: spawned.asyncTaskId,
    state: 'stopped'
  })
})

test('agent turn: no AIR frames for a client that did not ask for them', async () => {
  const { conn, proc } = makeSession()
  wake(proc)
  finishRun(proc)
  await settleTicks()
  assert.equal(updates(conn).filter(u => String(u.sessionUpdate).startsWith('async_task')).length, 0)
})

test('agent turn: the pi process exiting ends the turn and answers a waiting prompt', async () => {
  const { conn, proc, session } = makeSession()
  const turn = track(session.prompt('hello'))
  proc.emit({ type: 'agent_start' })
  proc.exit(1)
  await settleTicks()
  assert.ok(turn.error instanceof Error)
  assert.match(String((turn.error as Error).message), /pi exited/)

  const other = makeSession()
  wake(other.proc)
  await tick()
  other.proc.exit(null, 'SIGTERM')
  await settleTicks()
  const ended = agentTurns(other.conn).at(-1)
  assert.equal(ended.endReason, 'processExited')
  assert.equal(ended.stopReason, 'error')
  void conn
})
