import test from 'node:test'
import assert from 'node:assert/strict'
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
const updates = (conn: FakeAgentSideConnection) => conn.updates.map(u => u.update as any)
const infos = (conn: FakeAgentSideConnection) =>
  updates(conn)
    .filter(u => u.sessionUpdate === 'session_info_update')
    .map(u => u._meta?.piAcp ?? {})

const jobsWidget = (jobs: unknown[]) => ({
  type: 'extension_ui_request',
  id: crypto.randomUUID(),
  method: 'setWidget',
  widgetKey: 'bg-jobs',
  widgetLines: ['PI_BG_JOBS_JSON:' + JSON.stringify({ kind: 'pi-bg-jobs.snapshot', version: 1, sessionId: 's', jobs })]
})

/** `bgj_run` inside a prompt turn, as pi-bg-jobs runs it (it publishes its widget before returning). */
async function runJob(proc: FakePiRpcProcess, session: PiAcpSession) {
  const turn = session.prompt('build in the background')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'call-bg', toolName: 'bgj_run', args: { command: 'make -j8' } })
  proc.emit(
    jobsWidget([
      {
        id: 'jb-1',
        toolCallId: 'call-bg',
        state: 'running',
        pid: 77,
        command: 'make -j8',
        logFile: '/jobs/jb-1.log',
        startedAtMs: 1000
      }
    ])
  )
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'call-bg',
    toolName: 'bgj_run',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'Command running in background with ID: jb-1 (pid 77).' }],
      details: { id: 'jb-1', pid: 77, logFile: '/jobs/jb-1.log', toolCallId: 'call-bg' }
    }
  })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  return turn
}

const exitNotice = {
  role: 'custom',
  customType: 'bg-job-exit',
  content: '[bg-jobs] Background job jb-1 completed (exit 0) after 4s.\nCommand: make -j8',
  display: true,
  details: {
    v: 1,
    id: 'jb-1',
    toolCallId: 'call-bg',
    state: 'completed',
    exitCode: 0,
    startedAtMs: 1000,
    exitedAtMs: 5000,
    durationMs: 4000,
    command: 'make -j8',
    logFile: '/jobs/jb-1.log',
    delivery: 'woke'
  }
}

test('jobs live: bgj_run anchors its job card, running when the call returns', async () => {
  const { conn, proc, session } = makeSession()
  assert.equal(await runJob(proc, session), 'end_turn')

  const call = updates(conn).filter(u => u.toolCallId === 'call-bg')
  assert.equal(call[0].sessionUpdate, 'tool_call')
  assert.equal(call[0]._meta.piAcp.backgroundJob.state, 'pending')
  const done = call.at(-1)
  assert.equal(done.status, 'completed')
  assert.deepEqual(done._meta.piAcp.backgroundJob, {
    version: 1,
    tool: 'bgj_run',
    toolCallId: 'call-bg',
    state: 'running',
    command: 'make -j8',
    id: 'jb-1',
    pid: 77,
    logFile: '/jobs/jb-1.log',
    startedAt: 1000
  })
})

test('jobs live: the exit notice wakes pi, is forwarded, and flips the card after its turn', async () => {
  const { conn, proc, session } = makeSession()
  await runJob(proc, session)
  proc.emit(
    jobsWidget([
      { id: 'jb-1', toolCallId: 'call-bg', state: 'completed', exitCode: 0, startedAtMs: 1000, exitedAtMs: 5000 }
    ])
  )
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_start', message: exitNotice })
  proc.emit({ type: 'message_end', message: exitNotice })
  await tick()

  const metas = infos(conn)
  const cards = metas.filter(m => m.backgroundJob).map(m => m.backgroundJob)
  assert.equal(cards.at(-1).state, 'completed')
  assert.equal(cards.at(-1).durationMs, 4000)
  assert.equal(cards.at(-1).delivery, 'woke')
  const notice = metas.find(m => m.customMessage)!.customMessage
  assert.equal(notice.customType, 'bg-job-exit')
  assert.deepEqual(notice.toolCallIds, ['call-bg'])
  assert.equal(notice.details.exitCode, 0)
  const turn = metas.find(m => m.agentTurn)!.agentTurn
  assert.equal(turn.trigger.kind, 'jobExit')
  assert.deepEqual(turn.trigger.toolCallIds, ['call-bg'])
  // Nothing for this job was sent as an update of the (finished) call.
  assert.equal(
    updates(conn).filter(u => u.toolCallId === 'call-bg' && u._meta?.piAcp?.backgroundJob?.state === 'completed')
      .length,
    0
  )
})

