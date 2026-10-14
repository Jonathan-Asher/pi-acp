import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PI_THINKING_LEVELS,
  isThinkingLevel,
  normalizeReportedLevels,
  thinkingLevelsForModel
} from '../../src/acp/thinking-levels.js'

test('thinking levels: vocabulary matches pi, max included', () => {
  assert.deepEqual([...PI_THINKING_LEVELS], ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(isThinkingLevel('max'), true)
  assert.equal(isThinkingLevel('xhigh'), true)
  assert.equal(isThinkingLevel('ultra'), false)
})

test('thinking levels: model without a map offers the standard levels only', () => {
  assert.deepEqual(thinkingLevelsForModel({ reasoning: true }), ['off', 'minimal', 'low', 'medium', 'high'])
})

test('thinking levels: non-reasoning model offers only off', () => {
  assert.deepEqual(thinkingLevelsForModel({ reasoning: false, thinkingLevelMap: { max: 'max' } }), ['off'])
})

test('thinking levels: null hides a level and xhigh/max need an explicit entry', () => {
  assert.deepEqual(
    thinkingLevelsForModel({
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' }
    }),
    ['low', 'high', 'max']
  )
  assert.deepEqual(thinkingLevelsForModel({ reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' } }), [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh'
  ])
})

test('thinking levels: unknown reasoning capability yields null', () => {
  assert.equal(thinkingLevelsForModel({ provider: 'test', id: 'x' }), null)
  assert.equal(thinkingLevelsForModel(null), null)
})

test('thinking levels: reported levels keep pi order and drop junk', () => {
  assert.deepEqual(normalizeReportedLevels(['low', 'high', 'max', 'max', '', 3]), ['low', 'high', 'max'])
  assert.equal(normalizeReportedLevels([]), null)
  assert.equal(normalizeReportedLevels(undefined), null)
})
