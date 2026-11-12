import test from 'node:test'
import assert from 'node:assert/strict'
import { SubagentTracker } from '../../src/acp/live/subagents.js'

// Shapes recorded from pi 1.5.2 + pi-subagents 0.88 (~/codeg-e2e/pi152/rpc-subagent-trace.jsonl).
const RUN = 'd8da4c56-699b-4ebe-a561-7d36a589be21'
const CALL = 'chatcmpl-tool-7c3e918c8cba45b99cfdbb73684a34b9'
const SESSION = `/s/2026-11-12T16-44-29-879Z_01a1d0a5/${RUN}/run-0/session.jsonl`

function widget(state: string, child?: Record<string, unknown>) {
  return {
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
        activity: { lastActivityAt: 2000, turnCount: 3, toolCount: 2 },
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
  }
}

function launchAsync(t: SubagentTracker) {
  const marker = t.onToolStart(
    CALL,
    'subagent',
    { agent: 'scout', async: true, task: 'Run ls in the current directory.' },
    1
  )
  t.onToolEnd(
    CALL,
    {
      content: [{ type: 'text', text: `Async: scout [${RUN}]` }],
      details: { mode: 'single', runId: RUN, toolCallId: CALL, results: [], asyncId: RUN, asyncDir: `/t/${RUN}` }
    },
    false
  )
  return marker
}

test('subagents: an async launch is an anchor that keeps running after the call returns', () => {
  const t = new SubagentTracker({ sessionIdOf: file => (file === SESSION ? 'child-session-id' : undefined) })
  const marker = launchAsync(t)
  assert.equal(marker?.role, 'run')
  assert.equal(marker?.label, 'scout')

  const launched = t.snapshot(CALL)!
  assert.equal(launched.status, 'running')
  assert.equal(launched.async, true)
  assert.equal(launched.runId, RUN)
  assert.equal(t.anchorForRunId(RUN), CALL)
  assert.deepEqual(
    launched.children.map(c => [c.key, c.label, c.agent, c.task]),
    [['#0', 'scout', 'scout', 'Run ls in the current directory.']]
  )
  assert.equal(t.markerFor(CALL)?.runId, RUN)
})

test('subagents: the widget drives child rows (model, thinking, activity) and the run state', () => {
  const t = new SubagentTracker()
  launchAsync(t)

  t.onWidget(widget('running', { activity: { currentTool: 'bash', toolCount: 1, turnCount: 1 } }))
  const running = t.snapshot(CALL)!
  assert.equal(running.status, 'running')
  assert.deepEqual(running.children[0], {
    key: '#0',
    label: 'scout',
    agent: 'scout',
    status: 'running',
    task: 'Run ls in the current directory.',
    model: 'baseten/zai-org/GLM-5.3-Fast',
    thinking: 'low',
    activity: { currentTool: 'bash', toolCount: 1 },
    turns: 1
  })

  const { changed } = t.onWidget(widget('complete'))
  assert.deepEqual(changed, [CALL])
  const done = t.snapshot(CALL)!
  assert.equal(done.status, 'completed')
  assert.equal(done.children[0]!.status, 'completed')
  assert.equal(done.children[0]!.activity, undefined)
  assert.equal(done.durationMs, 2659)
})

test('subagents: a hidden completion notice settles the run with its result and child session', () => {
  const t = new SubagentTracker({ sessionIdOf: file => (file === SESSION ? 'child-session-id' : undefined) })
  launchAsync(t)
  const text = [
    'Background task completed: **scout**',
    '',
    'scout:',
    'Number of entries: **0**',
    '',
    `Session file: ${SESSION}`,
    '',
    'Parent action: Read the saved results above.'
  ].join('\n')
  const changed = t.onCustomMessage(
    'subagent-notify',
    {
      runs: [
        {
          agent: 'scout',
          status: 'completed',
          asyncDir: `/t/${RUN}`,
          durationMs: 2659,
          runId: RUN,
          sessionLabel: 'Session file',
          sessionValue: SESSION
        }
      ]
    },
    text
  )
  assert.deepEqual(changed, [CALL])
  const s = t.snapshot(CALL)!
  assert.equal(s.status, 'completed')
  assert.equal(s.durationMs, 2659)
  assert.equal(s.result, 'scout:\nNumber of entries: **0**')
  assert.equal(s.sessionFile, SESSION)
  assert.equal(s.sessionId, 'child-session-id')
  assert.equal(s.children[0]!.status, 'completed')
  assert.equal(s.children[0]!.sessionId, 'child-session-id')
})

