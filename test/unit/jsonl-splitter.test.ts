import test from 'node:test'
import assert from 'node:assert/strict'
import { JsonlLineSplitter } from '../../src/pi-rpc/process.js'

function split(chunks: Array<Buffer | string>, end = true): string[] {
  const lines: string[] = []
  const splitter = new JsonlLineSplitter(line => lines.push(line))
  for (const chunk of chunks) splitter.push(chunk)
  if (end) splitter.end()
  return lines
}

test('jsonl: U+2028 and U+2029 inside a JSON string do not split the record', () => {
  const LS = String.fromCharCode(0x2028)
  const PS = String.fromCharCode(0x2029)
  const text = `a${LS}b${PS}c`
  const record = JSON.stringify({ type: 'message_end', text })
  assert.ok(record.includes(LS), 'JSON.stringify keeps the separators as raw characters')
  const lines = split([`${record}\n`])
  assert.equal(lines.length, 1)
  assert.deepEqual(JSON.parse(lines[0]!), { type: 'message_end', text })
})

test('jsonl: records split across chunks, and CRLF, come out whole', () => {
  const a = JSON.stringify({ n: 1, s: 'x'.repeat(100) })
  const b = JSON.stringify({ n: 2 })
  const text = `${a}\r\n${b}\n`
  const lines = split([text.slice(0, 10), text.slice(10, 70), text.slice(70)])
  assert.deepEqual(
    lines.map(l => JSON.parse(l).n),
    [1, 2]
  )
})

test('jsonl: a multi-byte character cut between two chunks is decoded once whole', () => {
  const bytes = Buffer.from(`${JSON.stringify({ s: 'שלום ✅' })}\n`, 'utf8')
  const cut = bytes.indexOf(Buffer.from('✅', 'utf8')) + 1
  const lines = split([bytes.subarray(0, cut), bytes.subarray(cut)])
  assert.deepEqual(JSON.parse(lines[0]!), { s: 'שלום ✅' })
})

test('jsonl: a last record without a newline is delivered at end', () => {
  assert.deepEqual(split(['{"a":1}\n{"b":2}']), ['{"a":1}', '{"b":2}'])
  assert.deepEqual(split(['{"a":1}\n{"b":2}'], false), ['{"a":1}'])
})
