/**
 * The AIR async-task extension (`_meta.jetbrains.air`, capability `asyncTasks`),
 * as the other AIR adapters (codex-acp among them) speak it: background work is announced as
 * `async_task_spawned`, reported with `async_task_progress`, ended with
 * `async_task_state_update`, and stopped by the client with
 * `_session/async_task/stop`.
 *
 * pi-acp publishes three kinds of work through it, and only to a client that
 * advertised the capability:
 * - `turn`: a run pi started by itself (the AIR "autonomous turn");
 *   Stop interrupts it;
 * - `shell`: a pi-bg-jobs job; Stop runs `/bgj-kill <id>`;
 * - `subagent` / `workflow`: an async pi-subagents run; Stop runs
 *   `/subagents-stop <run id>`.
 */
import { compact, isRecord, str, type JsonRecord } from './wire.js'

export const ASYNC_TASK_STOP_METHOD = '_session/async_task/stop'
export const AIR_ASYNC_TASKS = 'asyncTasks'

export type AsyncTaskState = 'running' | 'completed' | 'failed' | 'stopped'
export type AsyncTaskKind = 'turn' | 'shell' | 'subagent' | 'workflow'

/** The `air` object of a `_meta`, when the peer sent the AIR extension. */
function airMeta(meta: unknown): JsonRecord | undefined {
  if (!isRecord(meta)) return undefined
  const jetbrains = meta.jetbrains
  const air = isRecord(jetbrains) ? jetbrains.air : undefined
  return isRecord(air) ? air : undefined
}

/** Whether the client is an AIR speaker: it declared `_meta.jetbrains.air` in its capabilities. */
export function isAirClient(clientCapabilities: unknown): boolean {
  return isRecord(clientCapabilities) && airMeta(clientCapabilities._meta) !== undefined
}

/** Whether the client advertised the AIR `asyncTasks` capability. */
export function clientSupportsAsyncTasks(clientCapabilities: unknown): boolean {
  if (!isRecord(clientCapabilities)) return false
  const air = airMeta(clientCapabilities._meta)
  const version = air?.version
  const capabilities = air?.capabilities
  return (
    typeof version === 'number' &&
    Number.isInteger(version) &&
    version >= 1 &&
    Array.isArray(capabilities) &&
    capabilities.includes(AIR_ASYNC_TASKS)
  )
}

export type AsyncTaskSpec = {
  id: string
  kind: AsyncTaskKind
  name: string
  description: string
  toolCallId?: string
  outputFilePath?: string
  canStop?: boolean
}

export type AsyncTaskProgress = {
  description?: string
  summary?: string
  lastToolName?: string
  usage?: { totalTokens: number; toolUses: number; durationMs: number }
}

type Task = AsyncTaskSpec & { state: AsyncTaskState; published: Map<string, string>; lastProgressAt: number }

/** Every running task gets a frame at least this often, so a client's keep-alive does not lapse. */
export const HEARTBEAT_MS = 10 * 60 * 1000
/** Progress (as opposed to state) frames per task at most this often. */
export const PROGRESS_MIN_INTERVAL_MS = 10 * 1000

export class AirTasks {
  private readonly tasks = new Map<string, Task>()
  private heartbeat: ReturnType<typeof setInterval> | undefined

  constructor(
    readonly enabled: boolean,
    private readonly send: (update: JsonRecord) => void,
    private readonly now: () => number = Date.now
  ) {}

  has(id: string): boolean {
    return this.tasks.has(id)
  }

  kindOf(id: string): AsyncTaskKind | undefined {
    return this.tasks.get(id)?.kind
  }

  isRunning(id: string): boolean {
    return this.tasks.get(id)?.state === 'running'
  }

  spawn(spec: AsyncTaskSpec): void {
    if (!this.enabled || this.tasks.has(spec.id)) return
    const task: Task = { ...spec, state: 'running', published: new Map(), lastProgressAt: this.now() }
    this.tasks.set(spec.id, task)
    this.send(
      compact({
        sessionUpdate: 'async_task_spawned',
        asyncTaskId: spec.id,
        name: spec.name,
        taskType: spec.kind,
        description: spec.description,
        showInTranscript: false,
        canStop: spec.canStop ?? true,
        outputFilePath: spec.outputFilePath,
        toolCallId: spec.toolCallId
      })
    )
    record(task, { description: spec.description })
    this.armHeartbeat()
  }

  /** Report what changed since the last frame; nothing new sends nothing (unless `force`). */
  progress(id: string, update: AsyncTaskProgress, opts: { force?: boolean } = {}): void {
    const task = this.tasks.get(id)
    if (!task || task.state !== 'running') return
    const now = this.now()
    if (!opts.force && now - task.lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return
    const changed = changedFields(task, update)
    if (Object.keys(changed).length === 0 && !opts.force) return
    task.lastProgressAt = now
    this.send({ sessionUpdate: 'async_task_progress', asyncTaskId: id, ...changed })
    record(task, changed)
  }

  finish(id: string, state: Exclude<AsyncTaskState, 'running'>, summary?: string): void {
    const task = this.tasks.get(id)
    if (!task || task.state !== 'running') return
    task.state = state
    this.send(compact({ sessionUpdate: 'async_task_state_update', asyncTaskId: id, state, summary: str(summary) }))
    if (![...this.tasks.values()].some(t => t.state === 'running')) this.disarmHeartbeat()
  }

  /** End every running task (the pi process is gone). */
  finishAll(state: Exclude<AsyncTaskState, 'running'>): void {
    for (const task of this.tasks.values()) {
      if (task.state === 'running') this.finish(task.id, state)
    }
    this.disarmHeartbeat()
  }

  dispose(): void {
    this.disarmHeartbeat()
  }

  private armHeartbeat(): void {
    if (this.heartbeat) return
    this.heartbeat = setInterval(() => {
      for (const task of this.tasks.values()) {
        if (task.state !== 'running') continue
        task.lastProgressAt = this.now()
        this.send({ sessionUpdate: 'async_task_progress', asyncTaskId: task.id })
      }
    }, HEARTBEAT_MS)
    this.heartbeat.unref?.()
  }

  private disarmHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }
}

function changedFields(task: Task, update: AsyncTaskProgress): JsonRecord {
  const out: JsonRecord = {}
  for (const [key, value] of Object.entries(update)) {
    if (value === undefined) continue
    if (task.published.get(key) === JSON.stringify(value)) continue
    out[key] = value
  }
  return out
}

function record(task: Task, fields: JsonRecord): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) task.published.set(key, JSON.stringify(value))
  }
}
