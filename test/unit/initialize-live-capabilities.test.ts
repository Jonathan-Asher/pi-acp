import test from 'node:test'
import assert from 'node:assert/strict'
import { RequestError } from '@agentclientprotocol/sdk'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('initialize: advertises the live channel next to steering and fork, versioned per shape', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const res = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)
  const meta = res._meta as any
  assert.deepEqual(meta.steering, { supported: true })
  assert.deepEqual(meta.forkPoint, { strict: true, whileRunning: true })
  assert.deepEqual(meta.piAcp.capabilities, {
    version: 1,
    agentTurns: 1,
    customMessages: 1,
    subagents: 1,
    backgroundJobs: 1,
    compaction: 1,
    extensionCommands: 1,
    replay: 1
  })
  assert.equal(meta.jetbrains, undefined, 'no AIR keys for a client that is not AIR')
  assert.equal((agent as any).features.asyncTasks, false)
})

test('initialize: an AIR client with asyncTasks gets the AIR capability and async-task frames', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const res = await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: {
      _meta: { jetbrains: { air: { version: 1, capabilities: ['sessionFailure', 'asyncTasks'] } } }
    }
  } as any)
  assert.deepEqual((res._meta as any).jetbrains, { air: { version: 1, capabilities: ['asyncTasks'] } })
  assert.equal((agent as any).features.asyncTasks, true)
})

test('initialize: an AIR client without asyncTasks gets no async-task frames', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: { _meta: { jetbrains: { air: { version: 1, capabilities: ['sessionFailure'] } } } }
  } as any)
  assert.equal((agent as any).features.asyncTasks, false)
})

test('async task stop: validates its params and answers stopped:false for an unknown session', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  assert.deepEqual(await agent.extMethod('_session/async_task/stop', { sessionId: 'nope', asyncTaskId: 'jb-1' }), {
    stopped: false
  })
  await assert.rejects(agent.extMethod('_session/async_task/stop', { sessionId: 's1' }), (err: unknown) => {
    assert.ok(err instanceof RequestError)
    assert.equal(err.code, -32602)
    return true
  })
})
