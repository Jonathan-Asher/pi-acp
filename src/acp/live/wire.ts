/**
 * Shared vocabulary of the `_meta.piAcp.*` live channel: the structured data
 * this adapter sends next to pi's model-facing text, so a client can render
 * sub-agent runs, background jobs, extension notices and turns pi started by
 * itself without parsing prose. Every shape carries `version: 1`.
 */

export const LIVE_VERSION = 1

/** Advertised in `initialize` as `_meta.piAcp.capabilities` (each value is that shape's version). */
export function liveCapabilities(): Record<string, number> {
  return {
    version: LIVE_VERSION,
    agentTurns: LIVE_VERSION,
    customMessages: LIVE_VERSION,
    subagents: LIVE_VERSION,
    backgroundJobs: LIVE_VERSION,
    compaction: LIVE_VERSION,
    extensionCommands: LIVE_VERSION,
    replay: LIVE_VERSION
  }
}

/** A notice's text as forwarded (the model-facing words, for a "what the model saw" view). */
export const NOTICE_TEXT_MAX_CHARS = 4000
/** A child's task, result or error on its row (the same cap codeg's history fold uses). */
export const ROW_TEXT_MAX_CHARS = 4000
/** Serialized `details` / `data` forwarded with a notice or entry. */
export const DETAILS_MAX_BYTES = 32 * 1024

export type JsonRecord = Record<string, unknown>

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Cut `text` to `max` characters; `truncated` says whether anything was cut. */
export function clipText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: `${text.slice(0, Math.max(0, max - 1))}…`, truncated: true }
}

export function clip(text: string | undefined, max: number): string | undefined {
  return text === undefined ? undefined : clipText(text, max).text
}

/** `value` if its JSON fits in `maxBytes`; otherwise nothing, and `truncated`. */
export function boundedJson(value: unknown, maxBytes = DETAILS_MAX_BYTES): { value: unknown; truncated: boolean } {
  if (value === undefined) return { value: undefined, truncated: false }
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    return { value: undefined, truncated: true }
  }
  if (json === undefined) return { value: undefined, truncated: false }
  if (Buffer.byteLength(json, 'utf8') > maxBytes) return { value: undefined, truncated: true }
  return { value, truncated: false }
}

/** The text of a pi message `content` (a string, or text blocks). */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

export function firstLine(text: string, max = 160): string {
  const line = text.split('\n').find(l => l.trim()) ?? ''
  return clipText(line.trim(), max).text
}

/** Drop keys whose value is `undefined`, so payloads stay small and stable to compare. */
export function compact<T extends JsonRecord>(value: T): T {
  const out: JsonRecord = {}
  for (const [key, v] of Object.entries(value)) {
    if (v !== undefined) out[key] = v
  }
  return out as T
}
