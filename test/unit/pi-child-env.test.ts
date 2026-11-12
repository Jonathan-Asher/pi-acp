import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultSubagentsTempRoot, piAgentDir, piChildEnv, SUBAGENTS_TEMP_ROOT_ENV } from '../../src/pi-rpc/env.js'

test('piChildEnv: pins the sub-agent temp root to the agent dir when unset', () => {
  const env = { PATH: '/usr/bin', TMPDIR: '/tmp/codeg-acp-501/123-abc/' }
  const out = piChildEnv(env)
  assert.equal(out[SUBAGENTS_TEMP_ROOT_ENV], join(homedir(), '.pi', 'agent', 'subagents-tmp'))
  assert.equal(out.TMPDIR, env.TMPDIR, 'TMPDIR is left as the client set it')
  assert.equal(out.PATH, '/usr/bin')
  assert.equal((env as Record<string, string>)[SUBAGENTS_TEMP_ROOT_ENV], undefined, 'input env is not mutated')
})

test('piChildEnv: keeps a temp root the user configured', () => {
  const env = { [SUBAGENTS_TEMP_ROOT_ENV]: '/var/tmp/my-subagents' }
  assert.equal(piChildEnv(env)[SUBAGENTS_TEMP_ROOT_ENV], '/var/tmp/my-subagents')
})

test('piChildEnv: a blank temp root counts as unset', () => {
  const env = { [SUBAGENTS_TEMP_ROOT_ENV]: '  ' }
  assert.equal(piChildEnv(env)[SUBAGENTS_TEMP_ROOT_ENV], join(homedir(), '.pi', 'agent', 'subagents-tmp'))
})

test('piAgentDir: follows PI_CODING_AGENT_DIR, expanding ~ like pi', () => {
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: '/srv/pi-agent' }), '/srv/pi-agent')
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: '~/codeg-e2e-pi/agent' }), join(homedir(), 'codeg-e2e-pi', 'agent'))
  assert.equal(piAgentDir({}), join(homedir(), '.pi', 'agent'))
  assert.equal(
    defaultSubagentsTempRoot({ PI_CODING_AGENT_DIR: '/srv/pi-agent' }),
    join('/srv/pi-agent', 'subagents-tmp'),
    'isolated agent dirs keep their own sub-agent state'
  )
})