test('subagents: a terminal state is never undone by a stale snapshot', () => {
  const t = new SubagentTracker()
  launchAsync(t)
  t.onCustomMessage('subagent-notify', { runs: [{ runId: RUN, status: 'failed', agent: 'scout' }] }, 'x')
  t.onWidget(widget('running'))
  assert.equal(t.snapshot(CALL)!.status, 'failed')
})

test('subagents: a workflow keeps one row per child, with questions, answers and failures', () => {
  const t = new SubagentTracker()
  t.onToolStart('wf', 'subagent', { workflowScript: 'runs.all([...])', async: true }, 1)
  t.onToolEnd(
    'wf',
    {
      content: [{ type: 'text', text: 'Async workflow [w1]' }],
      details: {
        mode: 'workflow',
        runId: 'w1',
        asyncId: 'w1',
        results: [],
        workflowChildren: {
          version: 1,
          parentToolCallId: 'wf',
          workflowRunId: 'w1',
          inventoryComplete: true,
          workflowState: 'running',
          children: [
            { childId: 'mina', runId: 'c1', agent: 'researcher', state: 'running' },
            { childId: 'uma', runId: 'c2', agent: 'researcher', state: 'running' }
          ]
        }
      }
    },
    false
  )
  assert.deepEqual(
    t.snapshot('wf')!.children.map(c => c.key),
    ['mina', 'uma']
  )
  assert.equal(t.snapshot('wf')!.agent, 'researcher')

  // A child asks its supervisor (the parent pi) a question.
  t.onCustomMessage(
    'subagent_supervisor_request',
    { requestId: 'q1', runId: 'c1', agent: 'researcher', childIndex: 0, requestBody: 'No web tools. Relaunch?' },
    'Subagent needs a supervisor decision.'
  )
  let mina = t.snapshot('wf')!.children[0]!
  assert.deepEqual(mina.exchanges, [{ requestId: 'q1', question: 'No web tools. Relaunch?' }])
  assert.deepEqual(mina.attention, ['No web tools. Relaunch?'])

  // The parent's reply is recorded as a custom entry.
  t.onCustomEntry('subagent_supervisor_reply', { requestId: 'q1', runId: 'c1', message: 'Close it.' })
  mina = t.snapshot('wf')!.children[0]!
  assert.deepEqual(mina.exchanges, [{ requestId: 'q1', question: 'No web tools. Relaunch?', answer: 'Close it.' }])
  assert.equal(mina.attention, undefined)

  // A child fails while the workflow runs on.
  t.onCustomMessage(
    'subagent-incremental-child-notify',
    { childKey: 'uma', outcome: 'failed' },
    'Workflow child failed: **uma**\nWorkflow run: w1\nChild run: c2\nError: no web tools\nStatus: workflow still running'
  )
  const uma = t.snapshot('wf')!.children[1]!
  assert.equal(uma.status, 'failed')
  assert.equal(uma.error, 'no web tools')
  assert.equal(t.snapshot('wf')!.status, 'running')

  // The workflow's own notice.
  t.onCustomMessage(
    'subagent-notify',
    {
      runs: [
        {
          agent: 'workflow',
          status: 'failed',
          runId: 'w1',
          workflowRunId: 'w1',
          childRuns: [
            { runId: 'c1', workflowKey: 'mina', agent: 'researcher', status: 'completed' },
            { runId: 'c2', workflowKey: 'uma', agent: 'researcher', status: 'failed' }
          ]
        }
      ]
    },
    'Background task failed: **workflow**\n\nError: Cannot read runs.all result property'
  )
  const s = t.snapshot('wf')!
  assert.equal(s.status, 'failed')
  assert.equal(s.error, 'Cannot read runs.all result property')
  assert.deepEqual(
    s.children.map(c => [c.key, c.status]),
    [
      ['mina', 'completed'],
      ['uma', 'failed']
    ]
  )
})

