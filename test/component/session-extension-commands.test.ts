import test from 'node:test'
import assert from 'node:assert/strict'
import type { StopReason } from '@agentclientprotocol/sdk'
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

const tick = () => new Promise(resolve => setImmediate(resolve))
const updates = (conn: FakeAgentSideConnection) => conn.updates.map(u => u.update as any)

/** pi runs an extension command inside `prompt` and answers `handled` once its handler returned. */
function handleCommandWith(proc: FakePiRpcProcess, during: () => void) {
  proc.prompt = async (message: string, attachments: unknown[] = [], opts = {}) => {
    proc.prompts.push({ message, attachments })
    proc.promptOptions.push(opts)
    during()
    return 'handled'
  }
}

test('extension command: a command pi handled ends the turn (no run, no agent_settled)', async () => {
  const { conn, proc, session } = makeSession()
  handleCommandWith(proc, () =>
    proc.emit({
      type: 'extension_ui_request',
      id: 'n1',
      method: 'notify',
      message: '[jb-1] running · 1m 2s · make',
      notifyType: 'info'
    })
  )

  assert.equal(await session.prompt('/jobs'), 'end_turn')

  // The command's notification is its reply: plain text, not a passing toast.
  const reply = updates(conn).find(u => u.sessionUpdate === 'agent_message_chunk')
  assert.deepEqual(reply, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '[jb-1] running · 1m 2s · make' },
    _meta: { piAcp: { commandReply: { version: 1, command: 'jobs', source: 'notify', level: 'info' } } }
  })

  // The session is idle again: the next prompt starts a turn of its own.
  proc.prompt = FakePiRpcProcess.prototype.prompt.bind(proc)
  const next = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await next, 'end_turn')
})

test('extension command: notifications outside a command stay notifications', async () => {
  const { conn, proc } = makeSession()
  proc.emit({
    type: 'extension_ui_request',
    id: 'n2',
    method: 'notify',
    message: 'MCP: connection failed',
    notifyType: 'error'
  })
  await tick()
  assert.deepEqual(updates(conn)[0]._meta, { piAcp: { notify: { level: 'error' } } })
})

test('extension command: a command that started a run keeps the turn until pi settles', async () => {
  const { proc, session } = makeSession()
  handleCommandWith(proc, () => proc.emit({ type: 'agent_start' }))

  let reason: StopReason | undefined
  const turn = session.prompt('/review').then(r => (reason = r))
  await tick()
  await tick()
  assert.equal(reason, undefined)

  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  await turn
  assert.equal(reason, 'end_turn')
})

test('extension command: a command that answers with a message has it as its reply', async () => {
  const { conn, proc, session } = makeSession()
  const message = {
    role: 'custom',
    customType: 'subagent-slash-text-result',
    content: 'Subagents doctor: all good.',
    display: true,
    details: { view: 'text' }
  }
  handleCommandWith(proc, () => {
    proc.emit({ type: 'message_start', message })
    proc.emit({ type: 'message_end', message })
  })

  assert.equal(await session.prompt('/subagents-doctor'), 'end_turn')
  const chunk = updates(conn).find(u => u.sessionUpdate === 'agent_message_chunk')
  assert.equal(chunk.content.text, 'Subagents doctor: all good.')
  assert.equal(chunk._meta.piAcp.commandReply.source, 'customMessage')
  const forwarded = updates(conn).find(u => u._meta?.piAcp?.customMessage)._meta.piAcp.customMessage
  assert.equal(forwarded.commandReply, true, 'the structured copy says it was already shown as the reply')
})

test('extension command: a prompt pi started a run for still waits for agent_settled', async () => {
  const { proc, session } = makeSession()
  proc.dispositions = ['started']
  let reason: StopReason | undefined
  const turn = session.prompt('/skill:review the diff').then(r => (reason = r))
  await tick()
  await tick()
  assert.equal(reason, undefined)
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  await turn
  assert.equal(reason, 'end_turn')
})
