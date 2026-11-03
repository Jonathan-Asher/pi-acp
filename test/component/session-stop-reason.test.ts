import test from 'node:test'
import assert from 'node:assert/strict'
import { RequestError } from '@agentclientprotocol/sdk'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
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

function assistant(stopReason: string, extra: Record<string, unknown> = {}) {
  return { role: 'assistant', content: [], stopReason, ...extra }
}

/** One pi run: an assistant message per entry, then the run ends and pi settles. */
function run(proc: FakePiRpcProcess, ...messages: Array<Record<string, unknown>>) {
  proc.emit({ type: 'agent_start' })
  for (const message of messages) {
    proc.emit({ type: 'message_start', message })
    proc.emit({ type: 'message_end', message })
    proc.emit({ type: 'turn_end', message, toolResults: [] })
  }
  proc.emit({ type: 'agent_end', messages, willRetry: false })
  proc.emit({ type: 'agent_settled' })
}

test('stop reason: a reply cut off by the output limit ends the turn with max_tokens', async () => {
  const { proc, session } = makeSession()
  const turn = session.prompt('think hard')
  run(proc, assistant('length', { content: [{ type: 'thinking', thinking: '...' }] }))
  assert.equal(await turn, 'max_tokens')
})

test('stop reason: a normal reply ends the turn with end_turn', async () => {
  const { proc, session } = makeSession()
  const turn = session.prompt('hello')
  run(proc, assistant('toolUse'), assistant('stop'))
  assert.equal(await turn, 'end_turn')
})

test('stop reason: the last assistant message decides, so a length stop pi recovered from is not reported', async () => {
  const { proc, session } = makeSession()
  const turn = session.prompt('hello')
  // A length stop whose truncated tool call pi failed, then the model answered.
  run(proc, assistant('length'), assistant('stop'))
  assert.equal(await turn, 'end_turn')
})

test('stop reason: a provider error rejects the prompt with pi errorMessage', async () => {
  const { proc, session } = makeSession()
  const turn = session.prompt('hello')
  run(proc, assistant('error', { errorMessage: '500 Internal Server Error' }))
  await assert.rejects(turn, (err: unknown) => {
    assert.ok(err instanceof RequestError)
    assert.equal(err.code, -32603)
    assert.match(err.message, /500 Internal Server Error/)
    return true
  })
})

test('stop reason: an error pi retried successfully ends the turn normally', async () => {
  const { proc, session } = makeSession()
  const turn = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_end', message: assistant('error', { errorMessage: '529 overloaded' }) })
  proc.emit({ type: 'agent_end', messages: [], willRetry: true })
  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: '529 overloaded' })
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_end', message: assistant('stop') })
  proc.emit({ type: 'auto_retry_end', success: true, attempt: 1 })
  proc.emit({ type: 'agent_end', messages: [], willRetry: false })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
})

test('stop reason: a cancel wins over the stop pi reports for the aborted message', async () => {
  const { proc, session } = makeSession()
  const turn = session.prompt('hello')
  await session.cancel()
  run(proc, assistant('aborted', { errorMessage: 'Request was aborted' }))
  assert.equal(await turn, 'cancelled')
})

test('stop reason: a turn without an assistant message does not inherit the previous stop', async () => {
  const { proc, session } = makeSession()
  const first = session.prompt('one')
  run(proc, assistant('length'))
  assert.equal(await first, 'max_tokens')

  // e.g. an extension command that never calls the model
  const second = session.prompt('/ext')
  run(proc)
  assert.equal(await second, 'end_turn')
})

test('stop reason: assistant messages outside a turn are ignored', async () => {
  const { proc, session } = makeSession()
  proc.emit({ type: 'message_end', message: assistant('error', { errorMessage: 'late' }) })
  const turn = session.prompt('hello')
  run(proc)
  assert.equal(await turn, 'end_turn')
})

test('stop reason: a prompt pi refuses rejects with the reason instead of ending silently', async () => {
  const { proc, session } = makeSession()
  proc.promptError = new Error('pi prompt failed: No model selected')
  await assert.rejects(session.prompt('hello'), /pi prompt failed: No model selected/)
})

test('stop reason: the agent answers session/prompt with the mapped stop reason', async () => {
  const { conn, proc, session } = makeSession()
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = { maybeGet: () => session, get: () => session }

  const limited = agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'go' }] } as any)
  await new Promise(resolve => setImmediate(resolve))
  run(proc, assistant('length'))
  assert.deepEqual(await limited, { stopReason: 'max_tokens' })

  const failed = agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'again' }] } as any)
  await new Promise(resolve => setImmediate(resolve))
  run(proc, assistant('error', { errorMessage: 'connection reset' }))
  await assert.rejects(failed, /connection reset/)
})
