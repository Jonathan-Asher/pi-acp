import test from 'node:test'
import assert from 'node:assert/strict'
import { toolResultImages, toolResultToText, withoutImageData } from '../../src/acp/translate/pi-tools.js'

test('toolResultToText: extracts text from content blocks', () => {
  const text = toolResultToText({
    content: [
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' }
    ]
  })
  assert.equal(text, 'hello world')
})

test('toolResultToText: prefers details.diff when present', () => {
  const text = toolResultToText({
    content: [{ type: 'text', text: 'Successfully replaced 2 block(s) in a.txt.' }],
    details: { diff: '--- a\n+++ b\n' }
  })
  assert.equal(text, '--- a\n+++ b\n')
})

test('toolResultToText: falls back to JSON', () => {
  const text = toolResultToText({ a: 1 })
  assert.match(text, /"a": 1/)
})

test('toolResultToText: extracts bash stdout/stderr from details', () => {
  const text = toolResultToText({
    details: {
      stdout: 'ok\n',
      stderr: 'warn\n',
      exitCode: 0
    }
  })
  assert.match(text, /ok/)
  assert.match(text, /stderr:/)
  assert.match(text, /warn/)
  assert.match(text, /exit code: 0/)
})

test('toolResultImages: turns image blocks into ACP image content', () => {
  const images = toolResultImages({
    content: [
      { type: 'text', text: 'Read image file [image/png]' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      { type: 'image', data: '', mimeType: 'image/png' }
    ]
  })
  assert.deepEqual(images, [
    { type: 'content', content: { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' } }
  ])
  assert.deepEqual(toolResultImages({ content: [{ type: 'text', text: 'x' }] }), [])
  assert.deepEqual(toolResultImages(undefined), [])
})

test('withoutImageData: drops image bytes and keeps everything else', () => {
  const result = {
    content: [
      { type: 'text', text: 't' },
      { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }
    ],
    details: { a: 1 }
  }
  assert.deepEqual(withoutImageData(result), {
    content: [
      { type: 'text', text: 't' },
      { type: 'image', mimeType: 'image/jpeg' }
    ],
    details: { a: 1 }
  })
  const plain = { content: [{ type: 'text', text: 't' }] }
  assert.equal(withoutImageData(plain), plain)
})

test('toolResultToText: an image-only result is not dumped as JSON', () => {
  assert.equal(toolResultToText({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }), '')
})
