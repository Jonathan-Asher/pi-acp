import type { ToolCallContent } from '@agentclientprotocol/sdk'

/**
 * The images in a pi tool result (its `ImageContent` blocks, e.g. what `read`
 * returns for a picture), as ACP tool-call content.
 */
export function toolResultImages(result: unknown): ToolCallContent[] {
  const content = (result as any)?.content
  if (!Array.isArray(content)) return []
  return content
    .filter((c: any) => c?.type === 'image' && typeof c.data === 'string' && c.data && typeof c.mimeType === 'string')
    .map((c: any) => ({ type: 'content', content: { type: 'image', data: c.data, mimeType: c.mimeType } }))
}

/**
 * `result` without its image data — what goes in `rawOutput` once the images
 * travel as tool-call content, so a picture is not sent twice.
 */
export function withoutImageData(result: unknown): unknown {
  const content = (result as any)?.content
  if (!Array.isArray(content) || !content.some((c: any) => c?.type === 'image')) return result
  return {
    ...(result as object),
    content: content.map((c: any) => (c?.type === 'image' ? { type: 'image', mimeType: c.mimeType } : c))
  }
}

export function toolResultToText(result: unknown): string {
  if (!result) return ''

  const details = (result as any)?.details

  // pi's edit tool returns a terse success message in content and the full unified diff in details.diff.
  const diff = details?.diff
  if (typeof diff === 'string' && diff.trim()) {
    return diff
  }

  // pi tool results generally look like: { content: [{type:"text", text:"..."}], details: {...} }
  const content = (result as any).content
  if (Array.isArray(content)) {
    const texts = content
      .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
    if (texts.length) return texts.join('')
  }

  // The bash tool frequently returns stdout/stderr in `details` rather than content blocks.
  const stdout =
    (typeof details?.stdout === 'string' ? details.stdout : undefined) ??
    (typeof (result as any)?.stdout === 'string' ? (result as any).stdout : undefined) ??
    (typeof details?.output === 'string' ? details.output : undefined) ??
    (typeof (result as any)?.output === 'string' ? (result as any).output : undefined)

  const stderr =
    (typeof details?.stderr === 'string' ? details.stderr : undefined) ??
    (typeof (result as any)?.stderr === 'string' ? (result as any).stderr : undefined)

  const exitCode =
    (typeof details?.exitCode === 'number' ? details.exitCode : undefined) ??
    (typeof (result as any)?.exitCode === 'number' ? (result as any).exitCode : undefined) ??
    (typeof details?.code === 'number' ? details.code : undefined) ??
    (typeof (result as any)?.code === 'number' ? (result as any).code : undefined)

  if ((typeof stdout === 'string' && stdout.trim()) || (typeof stderr === 'string' && stderr.trim())) {
    const parts: string[] = []
    if (typeof stdout === 'string' && stdout.trim()) parts.push(stdout)
    if (typeof stderr === 'string' && stderr.trim()) parts.push(`stderr:\n${stderr}`)
    if (typeof exitCode === 'number') parts.push(`exit code: ${exitCode}`)
    return parts.join('\n\n').trimEnd()
  }

  // An image-only result has no text to show; never dump its base64.
  if (toolResultImages(result).length) return ''

  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}
