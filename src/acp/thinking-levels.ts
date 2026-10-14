/** pi's thinking-level vocabulary, in pi's own order (`THINKING_LEVEL_OPTIONS`). */
export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type ThinkingLevel = (typeof PI_THINKING_LEVELS)[number]

export function isThinkingLevel(x: string): x is ThinkingLevel {
  return (PI_THINKING_LEVELS as readonly string[]).includes(x)
}

type ModelLike = {
  reasoning?: unknown
  thinkingLevelMap?: unknown
}

/**
 * The levels pi offers for `model`, derived the way pi-ai's `getSupportedThinkingLevels` does:
 * a `null` map entry hides a level, and `xhigh`/`max` need an explicit entry to appear.
 *
 * Used when pi predates the `get_available_thinking_levels` RPC command (added in pi 0.81.0).
 * Returns null when the model object does not say whether it reasons.
 */
export function thinkingLevelsForModel(model: unknown): ThinkingLevel[] | null {
  if (!model || typeof model !== 'object') return null
  const { reasoning, thinkingLevelMap } = model as ModelLike
  if (typeof reasoning !== 'boolean') return null
  if (!reasoning) return ['off']

  const map =
    thinkingLevelMap && typeof thinkingLevelMap === 'object' ? (thinkingLevelMap as Record<string, unknown>) : {}

  return PI_THINKING_LEVELS.filter(level => {
    const mapped = map[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

/** Keep the strings pi reported, in pi's order, dropping anything that is not a level name. */
export function normalizeReportedLevels(levels: unknown): string[] | null {
  if (!Array.isArray(levels)) return null
  const names = levels.filter((level): level is string => typeof level === 'string' && level.trim() !== '')
  return names.length ? [...new Set(names)] : null
}
