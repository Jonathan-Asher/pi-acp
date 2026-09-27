import test from 'node:test'
import assert from 'node:assert/strict'
import { RequestError } from '@agentclientprotocol/sdk'
import { PiAcpAgent, STEER_METHOD } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function agentWithLiveSession() {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  ;((agent as any).sessions as any).sessions.set('s1', session)
  return { agent, proc, session }
}

const steerParams = (text: string, extra: Record<string, unknown> = {}) => ({
  sessionId: 's1',
  prompt: [{ type: 'text', text }],
  _meta: { steering: { idleBehavior: 'promptRequired' } },
  ...extra
})

test('initialize advertises the steering extension in the top-level _meta', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const res: any = await agent.initialize({ protocolVersion: 1 } as any)
  assert.deepEqual(res._meta?.steering, { supported: true })
  assert.match(String(res.agentInfo?.version), /^\d+\.\d+\.\d+/)
})

test('_session/steering: idle session returns promptRequired', async () => {
  const { agent, proc } = agentWithLiveSession()
  const res = await agent.extMethod(STEER_METHOD, steerParams('note'))
  assert.deepEqual(res, { outcome: 'promptRequired', reason: 'noRunningTurn' })
  assert.equal(proc.steers.length, 0)
})

test('_session/steering: an unknown (not loaded) session is idle', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const res = await agent.extMethod(STEER_METHOD, steerParams('note', { sessionId: 'nope' }))
  assert.deepEqual(res, { outcome: 'promptRequired', reason: 'noRunningTurn' })
})

test('_session/steering: running turn is injected with text and images', async () => {
  const { agent, proc, session } = agentWithLiveSession()
  void session.prompt('task')
  proc.emit({ type: 'agent_start' })

  const res = await agent.extMethod(STEER_METHOD, {
    sessionId: 's1',
    prompt: [
      { type: 'text', text: 'look at ' },
      { type: 'text', text: 'this' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' }
    ],
    _meta: { steering: { idleBehavior: 'promptRequired' } }
  })
  assert.deepEqual(res, { outcome: 'injected' })
  assert.deepEqual(proc.steers, [
    { message: 'look at this', images: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] }
  ])
})

test('_session/steering: rejects malformed params and unknown idle behaviors', async () => {
  const { agent } = agentWithLiveSession()
  await assert.rejects(agent.extMethod(STEER_METHOD, { sessionId: 's1', prompt: [] }), RequestError)
  await assert.rejects(agent.extMethod(STEER_METHOD, { prompt: [{ type: 'text', text: 'x' }] }), RequestError)
  await assert.rejects(
    agent.extMethod(STEER_METHOD, steerParams('x', { _meta: { steering: { idleBehavior: 'startTurn' } } })),
    RequestError
  )
})

test('unknown extension methods are methodNotFound', async () => {
  const { agent } = agentWithLiveSession()
  await assert.rejects(agent.extMethod('_session/nope', {}), (err: any) => err?.code === -32601)
})
