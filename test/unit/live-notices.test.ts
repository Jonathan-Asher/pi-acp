import test from 'node:test'
import assert from 'node:assert/strict'
import {
  legacyJobReport,
  noticeError,
  noticeResultPreview,
  noticeRunIds,
  noticeSummary,
  triggerKindOf,
  wakeReason
} from '../../src/acp/live/notices.js'

test('notices: trigger kinds match the history parser vocabulary', () => {
  assert.equal(triggerKindOf('subagent-notify'), 'subagentSettled')
  assert.equal(triggerKindOf('subagent-incremental-child-notify'), 'subagentSettled')
  assert.equal(triggerKindOf('subagent_supervisor_request'), 'subagentQuestion')
  assert.equal(triggerKindOf('subagent_watchdog_clarification'), 'subagentAttention')
  assert.equal(triggerKindOf('bg-job-exit'), 'jobExit')
  assert.equal(triggerKindOf('injected-user'), 'injectedUser')
  assert.equal(triggerKindOf('my-extension'), 'extension')
  assert.equal(wakeReason('subagentSettled'), 'Woken by sub-agent completion')
  assert.equal(wakeReason('jobExit'), 'Woken by job exit')
})

test('notices: an old pi-bg-jobs exit report (a plain user message) is recognized', () => {
  const report = legacyJobReport(
    '✅ Background job finished (exit 0, ran 3m 52s)\n[jb-mwc8zz2b-8l1v] completed exit 0 · 3m 52s · make\ncwd: /w'
  )
  assert.deepEqual(report, { jobId: 'jb-mwc8zz2b-8l1v', state: 'completed', summary: 'exit 0, ran 3m 52s' })
  assert.equal(legacyJobReport('🛑 Background job killed (timeout, ran 15m)\n[jb-x1] killed')?.state, 'killed')
  assert.equal(legacyJobReport('❌ Background job FAILED (exit 2, ran 5s)\n[jb-z] failed')?.state, 'failed')
  assert.equal(legacyJobReport('✅ Background job finished (exit 0, ran 58s)'), null)
  assert.equal(legacyJobReport('please run the tests'), null)
})

test('notices: run ids come from details.runs, child runs, and the text as a fallback', () => {
  const details = {
    runs: [
      {
        runId: 'r1',
        workflowRunId: 'w1',
        childRuns: [
          { runId: 'c1', workflowKey: 'mina' },
          { runId: 'unavailable', workflowKey: 'uma' }
        ]
      }
    ]
  }
  assert.deepEqual(noticeRunIds('subagent-notify', details, '').sort(), ['c1', 'r1', 'w1'])
  assert.deepEqual(
    noticeRunIds(
      'subagent-incremental-child-notify',
      { childKey: 'mina', outcome: 'failed' },
      'Workflow child failed: **mina**\nWorkflow run: w9\nChild run: c9\nStatus: workflow still running'
    ).sort(),
    ['c9', 'w9']
  )
})

test('notices: summaries say who did what', () => {
  assert.equal(
    noticeSummary('subagent-notify', { runs: [{ agent: 'scout', status: 'completed' }] }, ''),
    'scout completed'
  )
  assert.equal(
    noticeSummary('subagent_supervisor_request', { agent: 'researcher', requestBody: 'No web tools.\nRelaunch?' }, ''),
    'researcher asks: No web tools.'
  )
  assert.equal(noticeSummary('bg-job-exit', { id: 'jb-1', state: 'failed', exitCode: 2 }, ''), 'jb-1 failed (exit 2)')
})

test('notices: the result preview drops the header, the paths and the instructions for the model', () => {
  const text = [
    'Background task completed: **scout**',
    '',
    'scout:',
    '## Result',
    'Number of entries: **0**',
    '',
    'Output saved to: /x/context.md (164 B, 7 lines). Read this file if needed.',
    '',
    'Session file: /x/run-0/session.jsonl',
    '',
    'Parent action: Read the saved results above.'
  ].join('\n')
  assert.equal(noticeResultPreview(text), 'scout:\n## Result\nNumber of entries: **0**')
  // A workflow's notice lists every child's saved-output paths after its return value.
  assert.equal(
    noticeResultPreview(
      'Background task completed: **workflow**\n\nWorkflow completed with 2 child run(s). Return: {"ok": true}\n\nChild outputs:\n- key=task-1 run=r1 status=completed\n  Saved output: /x/task-1.md'
    ),
    'Workflow completed with 2 child run(s). Return: {"ok": true}'
  )
  assert.equal(noticeError('Workflow child failed: **uma**\nError: no web tools\nStatus: x'), 'no web tools')
})
