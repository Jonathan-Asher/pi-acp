// Live check of exact, strict, mid-run session/fork against the real pi.
//
//   SMOKE_CWD=/tmp/pi-edit-test node scripts/smoke-fork-exact.mjs
//
// Builds a two-turn session, then forks it the ways codeg does:
//   1. at the first reply by entry id (an edit of the second message) and
//      continues there with new text;
//   2. at the second reply by fingerprint alone;
//   3. at a point that names nothing (must fail with invalid_params);
//   4. at the first reply from a SECOND adapter process while the source runs
//      a turn (fork while running), and checks the source still finishes.
// Prints one JSON line per check and exits non-zero on the first failure.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const bin = process.env.PI_ACP_BIN ?? 'dist/index.js'
const cwd = process.env.SMOKE_CWD ?? '/tmp/pi-edit-test'
mkdirSync(cwd, { recursive: true })
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')

class Adapter {
  constructor(name) {
    this.name = name
    this.child = spawn('node', [bin], { cwd, stdio: ['pipe', 'pipe', 'inherit'], env: process.env })
    this.child.stdout.setEncoding('utf8')
    this.nextId = 1
    this.pending = new Map()
    this.answers = new Map()
    let buffer = ''
    this.child.stdout.on('data', chunk => {
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
        if (msg.id !== undefined && this.pending.has(msg.id) && !msg.method) {
          const { resolve, reject } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (msg.error) reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }))
          else resolve(msg.result)
          continue
        }
        if (msg.method === 'session/request_permission') {
          const option = msg.params?.options?.find(o => o.kind?.startsWith('allow')) ?? msg.params?.options?.[0]
          this.child.stdin.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { outcome: { outcome: 'selected', optionId: option?.optionId } }
            }) + '\n'
          )
          continue
        }
        const update = msg.params?.update
        if (update?.sessionUpdate === 'agent_message_chunk' && typeof update.content?.text === 'string') {
          const sid = msg.params.sessionId
          this.answers.set(sid, (this.answers.get(sid) ?? '') + update.content.text)
        }
      }
    })
  }
  request(method, params) {
    const id = this.nextId++
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  async prompt(sessionId, text) {
    this.answers.set(sessionId, '')
    await this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
    return this.answers.get(sessionId) ?? ''
  }
  close() {
    this.child.stdin.end()
    this.child.kill()
  }
}

function findSessionFile(sessionId) {
  const root = join(agentDir, 'sessions')
  for (const dir of readdirSync(root)) {
    let names
    try {
      names = readdirSync(join(root, dir))
    } catch {
      continue
    }
    const hit = names.find(n => n.endsWith(`_${sessionId}.jsonl`))
    if (hit) return join(root, dir, hit)
  }
  throw new Error(`no session file for ${sessionId}`)
}

function entries(sessionId) {
  const lines = readFileSync(findSessionFile(sessionId), 'utf8').split('\n').filter(Boolean)
  return lines.map(l => JSON.parse(l))
}
const messages = es => es.filter(e => e.type === 'message')
const roles = es => messages(es).map(e => e.message.role)
const textOf = e =>
  (e.message.content ?? [])
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('')
const fp = text => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
const forkMeta = fork => ({ jetbrains: { air: { fork: { version: 1, ...fork } } } })

function check(name, ok, detail = {}) {
  console.log(JSON.stringify({ check: name, ok, ...detail }))
  if (!ok) {
    process.exitCode = 1
    throw new Error(`check failed: ${name}`)
  }
}

const a = new Adapter('a')
let b
try {
  const init = await a.request('initialize', { protocolVersion: 1 })
  check(
    'advertises strict, mid-run forks',
    init?._meta?.forkPoint?.strict === true && init._meta.forkPoint.whileRunning === true,
    {
      version: init?.agentInfo?.version
    }
  )
  const { sessionId: src } = await a.request('session/new', { cwd, mcpServers: [] })
  if (process.env.MODEL) {
    await a.request('session/set_config_option', { sessionId: src, configId: 'model', value: process.env.MODEL })
  }
  if (process.env.THINKING) {
    await a.request('session/set_config_option', {
      sessionId: src,
      configId: 'thought_level',
      value: process.env.THINKING
    })
  }
  await a.prompt(src, 'Reply with exactly the word ALPHA and nothing else.')
  await a.prompt(src, 'Reply with exactly the word BETA and nothing else.')
  const before = entries(src)
  const assistants = messages(before).filter(e => e.message.role === 'assistant')
  check('source has two turns', roles(before).filter(r => r === 'user').length === 2 && assistants.length >= 2, {
    roles: roles(before)
  })
  const firstReply = assistants[0]
  const lastReply = assistants[assistants.length - 1]

  // 1. Edit of the second message: fork at the first reply by entry id.
  const edit = await a.request('session/fork', {
    sessionId: src,
    cwd,
    mcpServers: [],
    _meta: forkMeta({ messageId: firstReply.id })
  })
  const editEntries = entries(edit.sessionId)
  check('edit fork ends at the first reply', messages(editEntries).at(-1)?.id === firstReply.id, {
    roles: roles(editEntries)
  })
  check('edit fork names its parent', editEntries[0].parentSession === findSessionFile(src))
  const edited = await a.prompt(edit.sessionId, 'Reply with exactly the word GAMMA and nothing else.')
  const afterEdit = entries(edit.sessionId)
  check('edited branch continues from the first reply', roles(afterEdit).filter(r => r === 'user').length === 2, {
    answer: edited.trim(),
    lastUser: textOf(
      messages(afterEdit)
        .filter(e => e.message.role === 'user')
        .at(-1)
    )
  })
  check('source untouched by the edit', entries(src).length === before.length)

  // 2. Fork from the last reply by fingerprint only (an older parse).
  const byText = await a.request('session/fork', {
    sessionId: src,
    cwd,
    mcpServers: [],
    _meta: forkMeta({ messageId: 'turn-3', messageFingerprint: fp(textOf(lastReply)), messageOccurrence: 1 })
  })
  check('fingerprint fork ends at the last reply', messages(entries(byText.sessionId)).at(-1)?.id === lastReply.id)

  // 3. A point that names nothing is refused.
  let refused = null
  try {
    await a.request('session/fork', { sessionId: src, cwd, mcpServers: [], _meta: forkMeta({ messageId: 'turn-9' }) })
  } catch (e) {
    refused = e
  }
  check('unresolvable point is invalid_params', refused?.code === -32602, { message: refused?.message })

  // 4. Fork while the source runs a turn, from another adapter process.
  const running = a.prompt(src, 'Count from 1 to 40, one number per line, nothing else.')
  await new Promise(r => setTimeout(r, 1500))
  b = new Adapter('b')
  await b.request('initialize', { protocolVersion: 1 })
  const midRun = await b.request('session/fork', {
    sessionId: src,
    cwd,
    mcpServers: [],
    _meta: forkMeta({ messageId: firstReply.id })
  })
  check('mid-run fork ends at the first reply', messages(entries(midRun.sessionId)).at(-1)?.id === firstReply.id)
  b.close()
  const counted = await running
  const afterRun = entries(src)
  check(
    'source turn finished intact',
    roles(afterRun).filter(r => r === 'user').length === 3 && counted.includes('40'),
    {
      tail: counted.trim().split('\n').slice(-1)[0]
    }
  )

  console.log(
    JSON.stringify({ sessions: [src, edit.sessionId, byText.sessionId, midRun.sessionId].map(findSessionFile) })
  )
} finally {
  a.close()
  b?.close()
}
