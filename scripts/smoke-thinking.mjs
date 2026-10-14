// Smoke test for per-model thinking levels over ACP.
//
// For each model: switch to it, print the thinking levels pi-acp advertises, then set each
// requested level, print the level pi settled on, and send a tiny prompt with it.
//
//   node scripts/smoke-thinking.mjs fireworks/accounts/fireworks/models/glm-5p3-flash baseten/zai-org/GLM-5.3
//
// Env: LEVELS (default "xhigh,max"), PROMPT, PI_ACP_BIN (default dist/index.js),
// SMOKE_CWD (default a fresh temp dir). The ACP session is deleted at the end.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const models = process.argv.slice(2)
const levels = (process.env.LEVELS ?? 'xhigh,max')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
const promptText = process.env.PROMPT ?? 'Reply with the single word OK.'
const bin = process.env.PI_ACP_BIN ?? 'dist/index.js'
const cwd = process.env.SMOKE_CWD ?? mkdtempSync(join(tmpdir(), 'pi-acp-thinking-'))

const child = spawn('node', [bin], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env })
child.stdout.setEncoding('utf8')

let nextId = 1
const pending = new Map()
let buffer = ''
let turn = { answer: '', thought: '' }
child.stdout.on('data', chunk => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(Object.assign(new Error(msg.error.message), { data: msg.error.data }))
      else resolve(msg.result)
      continue
    }
    const update = msg.params?.update
    const text = typeof update?.content?.text === 'string' ? update.content.text : ''
    if (update?.sessionUpdate === 'agent_message_chunk') turn.answer += text
    if (update?.sessionUpdate === 'agent_thought_chunk') turn.thought += text
  }
})

function request(method, params) {
  const id = nextId++
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

const thought = configOptions => configOptions?.find(o => o.id === 'thought_level')
const log = obj => console.log(JSON.stringify(obj))

let sessionId
try {
  await request('initialize', { protocolVersion: 1 })
  const created = await request('session/new', { cwd, mcpServers: [] })
  sessionId = created.sessionId
  const initial = thought(created.configOptions)
  log({
    event: 'session',
    model: created.models?.currentModelId,
    thinking: initial?.currentValue,
    levels: initial?.options.map(o => o.value)
  })

  for (const model of models) {
    const switched = await request('session/set_config_option', { sessionId, configId: 'model', value: model })
    const option = thought(switched.configOptions)
    log({ event: 'model', model, thinking: option?.currentValue, levels: option?.options.map(o => o.value) })

    for (const level of levels) {
      let effective
      try {
        const set = await request('session/set_config_option', { sessionId, configId: 'thought_level', value: level })
        effective = thought(set.configOptions)?.currentValue
      } catch (e) {
        log({ event: 'set', model, requested: level, error: e.message })
        continue
      }
      turn = { answer: '', thought: '' }
      const started = Date.now()
      const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: promptText }] })
      log({
        event: 'prompt',
        model,
        requested: level,
        effective,
        stopReason: result?.stopReason,
        ms: Date.now() - started,
        thoughtChars: turn.thought.length,
        answer: turn.answer.trim().slice(0, 200)
      })
    }
  }
} catch (e) {
  log({ event: 'failed', error: e.message })
  process.exitCode = 1
} finally {
  if (sessionId) await request('session/delete', { sessionId }).catch(() => {})
  child.kill('SIGTERM')
}
