import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

const RUN = 'd8da4c56-699b-4ebe-a561-7d36a589be21'

class FakeStore {
  get(_sessionId: string) {
    return { sessionId: 's1', cwd: '/tmp/project', sessionFile: '/tmp/s.jsonl', updatedAt: new Date().toISOString() }
  }
  upsert() {}
}

// A session in which pi launched an async scout and a background job, went
// idle, and was woken twice: by the scout's hidden completion notice, and by
// an older pi-bg-jobs exit report (a plain user message).
const messages: Array<Record<string, unknown>> = [
  { role: 'system', content: '', sections: {}, timestamp: 1 },
  { role: 'user', content: [{ type: 'text', text: 'count the files, and build in the background' }], timestamp: 10 },
  {
    role: 'assistant',
    content: [
      {
        type: 'toolCall',
        id: 'call-sub',
        name: 'subagent',
        arguments: { agent: 'scout', async: true, task: 'Count the files.' }
      },
      { type: 'toolCall', id: 'call-bg', name: 'bgj_run', arguments: { command: 'make' } }
    ],
    stopReason: 'toolUse',
    timestamp: 11
  },
  {
    role: 'toolResult',
    toolCallId: 'call-sub',
    toolName: 'subagent',
    content: [{ type: 'text', text: `Async: scout [${RUN}]` }],
    details: { mode: 'single', runId: RUN, asyncId: RUN, results: [] },
    isError: false,
    timestamp: 12
  },
  {
    role: 'toolResult',
    toolCallId: 'call-bg',
    toolName: 'bgj_run',
    content: [{ type: 'text', text: 'Command running in background with ID: jb-old' }],
    details: { id: 'jb-old', pid: 1, logFile: '/jobs/jb-old.log' },
    isError: false,
    timestamp: 13
  },
  { role: 'assistant', content: [{ type: 'text', text: 'LAUNCHED' }], stopReason: 'stop', timestamp: 14 },
  {
    role: 'custom',
    customType: 'subagent-notify',
    content: 'Background task completed: **scout**\n\nscout:\n3 files\n\nParent action: Read the saved results above.',
    display: false,
    details: { runs: [{ agent: 'scout', status: 'completed', runId: RUN, durationMs: 2000 }] },
    timestamp: 20
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'The scout counted 3 files.' }],
    stopReason: 'stop',
    timestamp: 21
  },
  {
    role: 'user',
    content: '✅ Background job finished (exit 0, ran 1m 0s)\n[jb-old] completed exit 0 · 1m 0s · make',
    timestamp: 30
  },
  { role: 'assistant', content: [{ type: 'text', text: 'The build passed.' }], stopReason: 'stop', timestamp: 31 }
]

async function replay(entries: unknown[] = [], leafId: string | null = null) {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () =>
    ({
      onEvent: () => () => {},
      getMessages: async () => ({ messages }),
      getEntries: async () => ({ entries, leafId }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    }) as any
  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()
    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)
    return conn.updates.map(u => (u as any).update).filter((u: any) => u.sessionUpdate !== 'available_commands_update')
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
}

test('replay: anchors come back with their final card and their arguments', async () => {
  const updates = await replay()
  const sub = updates.find((u: any) => u.sessionUpdate === 'tool_call' && u.toolCallId === 'call-sub')
  assert.deepEqual(sub.rawInput, { agent: 'scout', async: true, task: 'Count the files.' })
  assert.equal(sub._meta.piAcp.subagent.role, 'run')
  const run = sub._meta.piAcp.subagentRun
  assert.equal(run.status, 'completed')
  assert.equal(run.result, 'scout:\n3 files')
  assert.equal(run.durationMs, 2000)

  const bg = updates.find((u: any) => u.sessionUpdate === 'tool_call' && u.toolCallId === 'call-bg')
  assert.equal(bg._meta.piAcp.backgroundJob.state, 'completed')
  assert.equal(bg._meta.piAcp.backgroundJob.exitCode, 0)
})

test('replay: notices are forwarded, and the runs pi started by itself are agent turns again', async () => {
  const updates = await replay()
  const info = updates.filter((u: any) => u.sessionUpdate === 'session_info_update').map((u: any) => u._meta.piAcp)
  const turns = info.filter((m: any) => m.agentTurn).map((m: any) => m.agentTurn)
  assert.deepEqual(
    turns.map((t: any) => [t.state, t.trigger?.kind, t.endReason]),
    [
      ['running', 'subagentSettled', undefined],
      ['ended', undefined, 'settled'],
      ['running', 'jobExit', undefined],
      ['ended', undefined, 'settled']
    ]
  )
  assert.deepEqual(turns[0].trigger.toolCallIds, ['call-sub'])
  assert.equal(turns[0].trigger.hidden, true)
  assert.ok(turns.every((t: any) => t.replay === true))

  const notices = info.filter((m: any) => m.customMessage).map((m: any) => m.customMessage)
  assert.deepEqual(
    notices.map((n: any) => [n.customType, n.hidden, n.toolCallIds, n.replay]),
    [
      ['subagent-notify', true, ['call-sub'], true],
      ['injected-user', undefined, ['call-bg'], true]
    ]
  )
  assert.equal(notices[0].agentTurnId, turns[0].id)
})

test('replay: the user’s messages stay user messages; an extension’s are not', async () => {
  const updates = await replay()
  const users = updates.filter((u: any) => u.sessionUpdate === 'user_message_chunk').map((u: any) => u.content.text)
  assert.deepEqual(users, ['count the files, and build in the background'])
  const replies = updates.filter((u: any) => u.sessionUpdate === 'agent_message_chunk').map((u: any) => u.content.text)
  assert.deepEqual(replies, ['LAUNCHED', 'The scout counted 3 files.', 'The build passed.'])
})

test('replay: custom entries on the active branch fold in (a supervisor’s answer)', async () => {
  const withQuestion = [
    ...messages.slice(0, 6),
    {
      role: 'custom',
      customType: 'subagent_supervisor_request',
      content: 'Subagent needs a supervisor decision.',
      display: true,
      details: { requestId: 'q1', runId: RUN, agent: 'scout', childIndex: 0, requestBody: 'Include hidden files?' },
      timestamp: 15
    },
    ...messages.slice(6)
  ]
  messages.splice(0, messages.length, ...withQuestion)
  const updates = await replay(
    [
      {
        type: 'custom',
        id: 'e1',
        parentId: null,
        customType: 'subagent_supervisor_reply',
        data: { requestId: 'q1', message: 'Yes.' }
      },
      {
        type: 'custom',
        id: 'e2',
        parentId: 'gone',
        customType: 'subagent_supervisor_reply',
        data: { requestId: 'q1', message: 'Off-branch.' }
      }
    ],
    'e1'
  )
  const sub = updates.find((u: any) => u.sessionUpdate === 'tool_call' && u.toolCallId === 'call-sub')
  assert.deepEqual(sub._meta.piAcp.subagentRun.children[0].exchanges, [
    { requestId: 'q1', question: 'Include hidden files?', answer: 'Yes.' }
  ])
})
