// Stale-while-revalidate list cache in sessionStorage: a page shows readCache() at once, loads fresh data and
// calls writeCache(). Only plain JSON (dates come back as strings). Keys must include the user id; clearCache() on sign-out.
const PREFIX = 'tms:cache:'
const TTL_MS = 5 * 60_000
const MAX_CHARS = 1_500_000 // ~3 MB in UTF-16; bigger payloads are simply not cached

export function readCache<T>(key: string): T | undefined {
  try {
    const raw = sessionStorage.getItem(PREFIX + key)
    if (!raw) return undefined
    const { at, data } = JSON.parse(raw) as { at: number; data: T }
    return Date.now() - at < TTL_MS ? data : undefined
  } catch { return undefined }
}

export function writeCache(key: string, data: unknown) {
  try {
    const raw = JSON.stringify({ at: Date.now(), data })
    if (raw.length <= MAX_CHARS) sessionStorage.setItem(PREFIX + key, raw)
    else sessionStorage.removeItem(PREFIX + key)
  } catch { /* quota or private mode: the cache is optional */ }
}

export function clearCache() {
  try { Object.keys(sessionStorage).filter(k => k.startsWith(PREFIX)).forEach(k => sessionStorage.removeItem(k)) } catch { /* ignore */ }
}
