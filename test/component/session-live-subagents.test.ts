import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const RUN = 'd8da4c56-699b-4ebe-a561-7d36a589be21'
const CALL = 'chatcmpl-tool-7c3e918c8cba45b99cfdbb73684a34b9'

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
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const updates = (conn: FakeAgentSideConnection) => conn.updates.map(u => u.update as any)

function widget(state: string, child: Record<string, unknown> = {}) {
  return {
    type: 'extension_ui_request',
    id: crypto.randomUUID(),
    method: 'setWidget',
    widgetKey: 'subagent-async',
    widgetLines: [
      'PI_SUBAGENT_ASYNC_JSON:' +
        JSON.stringify({
          kind: 'pi-subagents.async-status-snapshot',
          version: 1,
          runs: [
            {
              id: RUN,
              kind: 'subagent',
              label: 'scout',
              state,
              startedAt: 1000,
              ...(state === 'complete' ? { endedAt: 3659 } : {}),
              children: [
                {
                  id: 'step:0',
                  kind: 'step',
                  label: 'scout',
                  state,
                  agent: 'scout',
                  model: 'baseten/zai-org/GLM-5.3-Fast',
                  thinking: 'low',
                  ...child
                }
              ]
            }
          ]
        })
    ]
  }
}

function launch(proc: FakePiRpcProcess) {
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: CALL,
    toolName: 'subagent',
    args: { agent: 'scout', async: true, task: 'Count the entries.' }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: CALL,
    toolName: 'subagent',
    isError: false,
    durationMs: 68,
    result: {
      content: [{ type: 'text', text: `Async: scout [${RUN}]\n\nDetached. Return control now.` }],
      details: {
        mode: 'single',
        runId: RUN,
        toolCallId: CALL,
        results: [],
        asyncId: RUN,
        asyncDir: `/nonexistent/${RUN}`
      }
    }
  })
}

test('subagents live: the launch call carries the run marker and card, in place, during its turn', async () => {
  const { conn, proc, session } = makeSession()
  const turn = session.prompt('launch a scout')
  proc.emit({ type: 'agent_start' })
  launch(proc)
  await tick()

  const [toolCall, done] = updates(conn).filter(u => u.toolCallId === CALL)
  assert.equal(toolCall.sessionUpdate, 'tool_call')
  assert.deepEqual(toolCall._meta.piAcp.subagent, {
    version: 1,
    role: 'run',
    tool: 'subagent',
    mode: 'single',
    async: true,
    agents: ['scout'],
    label: 'scout'
  })
  assert.equal(toolCall._meta.piAcp.subagentRun.status, 'pending')
  assert.equal(done.status, 'completed', 'the call itself returned')
  assert.equal(done._meta.piAcp.subagentRun.status, 'running', 'the run it started goes on')
  assert.equal(done._meta.piAcp.subagentRun.runId, RUN)
  assert.equal(done._meta.piAcp.subagent.runId, RUN)

  // The widget updates the same card, on the same tool call, while the turn runs.
  proc.emit(widget('running', { activity: { currentTool: 'bash', toolCount: 1 } }))
  await tick()
  const live = updates(conn).at(-1)
  assert.equal(live.sessionUpdate, 'tool_call_update')
  assert.equal(live.toolCallId, CALL)
  assert.equal(live.status, undefined)
  assert.ok(live._meta.piAcp.subagent, 'every update carries the whole _meta.piAcp')
  assert.deepEqual(live._meta.piAcp.subagentRun.children[0].activity, { currentTool: 'bash', toolCount: 1 })
  assert.equal(live._meta.piAcp.subagentRun.children[0].model, 'baseten/zai-org/GLM-5.3-Fast')

  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')

  // After its turn, the card travels on session_info_update (keyed by toolCallId).
  proc.emit(widget('complete'))
  await tick()
  const after = updates(conn).at(-1)
  assert.equal(after.sessionUpdate, 'session_info_update')
  assert.equal(after._meta.piAcp.subagentRun.toolCallId, CALL)
  assert.equal(after._meta.piAcp.subagentRun.status, 'completed')
  assert.equal(after._meta.piAcp.subagent, undefined)
})

test('subagents live: repeated widget ticks are not resent, and activity-only changes are throttled', async () => {
  const { conn, proc } = makeSession()
  launch(proc)
  proc.emit(widget('running'))
  await tick()
  const base = conn.updates.length

  proc.emit(widget('running'))
  await tick()
  assert.equal(conn.updates.length, base, 'an identical snapshot sends nothing')

  proc.emit(widget('running', { activity: { currentTool: 'read', toolCount: 2 } }))
  proc.emit(widget('running', { activity: { currentTool: 'bash', toolCount: 3 } }))
  await tick()
  assert.equal(conn.updates.length, base, 'activity-only changes wait for the throttle window')

  proc.emit(widget('complete'))
  await tick()
  assert.equal(conn.updates.length, base + 1, 'a status change goes out at once, with the latest activity folded in')
  assert.equal(updates(conn).at(-1)._meta.piAcp.subagentRun.status, 'completed')
  await wait(2100)
  assert.equal(conn.updates.length, base + 1, 'nothing stale follows it')
})

