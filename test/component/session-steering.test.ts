import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession, type StopReason } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession() {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  return { conn, proc, session }
}

/** Track a prompt promise so a test can assert it is still in flight. */
function track(p: Promise<StopReason>) {
  const state: { settled: boolean; reason?: StopReason } = { settled: false }
  void p.then(r => {
    state.settled = true
    state.reason = r
  })
  return state
}

const tick = () => new Promise(resolve => setImmediate(resolve))

async function settle(proc: FakePiRpcProcess) {
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  await tick()
  await tick()
}

test('steer: idle session answers promptRequired without touching pi', async () => {
  const { proc, session } = makeSession()

  assert.equal(await session.steer('hello', [], { promptRequired: true }), 'promptRequired')
  assert.equal(proc.steers.length, 0)
  assert.equal(proc.prompts.length, 0)
})

test('steer: idle session without the opt-in starts a turn of its own', async () => {
  const { proc, session } = makeSession()

  assert.equal(await session.steer('hello'), 'startedNewTurn')
  assert.equal(proc.steers.length, 0)
  assert.deepEqual(
    proc.prompts.map(p => p.message),
    ['hello']
  )
})

test('steer: a running turn gets the message injected and stays in flight until pi processed it', async () => {
  const { proc, session } = makeSession()

  const turn = track(session.prompt('do a multi-step task'))
  proc.emit({ type: 'agent_start' })

  assert.equal(await session.steer('also check the tests', [], { promptRequired: true }), 'injected')
  assert.deepEqual(proc.steers, [{ message: 'also check the tests', images: [] }])

  // pi hands the message to the model after the current tool calls.
  proc.emit({ type: 'turn_end' })
  assert.equal(proc.deliverSteer(), 'also check the tests')
  proc.emit({ type: 'turn_end' })
  await tick()
  assert.equal(turn.settled, false, 'the owning session/prompt must not resolve before agent_settled')

  await settle(proc)
  assert.equal(turn.settled, true)
  assert.equal(turn.reason, 'end_turn')
  // Nothing was parked, so no queue surgery and no extra turn.
  assert.equal(proc.clearQueueCount, 0)
  assert.equal(proc.prompts.length, 1)
})

test('steer race: a message pi parked after its last queue check runs in the same turn', async () => {
  const { proc, session } = makeSession()

  const turn = track(session.prompt('task'))
  proc.emit({ type: 'agent_start' })
  assert.equal(await session.steer('late note', [], { promptRequired: true }), 'injected')

  // pi's loop already finished: it settles with the steer still queued.
  await settle(proc)

  assert.equal(proc.clearQueueCount, 1, 'the parked message is taken out of pi')
  assert.deepEqual(proc.steeringQueue, [], 'nothing is left parked in pi')
  assert.deepEqual(
    proc.prompts.map(p => p.message),
    ['task', 'late note'],
    'the parked message continues the turn'
  )
  assert.equal(turn.settled, false, 'the turn stays open for the continuation')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'late note' }] } })
  await settle(proc)
  assert.equal(turn.settled, true)
  assert.equal(turn.reason, 'end_turn')
  assert.equal(proc.prompts.length, 2)
})

test('steer race: a steer still on the wire when pi settles is waited for, then continued', async () => {
  const { proc, session } = makeSession()

  const turn = track(session.prompt('task'))
  proc.emit({ type: 'agent_start' })

  let release!: () => void
  proc.steerGate = new Promise<void>(resolve => (release = resolve))
  const outcome = session.steer('racing note', [], { promptRequired: true })

  // pi settles before it reads the steer command.
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  await tick()
  assert.equal(turn.settled, false, 'must not resolve while a steer is unacknowledged')

  // pi now reads the steer: it lands in the (idle) queue.
  release()
  assert.equal(await outcome, 'injected')
  await tick()
  await tick()

  assert.equal(proc.clearQueueCount, 1)
  assert.deepEqual(proc.steeringQueue, [])
  assert.deepEqual(
    proc.prompts.map(p => p.message),
    ['task', 'racing note']
  )
  assert.equal(turn.settled, false)

  proc.emit({ type: 'agent_start' })
  await settle(proc)
  assert.equal(turn.reason, 'end_turn')
})

