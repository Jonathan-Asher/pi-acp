import test from 'node:test'
import assert from 'node:assert/strict'
import { BgJobTracker } from '../../src/acp/live/bg-jobs.js'

// Shapes from pi-bg-jobs 46e036b (~/Work/pi-bg-jobs/index.ts).
function launch(t: BgJobTracker, call = 'call-1', id = 'jb-1') {
  const start = t.onToolStart(call, 'bgj_run', { command: 'sleep 5; echo done' }, 1)
  t.onToolEnd(
    call,
    'bgj_run',
    {
      content: [{ type: 'text', text: `Command running in background with ID: ${id}` }],
      details: { id, pid: 4242, logFile: `/jobs/${id}.log`, toolCallId: call }
    },
    false
  )
  return start
}

test('bg-jobs: bgj_run is the anchor of its job, running once the call returns', () => {
  const t = new BgJobTracker({ now: () => 1000 })
  const start = launch(t)
  assert.deepEqual(start?.job, {
    version: 1,
    tool: 'bgj_run',
    toolCallId: 'call-1',
    state: 'pending',
    command: 'sleep 5; echo done'
  })
  assert.deepEqual(t.snapshot('call-1'), {
    version: 1,
    tool: 'bgj_run',
    toolCallId: 'call-1',
    state: 'running',
    command: 'sleep 5; echo done',
    id: 'jb-1',
    pid: 4242,
    logFile: '/jobs/jb-1.log',
    startedAt: 1000
  })
  assert.equal(t.anchorForJobId('jb-1'), 'call-1')
  assert.deepEqual(t.runningAnchors(), ['call-1'])
})

test('bg-jobs: the exit notice ends the job with its code, duration and text', () => {
  const t = new BgJobTracker({ now: () => 1000 })
  launch(t)
  const changed = t.onExitRecord(
    {
      v: 1,
      id: 'jb-1',
      toolCallId: 'call-1',
      state: 'completed',
      exitCode: 0,
      startedAtMs: 1000,
      exitedAtMs: 6000,
      durationMs: 5000,
      command: 'sleep 5; echo done',
      logFile: '/jobs/jb-1.log',
      delivery: 'woke'
    },
    '[bg-jobs] Background job jb-1 completed (exit 0) after 5s.'
  )
  assert.deepEqual(changed, ['call-1'])
  const s = t.snapshot('call-1')!
  assert.equal(s.state, 'completed')
  assert.equal(s.exitCode, 0)
  assert.equal(s.durationMs, 5000)
  assert.equal(s.delivery, 'woke')
  assert.match(s.notice!, /completed \(exit 0\)/)
  assert.deepEqual(t.runningAnchors(), [])
})

test('bg-jobs: the widget and the silent record flip a job the model already read', () => {
  const t = new BgJobTracker({ now: () => 1000 })
  launch(t)
  const widget = {
    kind: 'pi-bg-jobs.snapshot',
    version: 1,
    jobs: [
      {
        id: 'jb-1',
        toolCallId: 'call-1',
        state: 'killed',
        exitCode: null,
        exitSignal: 'SIGTERM',
        killedBy: 'bgj_kill',
        startedAtMs: 1000,
        exitedAtMs: 3000,
        consumedBy: 'bgj_kill'
      }
    ]
  }
  assert.deepEqual(t.onWidget(widget, -1), ['call-1'])
  assert.equal(t.snapshot('call-1')!.state, 'killed')
  assert.equal(t.snapshot('call-1')!.killedBy, 'bgj_kill')
  // The same exit again (the silent `appendEntry` record) changes nothing.
  assert.deepEqual(
    t.onExitRecord({
      id: 'jb-1',
      toolCallId: 'call-1',
      state: 'killed',
      exitCode: null,
      killedBy: 'bgj_kill',
      startedAtMs: 1000,
      exitedAtMs: 3000,
      delivery: 'silent',
      consumedBy: 'bgj_kill'
    }),
    ['call-1'],
    'delivery is new information'
  )
  assert.deepEqual(
    t.onExitRecord({ id: 'jb-1', toolCallId: 'call-1', state: 'killed', exitedAtMs: 3000, delivery: 'silent' }),
    []
  )
})

test('bg-jobs: a job still running from an earlier pi process is claimed by its tool call id; finished ones are history', () => {
  const t = new BgJobTracker()
  const changed = t.onWidget(
    {
      kind: 'pi-bg-jobs.snapshot',
      version: 1,
      jobs: [
        { id: 'jb-old', toolCallId: 'call-old', state: 'completed', exitCode: 0, startedAtMs: 1, exitedAtMs: 2 },
        { id: 'jb-live', toolCallId: 'call-live', state: 'running', startedAtMs: 5, command: 'make', logFile: '/l' }
      ]
    },
    -1
  )
  assert.deepEqual(changed, ['call-live'])
  assert.equal(t.snapshot('call-old'), undefined)
  assert.equal(t.snapshot('call-live')!.state, 'running')
  assert.equal(t.turnSeqOf('call-live'), -1)
})

test('bg-jobs: status, wait and kill calls point at their job and report its state', () => {
  const t = new BgJobTracker()
  launch(t)
  const control = t.onToolStart('w', 'bgj_wait', { id: 'jb-1' }, 2)?.control
  assert.deepEqual(control, { version: 1, tool: 'bgj_wait', id: 'jb-1', anchorToolCallId: 'call-1' })
  const changed = t.onToolEnd(
    'w',
    'bgj_wait',
    {
      details: {
        job: { id: 'jb-1', toolCallId: 'call-1', state: 'failed', exitCode: 2, startedAtMs: 1, exitedAtMs: 9 }
      }
    },
    false
  )
  assert.deepEqual(changed, ['call-1'])
  assert.equal(t.snapshot('call-1')!.state, 'failed')
  assert.equal(t.snapshot('call-1')!.exitCode, 2)
})

test('bg-jobs: an old pi-bg-jobs exit report (a user message) still ends the job', () => {
  const t = new BgJobTracker()
  launch(t)
  const changed = t.onLegacyReport(
    { jobId: 'jb-1', state: 'failed', summary: 'exit 2, ran 5s' },
    '❌ Background job FAILED (exit 2, ran 5s)\n[jb-1] failed'
  )
  assert.deepEqual(changed, ['call-1'])
  assert.equal(t.snapshot('call-1')!.state, 'failed')
  assert.equal(t.snapshot('call-1')!.exitCode, 2)
})

test('bg-jobs: a launch that failed is a failed job', () => {
  const t = new BgJobTracker()
  t.onToolStart('bad', 'bgj_run', { command: 'x' }, 1)
  t.onToolEnd('bad', 'bgj_run', { content: [{ type: 'text', text: 'spawn failed: ENOENT' }], details: {} }, true)
  assert.equal(t.snapshot('bad')!.state, 'failed')
  assert.equal(t.snapshot('bad')!.error, 'spawn failed: ENOENT')
})
