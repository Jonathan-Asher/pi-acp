// Live smoke test for `_session/steering` against a real pi (uses pi's default model).
//
//   npm run build && node scripts/smoke-steer.mjs [--race=settled|end] [--cwd=<dir>]
//
// Without --race the steer reaches pi while the turn runs. With --race the steer is
// held (scripts/pi-rpc-shim.mjs) until pi has settled (or ended its agent loop), which
// forces the turn-end race. Either way the steered message must be answered inside
// the same `session/prompt`, which must resolve exactly once.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? '1']
  })
)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cwd = args.cwd ?? '/tmp/pi-acp-steer-smoke'
mkdirSync(cwd, { recursive: true })
const shimLog = join(cwd, `shim-${Date.now()}.log`)

const env = { ...process.env }
if (args.race) {
  env.PI_ACP_PI_COMMAND = join(root, 'scripts', 'pi-rpc-shim.mjs')
  env.PI_SHIM_HOLD_STEER = args.race
  env.PI_SHIM_LOG = shimLog
}

const child = spawn('node', [join(root, 'dist', 'index.js')], { cwd, stdio: ['pipe', 'pipe', 'inherit'], env })
child.stdout.setEncoding('utf8')

let nextId = 1
const waiting = new Map()
const responses = new Map()
const updates = []
const listeners = []

function request(method, params) {
  const id = nextId++
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject, method }))
}

let buffer = ''
child.stdout.on('data', chunk => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.id != null && (msg.result !== undefined || msg.error)) {
      responses.set(msg.id, (responses.get(msg.id) ?? 0) + 1)
      const w = waiting.get(msg.id)
      waiting.delete(msg.id)
      if (w) msg.error ? w.reject(new Error(`${w.method}: ${JSON.stringify(msg.error)}`)) : w.resolve(msg.result)
    } else if (msg.method === 'session/update') {
      const u = msg.params.update
      updates.push({ at: Date.now(), u })
      for (const l of listeners) l(u)
    } else if (msg.id != null && msg.method) {
      // Client-side requests (permissions etc.): allow once.
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'cancelled' } } })}\n`)
    }
  }
})

const timeout = setTimeout(() => {
  console.error('TIMEOUT')
  child.kill()
  process.exit(2)
}, 240_000)

const text = u => (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text' ? u.content.text : '')

try {
  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  console.log('agentInfo', init.agentInfo, 'steering', init._meta?.steering)
  if (init._meta?.steering?.supported !== true) throw new Error('steering not advertised')

  const { sessionId } = await request('session/new', { cwd, mcpServers: [] })
  const steer = t =>
    request('_session/steering', {
      sessionId,
      prompt: [{ type: 'text', text: t }],
      _meta: { steering: { idleBehavior: 'promptRequired' } }
    })

  const idle = await steer('idle check')
  console.log('idle steer ->', idle)
  if (idle.outcome !== 'promptRequired') throw new Error('idle steer must be promptRequired')

  const turnStart = Date.now()
  const promptId = nextId
  const prompt = request('session/prompt', {
    sessionId,
    prompt: [
      {
        type: 'text',
        text:
          'Run these three shell commands one at a time, as three separate bash tool calls, waiting for each ' +
          'to finish before starting the next: `sleep 2; echo step1`, `sleep 2; echo step2`, `sleep 2; echo step3`. ' +
          'Then reply with one short sentence.'
      }
    ]
  })

  // Steer once the first tool call is under way.
  const steerSent = new Promise(resolve => {
    listeners.push(u => {
      if (u.sessionUpdate === 'tool_call' && !resolve.done) {
        resolve.done = true
        resolve(Date.now())
      }
    })
  })
  const steeredAt = await steerSent
  const steerRes = await steer('Additional instruction: end your final reply with the single word PINEAPPLE.')
  console.log('mid-turn steer ->', steerRes, `(+${steeredAt - turnStart} ms)`)

  const done = await prompt
  const doneAt = Date.now()
  await new Promise(r => setTimeout(r, 1500))

  const after = updates.filter(x => x.at >= steeredAt)
  const replyAfterSteer = after.map(x => text(x.u)).join('')
  const lastChunkAt = Math.max(0, ...updates.filter(x => text(x.u)).map(x => x.at))
  const summary = {
    race: args.race ?? null,
    stopReason: done.stopReason,
    promptResponses: responses.get(promptId),
    steerOutcome: steerRes.outcome,
    pineappleAfterSteer: /PINEAPPLE/i.test(replyAfterSteer),
    promptResolvedAfterLastChunk: doneAt >= lastChunkAt,
    turnMs: doneAt - turnStart,
    tailOfReply: replyAfterSteer.slice(-160),
    shimLog: args.race ? shimLog : null
  }
  console.log(JSON.stringify(summary, null, 2))
  const ok =
    summary.stopReason === 'end_turn' &&
    summary.promptResponses === 1 &&
    summary.steerOutcome === 'injected' &&
    summary.pineappleAfterSteer
  console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED')
  process.exitCode = ok ? 0 : 1
} catch (e) {
  console.error(e)
  process.exitCode = 1
} finally {
  clearTimeout(timeout)
  child.kill()
}
