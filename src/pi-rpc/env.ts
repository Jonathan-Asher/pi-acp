import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * pi-subagents keeps its async run state and its result-delivery files under
 * `PI_SUBAGENTS_TEMP_ROOT`, else under `os.tmpdir()`. ACP clients may give each
 * launch its own TMPDIR and delete it when the launch ends (codeg does). Those
 * files would then vanish with the launch, and a reconnected pi could no longer
 * see sub-agent runs that are still in flight or deliver their results.
 *
 * So the pi child gets a stable folder in pi's agent dir, unless the user
 * already chose one.
 */
export const SUBAGENTS_TEMP_ROOT_ENV = 'PI_SUBAGENTS_TEMP_ROOT'

/** pi's agent dir: `PI_CODING_AGENT_DIR` (with `~` expanded, as pi does), else `~/.pi/agent`. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim()
  if (!configured) return join(homedir(), '.pi', 'agent')
  if (configured === '~') return homedir()
  if (configured.startsWith('~/')) return join(homedir(), configured.slice(2))
  return resolve(configured)
}

/** The stable sub-agent temp root this adapter uses when none is configured. */
export function defaultSubagentsTempRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(piAgentDir(env), 'subagents-tmp')
}

/** Environment for the pi child process. Never mutates `env`. */
export function piChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (env[SUBAGENTS_TEMP_ROOT_ENV]?.trim()) return env
  return { ...env, [SUBAGENTS_TEMP_ROOT_ENV]: defaultSubagentsTempRoot(env) }
}
