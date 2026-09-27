#!/usr/bin/env node
// Stand-in for the `pi` binary in smoke tests (point PI_ACP_PI_COMMAND at this file).
// Proxies pi's RPC stdin/stdout unchanged and, optionally:
// - PI_SHIM_LOG=<file>: logs every command and every non-streaming event.
// - PI_SHIM_HOLD_STEER=settled|end: holds each `steer` command until pi emits
//   `agent_settled` (or `agent_end`), to force the steering turn-end race.
// - PI_SHIM_RELEASE_DELAY_MS=<ms>: waits this long after that event before
//   releasing the held commands (widens the window in which the turn is settling).
// - PI_SHIM_REAL_PI=<cmd>: the real pi command (default `pi`).
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import readline from 'node:readline'

const logFile = process.env.PI_SHIM_LOG
const holdUntil = process.env.PI_SHIM_HOLD_STEER
const releaseOn = holdUntil === 'end' ? 'agent_end' : holdUntil === 'settled' ? 'agent_settled' : null
const realPi = process.env.PI_SHIM_REAL_PI ?? 'pi'
const releaseDelayMs = Number(process.env.PI_SHIM_RELEASE_DELAY_MS ?? 0)

const child = spawn(realPi, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'inherit'] })
const held = []

function log(dir, line) {
  if (logFile) appendFileSync(logFile, `${new Date().toISOString()} ${dir} ${line}\n`)
}

function typeOf(line) {
  try {
    return JSON.parse(line)?.type
  } catch {
    return undefined
  }
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  if (releaseOn && typeOf(line) === 'steer') {
    log('HELD', line.slice(0, 400))
    held.push(line)
    return
  }
  log('>>', line.slice(0, 400))
  child.stdin.write(`${line}\n`)
})

readline.createInterface({ input: child.stdout }).on('line', line => {
  process.stdout.write(`${line}\n`)
  const type = typeOf(line)
  if (type && type !== 'message_update' && type !== 'tool_execution_update') log('<<', line.slice(0, 400))
  if (releaseOn && type === releaseOn && held.length) {
    const release = held.splice(0, held.length)
    setTimeout(() => {
      for (const h of release) {
        log('>> released', h.slice(0, 400))
        child.stdin.write(`${h}\n`)
      }
    }, releaseDelayMs)
  }
})

process.stdin.on('end', () => child.stdin.end())
child.on('exit', code => process.exit(code ?? 1))