test('jobs live: an exit the model already read is a silent custom entry that still flips the card', async () => {
  const { conn, proc, session } = makeSession()
  await runJob(proc, session)
  proc.emit({
    type: 'entry_appended',
    entry: {
      type: 'custom',
      id: 'e1',
      parentId: 'p',
      timestamp: '2026-11-12T10:00:00.000Z',
      customType: 'bg-job-exit',
      data: { ...exitNotice.details, delivery: 'silent', consumedBy: 'bgj_wait' }
    }
  })
  await tick()
  const metas = infos(conn)
  const entry = metas.find(m => m.customEntry)!.customEntry
  assert.equal(entry.customType, 'bg-job-exit')
  assert.equal(entry.id, 'e1')
  assert.deepEqual(entry.toolCallIds, ['call-bg'])
  assert.equal(metas.filter(m => m.backgroundJob).at(-1).backgroundJob.consumedBy, 'bgj_wait')
  assert.equal(metas.filter(m => m.agentTurn).length, 0, 'no wake')
})

test('jobs live: polls point at their job', async () => {
  const { conn, proc, session } = makeSession()
  await runJob(proc, session)
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'w1',
    toolName: 'bgj_wait',
    args: { id: 'jb-1', timeoutSeconds: 30 }
  })
  await tick()
  const wait = updates(conn).find(u => u.toolCallId === 'w1')
  assert.deepEqual(wait._meta.piAcp.backgroundJobControl, {
    version: 1,
    tool: 'bgj_wait',
    id: 'jb-1',
    anchorToolCallId: 'call-bg'
  })
})

test('jobs live: an AIR client gets the job as a shell task; Stop runs /bgj-kill inside pi', async () => {
  const { conn, proc, session } = makeSession({ asyncTasks: true })
  await runJob(proc, session)
  const spawned = updates(conn).find(u => u.sessionUpdate === 'async_task_spawned')
  assert.deepEqual(spawned, {
    sessionUpdate: 'async_task_spawned',
    asyncTaskId: 'jb-1',
    name: 'make -j8',
    taskType: 'shell',
    description: 'make -j8',
    showInTranscript: false,
    canStop: true,
    outputFilePath: '/jobs/jb-1.log',
    toolCallId: 'call-bg'
  })

  proc.commands = [{ name: 'bgj-kill', source: 'extension' }]
  proc.dispositions = ['handled']
  assert.deepEqual(await session.stopAsyncTask('jb-1'), { stopped: true })
  assert.deepEqual(proc.prompts.at(-1), { message: '/bgj-kill jb-1', attachments: [] })
  assert.deepEqual(proc.promptOptions.at(-1), { streamingBehavior: 'steer' })

  proc.emit(
    jobsWidget([
      {
        id: 'jb-1',
        toolCallId: 'call-bg',
        state: 'killed',
        killedBy: 'user',
        exitCode: null,
        startedAtMs: 1000,
        exitedAtMs: 3000
      }
    ])
  )
  await tick()
  const state = updates(conn).find(u => u.sessionUpdate === 'async_task_state_update')
  assert.deepEqual(state, {
    sessionUpdate: 'async_task_state_update',
    asyncTaskId: 'jb-1',
    state: 'stopped',
    summary: 'killed (user) · 2s'
  })
})
