import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { PiRpcEvent, PromptDisposition, PromptOptions } from '../../src/pi-rpc/process.js'

type SessionUpdateMsg = Parameters<AgentSideConnection['sessionUpdate']>[0]

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = []
  readonly permissionRequests: unknown[] = []
  nextPermissionResponse: { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } = {
    outcome: { outcome: 'selected', optionId: 'allow' }
  }

  async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    this.updates.push(msg)
  }

  async requestPermission(
    params: unknown
  ): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    this.permissionRequests.push(params)
    return this.nextPermissionResponse
  }
}

export class FakePiRpcProcess {
  private handlers: Array<(ev: PiRpcEvent) => void> = []

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[] }> = []
  readonly promptOptions: PromptOptions[] = []
  readonly extensionUiResponses: unknown[] = []
  abortCount = 0
  /** What pi answers each prompt with, in order; then `defaultDisposition`. */
  dispositions: Array<PromptDisposition | undefined> = []
  defaultDisposition: PromptDisposition | undefined = undefined
  /** Extension commands `get_commands` lists. */
  commands: Array<{ name: string; source?: string }> = []
  entries: unknown[] = []
  leafId: string | null = null
  private exitHandlers: Array<(info: { code: number | null; signal: NodeJS.Signals | null }) => void> = []

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  emit(ev: PiRpcEvent) {
    for (const h of this.handlers) h(ev)
  }

  async prompt(
    message: string,
    attachments: unknown[] = [],
    opts: PromptOptions = {}
  ): Promise<PromptDisposition | undefined | void> {
    this.prompts.push({ message, attachments })
    this.promptOptions.push(opts)
    if (this.promptError) throw this.promptError
    return this.dispositions.length ? this.dispositions.shift() : this.defaultDisposition
  }

  onExit(handler: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): () => void {
    this.exitHandlers.push(handler)
    return () => {
      this.exitHandlers = this.exitHandlers.filter(h => h !== handler)
    }
  }

  /** The pi child exits. */
  exit(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    for (const h of this.exitHandlers) h({ code, signal })
  }

  async getCommands(): Promise<any> {
    return { commands: this.commands }
  }

  async getEntries(): Promise<{ entries: unknown[]; leafId: string | null }> {
    return { entries: this.entries, leafId: this.leafId }
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }

  // Steering: a stand-in for pi's steering queue (`_steeringMessages`), which pi
  // reports through `queue_update` events.
  readonly steers: Array<{ message: string; images: unknown[] }> = []
  steeringQueue: string[] = []
  clearQueueCount = 0
  // Holds a `steer` command "on the wire" until resolved, to model the turn-end race.
  steerGate: Promise<void> | null = null
  steerError: Error | null = null
  promptError: Error | null = null

  async steer(message: string, images: unknown[] = []): Promise<void> {
    this.steers.push({ message, images })
    if (this.steerGate) await this.steerGate
    if (this.steerError) throw this.steerError
    this.steeringQueue.push(message)
    this.emit({ type: 'queue_update', steering: [...this.steeringQueue], followUp: [] })
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    this.clearQueueCount += 1
    const steering = this.steeringQueue.splice(0, this.steeringQueue.length)
    this.emit({ type: 'queue_update', steering: [], followUp: [] })
    return { steering, followUp: [] }
  }

  /** pi's agent loop turns the next queued steering message into a user message. */
  deliverSteer(): string | undefined {
    const text = this.steeringQueue.shift()
    this.emit({ type: 'queue_update', steering: [...this.steeringQueue], followUp: [] })
    this.emit({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }] } })
    return text
  }

  async sendExtensionUiResponse(response: unknown): Promise<void> {
    this.extensionUiResponses.push(response)
  }

  async getState(): Promise<any> {
    return {}
  }

  async getAvailableModels(): Promise<any> {
    return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  }

  async getMessages(): Promise<any> {
    return { messages: [] }
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AgentSideConnection {
  // We only implement the method(s) used by PiAcpSession in tests.
  return conn as unknown as AgentSideConnection
}
