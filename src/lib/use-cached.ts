// Stale-while-revalidate list cache in sessionStorage: a page shows readCache() at once, loads fresh data and
// calls writeCache(). Only plain JSON (dates come back as strings). clearCache() on sign-out.
// Each entry belongs to the signed-in user (read from the Supabase session cookie): another tab may switch users,
// so an entry of another identity is never shown. Without an identifiable user nothing is cached.
const PREFIX = 'tms:cache:'
const TTL_MS = 5 * 60_000
const MAX_CHARS = 1_500_000 // ~3 MB in UTF-16; bigger payloads are simply not cached

export function sessionUserId(cookie = typeof document === 'undefined' ? '' : document.cookie): string | null {
  try {
    const parts = cookie.split(/;\s*/).map(c => c.split('=')).filter(([k]) => /^sb-.+-auth-token(\.\d+)?$/.test(k))
      .sort(([a], [b]) => Number(a.split('.').pop()) - Number(b.split('.').pop()))
    if (!parts.length) return null
    let value = decodeURIComponent(parts.map(([, ...v]) => v.join('=')).join(''))
    if (value.startsWith('base64-')) value = atob(value.slice(7).replace(/-/g, '+').replace(/_/g, '/'))
    const id = JSON.parse(value)?.user?.id
    return typeof id === 'string' && id ? id : null
  } catch { return null }
}

export function readCache<T>(key: string): T | undefined {
  try {
    const user = sessionUserId(); if (!user) return undefined
    const raw = sessionStorage.getItem(PREFIX + key)
    if (!raw) return undefined
    const { at, data, user: owner } = JSON.parse(raw) as { at: number; data: T; user?: string }
    return owner === user && Date.now() - at < TTL_MS ? data : undefined
  } catch { return undefined }
}

export function writeCache(key: string, data: unknown) {
  try {
    const user = sessionUserId(); if (!user) { sessionStorage.removeItem(PREFIX + key); return }
    const raw = JSON.stringify({ at: Date.now(), user, data })
    if (raw.length <= MAX_CHARS) sessionStorage.setItem(PREFIX + key, raw)
    else sessionStorage.removeItem(PREFIX + key)
  } catch { /* quota or private mode: the cache is optional */ }
}

export function clearCache() {
  try { Object.keys(sessionStorage).filter(k => k.startsWith(PREFIX)).forEach(k => sessionStorage.removeItem(k)) } catch { /* ignore */ }
}
