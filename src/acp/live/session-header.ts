import { closeSync, openSync, readSync } from 'node:fs'

const CACHE_MAX = 2048
const HEAD_BYTES = 16 * 1024
const ids = new Map<string, string>()

/**
 * The id in a pi session file's header line: what codeg opens a sub-agent
 * child's transcript by. Undefined while the file does not exist yet (pi
 * creates a child's session lazily), so callers ask again later; hits are cached.
 */
export function sessionHeaderId(file: string): string | undefined {
  const cached = ids.get(file)
  if (cached) return cached
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const line = buf.subarray(0, n).toString('utf8').split('\n')[0] ?? ''
    const header = JSON.parse(line) as { type?: unknown; id?: unknown }
    const id = header?.type === 'session' && typeof header.id === 'string' ? header.id : undefined
    if (id) {
      if (ids.size >= CACHE_MAX) ids.delete(ids.keys().next().value!)
      ids.set(file, id)
    }
    return id
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }
}