test('subagents: a foreground parallel run streams progress and ends with its results', () => {
  const t = new SubagentTracker()
  t.onToolStart(
    'fg',
    'subagent',
    {
      tasks: [
        { agent: 'scout', task: 'a' },
        { agent: 'reviewer', task: 'b' }
      ]
    },
    1
  )
  assert.equal(t.snapshot('fg')!.status, 'pending')
  t.onToolUpdate('fg', {
    content: [{ type: 'text', text: '...' }],
    details: {
      mode: 'parallel',
      results: [],
      progress: [
        {
          index: 0,
          agent: 'scout',
          status: 'running',
          task: 'a',
          currentTool: 'bash',
          toolCount: 2,
          tokens: 100,
          durationMs: 500,
          recentTools: [],
          recentOutput: []
        },
        {
          index: 1,
          agent: 'reviewer',
          status: 'pending',
          task: 'b',
          toolCount: 0,
          tokens: 0,
          durationMs: 0,
          recentTools: [],
          recentOutput: []
        }
      ]
    }
  })
  const running = t.snapshot('fg')!
  assert.equal(running.status, 'running')
  assert.equal(running.agents?.length, 2)
  assert.deepEqual(running.children[0]!.activity, { currentTool: 'bash', toolCount: 2 })
  assert.equal(running.children[1]!.status, 'pending')

  t.onToolEnd(
    'fg',
    {
      content: [{ type: 'text', text: 'Both done.' }],
      details: {
        mode: 'parallel',
        results: [
          {
            index: 0,
            agent: 'scout',
            task: 'a',
            exitCode: 0,
            usage: { input: 100, output: 20 },
            sessionFile: '/s/0.jsonl',
            finalOutput: 'A'
          },
          { index: 1, agent: 'reviewer', task: 'b', exitCode: 1, error: 'boom', usage: { input: 5, output: 1 } }
        ]
      }
    },
    false,
    1234
  )
  const done = t.snapshot('fg')!
  assert.equal(done.status, 'completed', 'a parallel run fails only when every child failed (as the history card)')
  assert.equal(done.async, false)
  assert.equal(done.result, 'Both done.')
  assert.equal(done.durationMs, 1234)
  assert.deepEqual(
    done.children.map(c => [c.status, c.tokens, c.sessionFile, c.result, c.error]),
    [
      ['completed', 120, '/s/0.jsonl', 'A', undefined],
      ['failed', 6, undefined, undefined, 'boom']
    ]
  )
})

test('subagents: a run launched by an earlier pi process is claimed through its status.json', () => {
  const t = new SubagentTracker()
  const { unknownRunIds } = t.onWidget(widget('running'))
  assert.deepEqual(unknownRunIds, [RUN])
  const claimed = t.onStatusFile(
    RUN,
    {
      runId: RUN,
      toolCallId: CALL,
      mode: 'single',
      state: 'running',
      startedAt: 1000,
      steps: [
        {
          agent: 'scout',
          status: 'running',
          sessionFile: SESSION,
          model: 'baseten/zai-org/GLM-5.3-Fast',
          tokens: { total: 50 }
        }
      ]
    },
    -1
  )
  assert.equal(claimed, CALL)
  const s = t.snapshot(CALL)!
  assert.equal(s.status, 'running')
  assert.equal(s.children[0]!.sessionFile, SESSION)
  assert.equal(s.children[0]!.tokens, 50)
  // From now on the widget updates it.
  t.onWidget(widget('complete'))
  assert.equal(t.snapshot(CALL)!.status, 'completed')
})

test('subagents: management calls are marked as control and point at their run', () => {
  const t = new SubagentTracker()
  launchAsync(t)
  const status = t.onToolStart('st', 'subagent', { action: 'status', id: RUN }, 2)
  assert.deepEqual(status, {
    version: 1,
    role: 'control',
    tool: 'subagent',
    action: 'status',
    runId: RUN,
    anchorToolCallId: CALL
  })
  assert.equal(t.isAnchor('st'), false)
  assert.equal(t.onToolStart('bg', 'bg_wait', {}, 2)?.role, 'control')
  assert.equal(t.onToolStart('x', 'bash', { command: 'ls' }, 2), undefined)
})