test('subagents live: the hidden completion notice is forwarded and settles the card', async () => {
  const { conn, proc } = makeSession()
  launch(proc)
  const notice = {
    role: 'custom',
    customType: 'subagent-notify',
    content:
      'Background task completed: **scout**\n\nscout:\n0 entries\n\nParent action: Read the saved results above.',
    display: false,
    details: {
      runs: [
        { agent: 'scout', status: 'completed', runId: RUN, durationMs: 2659, sessionValue: '/s/run-0/session.jsonl' }
      ]
    },
    timestamp: 5
  }
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_start', message: notice })
  proc.emit({ type: 'message_end', message: notice })
  await tick()

  const metas = updates(conn)
    .filter(u => u.sessionUpdate === 'session_info_update')
    .map(u => u._meta.piAcp)
  const forwarded = metas.find(m => m.customMessage)!.customMessage
  assert.deepEqual(forwarded.toolCallIds, [CALL])
  assert.equal(forwarded.hidden, true)
  const card = metas.find(m => m.subagentRun)!.subagentRun
  assert.equal(card.status, 'completed')
  assert.equal(card.result, 'scout:\n0 entries')
  assert.equal(card.durationMs, 2659)
  assert.equal(card.sessionFile, '/s/run-0/session.jsonl')
  const turn = metas.find(m => m.agentTurn)!.agentTurn
  assert.deepEqual(turn.trigger.toolCallIds, [CALL])
})

test('subagents live: an AIR client gets the async run as a stoppable task', async () => {
  const { conn, proc, session } = makeSession({ asyncTasks: true })
  launch(proc)
  await tick()
  const spawned = updates(conn).find(u => u.sessionUpdate === 'async_task_spawned')
  assert.deepEqual(spawned, {
    sessionUpdate: 'async_task_spawned',
    asyncTaskId: RUN,
    name: 'scout',
    taskType: 'subagent',
    description: 'Count the entries.',
    showInTranscript: false,
    canStop: true,
    toolCallId: CALL
  })

  // Stop runs pi-subagents' own command inside pi, with no model turn.
  proc.commands = [{ name: 'subagents-stop', source: 'extension' }]
  proc.dispositions = ['handled']
  assert.deepEqual(await session.stopAsyncTask(RUN), { stopped: true })
  assert.deepEqual(proc.prompts.at(-1), { message: `/subagents-stop ${RUN}`, attachments: [] })

  proc.emit(widget('stopped'))
  await tick()
  const state = updates(conn).find(u => u.sessionUpdate === 'async_task_state_update')
  assert.equal(state.asyncTaskId, RUN)
  assert.equal(state.state, 'stopped')
})

test('subagents live: Stop is refused without the command pi would need (nothing reaches the model)', async () => {
  const { proc, session } = makeSession({ asyncTasks: true })
  launch(proc)
  await tick()
  assert.deepEqual(await session.stopAsyncTask(RUN), { stopped: false })
  assert.equal(proc.prompts.length, 0)
})

test('subagents live: a foreground run’s progress is forwarded at a sane rate, the result at once', async () => {
  const { conn, proc } = makeSession()
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'fg',
    toolName: 'subagent',
    args: { agent: 'worker', task: 'fix it' }
  })
  const progress = (n: number) => ({
    type: 'tool_execution_update',
    toolCallId: 'fg',
    partialResult: {
      content: [{ type: 'text', text: `step ${n}` }],
      details: {
        mode: 'single',
        results: [],
        progress: [
          {
            index: 0,
            agent: 'worker',
            status: 'running',
            task: 'fix it',
            toolCount: n,
            tokens: n,
            durationMs: n,
            recentTools: [],
            recentOutput: []
          }
        ]
      }
    }
  })
  for (let n = 1; n <= 5; n += 1) proc.emit(progress(n))
  await tick()
  const partials = () => updates(conn).filter(u => u.toolCallId === 'fg' && u.status === 'in_progress' && u.content)
  assert.equal(partials().length, 1, 'the first goes out, the rest are coalesced')
  assert.equal(partials()[0]._meta.piAcp.subagentRun.status, 'running')

  await wait(600)
  assert.equal(partials().length, 2)
  assert.equal(partials()[1].content[0].content.text, 'step 5', 'the latest wins')

  proc.emit(progress(6))
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'fg',
    toolName: 'subagent',
    isError: false,
    durationMs: 900,
    result: {
      content: [{ type: 'text', text: 'Fixed.' }],
      details: {
        mode: 'single',
        results: [
          {
            index: 0,
            agent: 'worker',
            task: 'fix it',
            exitCode: 0,
            usage: { input: 10, output: 2 },
            finalOutput: 'Fixed.'
          }
        ]
      }
    }
  })
  await wait(600)
  const last = updates(conn)
    .filter(u => u.toolCallId === 'fg')
    .at(-1)
  assert.equal(last.status, 'completed', 'no held progress update lands after the result')
  assert.equal(last._meta.piAcp.subagentRun.status, 'completed')
  assert.equal(last._meta.piAcp.subagentRun.durationMs, 900)
})
