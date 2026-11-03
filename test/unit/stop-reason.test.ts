import test from 'node:test'
import assert from 'node:assert/strict'
import { RequestError } from '@agentclientprotocol/sdk'
import { assistantStopOf, piStopError, turnOutcome } from '../../src/acp/stop-reason.js'

test('stop reason: length maps to max_tokens', () => {
  assert.deepEqual(turnOutcome({ stopReason: 'length' }, false), { stopReason: 'max_tokens' })
})

test('stop reason: stop, toolUse, aborted and no message end the turn normally', () => {
  for (const stopReason of ['stop', 'toolUse', 'aborted', 'deferred', undefined]) {
    assert.deepEqual(turnOutcome({ stopReason }, false), { stopReason: 'end_turn' }, String(stopReason))
  }
  assert.deepEqual(turnOutcome(null, false), { stopReason: 'end_turn' })
})

test('stop reason: an error becomes a JSON-RPC error with pi errorMessage', () => {
  const outcome = turnOutcome({ stopReason: 'error', errorMessage: '529 overloaded_error: Overloaded' }, false)
  assert.ok('error' in outcome)
  assert.ok(outcome.error instanceof RequestError)
  assert.equal(outcome.error.code, -32603)
  assert.equal(outcome.error.message, 'Internal error: 529 overloaded_error: Overloaded')
})

test('stop reason: an error without a message still says the provider failed', () => {
  const outcome = turnOutcome({ stopReason: 'error' }, false)
  assert.ok('error' in outcome)
  assert.equal(outcome.error.message, 'Internal error: The model provider returned an error')
  assert.equal(piStopError('   ').message, 'Internal error: The model provider returned an error')
})

test('stop reason: a provider refusal maps to refusal', () => {
  assert.deepEqual(
    turnOutcome({ stopReason: 'error', rawStopReason: 'refusal', errorMessage: 'The model refused' }, false),
    { stopReason: 'refusal' }
  )
})

test('stop reason: a requested cancel wins over every stop', () => {
  for (const stopReason of ['length', 'error', 'stop', 'aborted']) {
    assert.deepEqual(turnOutcome({ stopReason, errorMessage: 'x' }, true), { stopReason: 'cancelled' }, stopReason)
  }
  assert.deepEqual(turnOutcome(null, true), { stopReason: 'cancelled' })
})

test('stop reason: only assistant messages carry a stop', () => {
  assert.deepEqual(
    assistantStopOf({
      role: 'assistant',
      stopReason: 'length',
      content: [],
      errorMessage: 7,
      rawStopReason: 'max_tokens'
    }),
    { stopReason: 'length', errorMessage: undefined, rawStopReason: 'max_tokens' }
  )
  assert.equal(assistantStopOf({ role: 'user', content: 'hi' }), null)
  assert.equal(assistantStopOf({ role: 'toolResult', stopReason: 'error' }), null)
  assert.equal(assistantStopOf(null), null)
  assert.equal(assistantStopOf('assistant'), null)
})
