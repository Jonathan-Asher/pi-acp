import test from 'node:test'
import assert from 'node:assert/strict'
import { applySessionName, readSessionName } from '../../src/acp/agent.js'

function fakeProc(current?: string, opts: { failSet?: boolean } = {}) {
  const sets: string[] = []
  return {
    sets,
    proc: {
      async getState() {
        return current === undefined ? {} : { sessionName: current }
      },
      async setSessionName(name: string) {
        if (opts.failSet) throw new Error('pi set_session_name failed: unknown command')
        sets.push(name)
      }
    }
  }
}

test('readSessionName: reads _meta.piAcp.sessionName, trimmed, and nothing else', () => {
  assert.equal(readSessionName({ _meta: { piAcp: { sessionName: '  Release prep ' } } }), 'Release prep')
  assert.equal(readSessionName({ _meta: { piAcp: { sessionName: '   ' } } }), undefined)
  assert.equal(readSessionName({ _meta: { claudeCode: { options: { extraArgs: { name: 'x' } } } } }), undefined)
  assert.equal(readSessionName({}), undefined)
})

test('applySessionName: renames only when the name differs', async () => {
  const named = { _meta: { piAcp: { sessionName: 'Release prep' } } }

  const fresh = fakeProc()
  await applySessionName(fresh, named)
  assert.deepEqual(fresh.sets, ['Release prep'])

  const same = fakeProc('Release prep')
  await applySessionName(same, named)
  assert.deepEqual(same.sets, [], 'an unchanged name appends nothing to the session')

  const other = fakeProc('old title')
  await applySessionName(other, named)
  assert.deepEqual(other.sets, ['Release prep'])

  const none = fakeProc('old title')
  await applySessionName(none, {})
  assert.deepEqual(none.sets, [])
})

test('applySessionName: a pi that cannot rename keeps going', async () => {
  const old = fakeProc(undefined, { failSet: true })
  await applySessionName(old, { _meta: { piAcp: { sessionName: 'x' } } })
  assert.deepEqual(old.sets, [])
})
