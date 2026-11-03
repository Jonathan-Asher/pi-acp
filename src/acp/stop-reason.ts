import { RequestError, type StopReason } from '@agentclientprotocol/sdk'

/** The part of pi's last assistant message that decides how the ACP turn ends. */
export type PiAssistantStop = {
  /** pi-ai's `StopReason`: `stop`, `toolUse`, `length`, `error`, `aborted`, ... */
  stopReason?: string
  errorMessage?: string
  /** The provider's own stop reason, when pi kept it (Anthropic's `refusal`). */
  rawStopReason?: string
}

/** How a `session/prompt` ends: a stop reason, or a JSON-RPC error. */
export type TurnOutcome = { stopReason: StopReason } | { error: RequestError }

/** Reads the stop fields off a pi `message_end` message; `null` unless it is an assistant message. */
export function assistantStopOf(message: unknown): PiAssistantStop | null {
  if (!message || typeof message !== 'object') return null
  const m = message as Record<string, unknown>
  if (m.role !== 'assistant') return null
  const text = (key: string): string | undefined => (typeof m[key] === 'string' ? (m[key] as string) : undefined)
  return {
    stopReason: text('stopReason'),
    errorMessage: text('errorMessage'),
    rawStopReason: text('rawStopReason')
  }
}

/**
 * Map the last assistant message of a settled pi run to the ACP turn outcome.
 *
 * - `length`: the model used its whole output budget (`maxTokens`), often on thinking alone,
 *   so the reply is cut off. ACP calls that `max_tokens`.
 * - `error` with the provider's `refusal`: ACP's `refusal`.
 * - any other `error`: the provider call failed (after pi's own retries). ACP has no error stop
 *   reason, so the prompt is answered with a JSON-RPC error carrying pi's `errorMessage`.
 * - everything else, including no assistant message at all: `end_turn`.
 *
 * A cancel the client asked for wins over all of them.
 */
export function turnOutcome(last: PiAssistantStop | null, cancelRequested: boolean): TurnOutcome {
  if (cancelRequested) return { stopReason: 'cancelled' }
  switch (last?.stopReason) {
    case 'length':
      return { stopReason: 'max_tokens' }
    case 'error':
      if (last.rawStopReason === 'refusal') return { stopReason: 'refusal' }
      return { error: piStopError(last.errorMessage) }
    default:
      return { stopReason: 'end_turn' }
  }
}

/** The JSON-RPC error for a turn pi ended with an error: pi's own message, as the client shows it. */
export function piStopError(message: string | undefined): RequestError {
  const text = message?.trim()
  return RequestError.internalError(undefined, text || 'The model provider returned an error')
}