test('steer race: parked messages keep their images and their order', async () => {
  const { proc, session } = makeSession()
  const img = { type: 'image', mimeType: 'image/png', data: 'AAAA' }

  const turn = track(session.prompt('task'))
  proc.emit({ type: 'agent_start' })
  assert.equal(await session.steer('first', [img], { promptRequired: true }), 'injected')
  assert.equal(await session.steer('second', [], { promptRequired: true }), 'injected')

  await settle(proc)

  assert.deepEqual(proc.prompts[1], { message: 'first', attachments: [img] })
  // The rest go back in as steering for the continued run.
  assert.deepEqual(proc.steers.at(-1), { message: 'second', images: [] })
  assert.deepEqual(proc.steeringQueue, ['second'])

  proc.emit({ type: 'agent_start' })
  proc.deliverSteer()
  await settle(proc)
  assert.equal(turn.reason, 'end_turn')
  assert.equal(proc.prompts.length, 2)
})

test('steer: refused while the turn is settling', async () => {
  const { proc, session } = makeSession()

  const turn = session.prompt('task')
  proc.emit({ type: 'agent_start' })

  let release!: () => void
  proc.steerGate = new Promise<void>(resolve => (release = resolve))
  const first = session.steer('in flight', [], { promptRequired: true })
  proc.emit({ type: 'agent_settled' })

  // pi already settled: a new steer must not be accepted into the ending turn.
  proc.steerGate = null
  assert.equal(await session.steer('too late', [], { promptRequired: true }), 'promptRequired')

  release()
  assert.equal(await first, 'injected')
  await tick()
  await tick()
  proc.emit({ type: 'agent_start' })
  await settle(proc)
  assert.equal(await turn, 'end_turn')
  assert.deepEqual(
    proc.steers.map(s => s.message),
    ['in flight']
  )
})

test('steer: pi refusing the message reports promptRequired (not consumed)', async () => {
  const { proc, session } = makeSession()

  const turn = session.prompt('task')
  proc.emit({ type: 'agent_start' })
  proc.steerError = new Error('Extension command "/foo" cannot be queued')

  assert.equal(await session.steer('/foo', [], { promptRequired: true }), 'promptRequired')
  assert.deepEqual(proc.steeringQueue, [])

  await settle(proc)
  assert.equal(await turn, 'end_turn')
  assert.equal(proc.clearQueueCount, 0)
})

test('steer: cancel empties pi queue before aborting so nothing runs after the stop', async () => {
  const { proc, session } = makeSession()

  const turn = session.prompt('task')
  proc.emit({ type: 'agent_start' })
  assert.equal(await session.steer('note', [], { promptRequired: true }), 'injected')

  await session.cancel()
  assert.equal(proc.clearQueueCount, 1)
  assert.equal(proc.abortCount, 1)
  assert.deepEqual(proc.steeringQueue, [])

  // After cancel, steering is refused.
  assert.equal(await session.steer('after stop', [], { promptRequired: true }), 'promptRequired')

  await settle(proc)
  assert.equal(await turn, 'cancelled')
  assert.equal(proc.prompts.length, 1, 'no continuation after a cancel')
})

test('steer: a steer accepted before pi refuses the prompt does not leak into the next turn', async () => {
  const { proc, session } = makeSession()

  let rejectPrompt!: (e: Error) => void
  proc.prompt = async (message: string, attachments: unknown[] = []) => {
    proc.prompts.push({ message, attachments })
    await new Promise<void>((_, reject) => (rejectPrompt = reject))
  }

  const turn = session.prompt('task')
  assert.equal(await session.steer('note', [], { promptRequired: true }), 'injected')
  rejectPrompt(new Error('pi prompt failed: no model'))

  assert.equal(await turn, 'error')
  assert.equal(proc.clearQueueCount, 1)
  assert.deepEqual(proc.steeringQueue, [])
})
