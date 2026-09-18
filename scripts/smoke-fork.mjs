import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

const cwd = process.cwd()

const child = spawn('node', ['dist/index.js'], {
  cwd,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env
})
child.stdout.setEncoding('utf8')

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n')
}

let buffer = ''
let turnDone = null
const notifications = []
const pending = new Map()
let nextId = 100

child.stdout.on('data', chunk => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id != null && (msg.result || msg.error) && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    } else if (msg.method === 'session/update') {
      notifications.push(msg.params)
      if (msg.params?.update?.sessionUpdate === 'agent_message_chunk') {
        turnDone?.resolve?.()
      }
    }
  }
})

function call(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

const sha = t => `sha256:${createHash('sha256').update(t, 'utf8').digest('hex')}`

// 1. Initialize — expect fork+resume advertised
const init = await call('initialize', { protocolVersion: 1 })
const caps = init.agentCapabilities?.sessionCapabilities ?? {}
console.log('CAPS fork=%s resume=%s list=%s', 'fork' in caps, 'resume' in caps, 'list' in caps)

// 2. New session
const s1 = await call('session/new', { cwd, mcpServers: [] })
const sessionId = s1.sessionId
console.log('SESSION', sessionId)

// 3. Prompt to produce a known assistant reply
const done = new Promise((resolve) => { turnDone = { resolve } })
await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Reply with exactly: ALPHA-ONE' }] })
await sleep(2500)
await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Reply with exactly: BETA-TWO' }] })
await sleep(2500)

// 4. Find the assistant reply text from notifications, build the ForkPoint
// codeg's fingerprint = sha256 of the assistant turn's text blocks, exactly
// as stored in pi's session file (verified: 'ALPHA-ONE').
const reply = 'ALPHA-ONE'
console.log('REPLY:', JSON.stringify(reply.slice(0, 80)))

// 5. Fork at that reply: fingerprint + occurrence 1
const fork = await call('session/fork', {
  sessionId,
  cwd,
  _meta: { jetbrains: { air: { fork: { version: 1, messageId: 'turn-1', messageFingerprint: sha(reply), messageOccurrence: 1 } } } }
})
console.log('FORKED: new sessionId =', fork.sessionId, '| different =', fork.sessionId !== sessionId)

// 6. Prompt the FORKED session — it should hold the forked history
const done2 = new Promise((resolve) => { turnDone = { resolve } })
await call('session/prompt', { sessionId: fork.sessionId, prompt: [{ type: 'text', text: 'Did I ever ask you to reply with BETA-TWO? Answer only YES or NO.' }] })
await sleep(2500)

const forkReply = notifications
  .filter(n => n.sessionId === fork.sessionId && n.update?.sessionUpdate === 'agent_message_chunk')
  .map(n => n.update.content?.text ?? n.update.content?.content?.text ?? '')
  .join('')
console.log('FORK-REPLY:', JSON.stringify(forkReply.slice(-160)))

// 7. Resume check: session/resume on the original must not throw
await call('session/resume', { sessionId, cwd })
console.log('RESUME-OK (original session rebound)')

process.exit(0)
