import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

// pi records a session's cwd as its real path: on macOS `/tmp/x` is stored as
// `/private/tmp/x`, and a symlinked folder as its target.
test('listSessions: a cwd given through a symlink (or /tmp on macOS) finds the sessions pi stored under the real path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-real-'))
  const real = join(root, 'project')
  mkdirSync(real)
  const link = join(root, 'link')
  symlinkSync(real, link)
  const stored = realpathSync(real)

  const sessions = join(root, 'agent', 'sessions', '--project--')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(
    join(sessions, '1.jsonl'),
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'sess-real',
      timestamp: '2026-11-12T00:00:00.000Z',
      cwd: stored
    }) + '\n'
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    const viaLink = await agent.listSessions({ cwd: link } as any)
    assert.deepEqual(
      viaLink.sessions.map(s => s.sessionId),
      ['sess-real']
    )
    const viaReal = await agent.listSessions({ cwd: stored } as any)
    assert.deepEqual(
      viaReal.sessions.map(s => s.sessionId),
      ['sess-real']
    )
    const elsewhere = await agent.listSessions({ cwd: join(root, 'other') } as any)
    assert.deepEqual(elsewhere.sessions, [])

    if (process.platform === 'darwin') {
      const tmpProject = mkdtempSync('/tmp/pi-acp-tmp-')
      writeFileSync(
        join(sessions, '2.jsonl'),
        JSON.stringify({
          type: 'session',
          version: 3,
          id: 'sess-tmp',
          timestamp: '2026-11-12T00:00:00.000Z',
          cwd: realpathSync(tmpProject)
        }) + '\n'
      )
      const viaTmp = await agent.listSessions({ cwd: tmpProject } as any)
      assert.deepEqual(
        viaTmp.sessions.map(s => s.sessionId),
        ['sess-tmp']
      )
    }
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('listSessions: a sub-agent’s child session is not listed as a session of its own, but loads by id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-children-'))
  const bucket = join(root, 'agent', 'sessions', '--p--')
  const child = join(bucket, '2026-11-12T00-00-00-000Z_parent', 'run-uuid', 'run-0')
  const artifacts = join(bucket, 'subagent-artifacts')
  mkdirSync(child, { recursive: true })
  mkdirSync(artifacts, { recursive: true })
  const header = (id: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-11-12T00:00:00.000Z', cwd: '/w', ...extra }) +
    '\n'
  writeFileSync(join(bucket, '2026-11-12T00-00-00-000Z_parent.jsonl'), header('parent'))
  writeFileSync(
    join(child, 'session.jsonl'),
    header('child', { parentSession: join(bucket, '2026-11-12T00-00-00-000Z_parent.jsonl') })
  )
  writeFileSync(join(artifacts, 'run-uuid_scout_transcript.jsonl'), header('artifact'))

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    const listed = await agent.listSessions({ cwd: '/w' } as any)
    assert.deepEqual(
      listed.sessions.map(s => s.sessionId),
      ['parent']
    )
    const { findPiSession } = await import('../../src/acp/pi-sessions.js')
    assert.equal(findPiSession('child')?.sessionFile, join(child, 'session.jsonl'))
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})
