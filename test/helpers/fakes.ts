import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { PiRpcEvent } from '../../src/pi-rpc/process.js'

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
  readonly extensionUiResponses: unknown[] = []
  abortCount = 0

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  emit(ev: PiRpcEvent) {
    for (const h of this.handlers) h(ev)
  }

  async prompt(message: string, attachments: unknown[] = []): Promise<void> {
    this.prompts.push({ message, attachments })
    if (this.promptError) throw this.promptError
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
