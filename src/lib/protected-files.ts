// Existing stored public URLs remain references; viewing them requires the session and Storage RLS.
export function protectedFileHref(value: string): string {
  try {
    const url = new URL(value)
    const configured = process.env.NEXT_PUBLIC_SUPABASE_URL
    if (!configured || url.origin !== new URL(configured).origin) return /^https?:$/.test(url.protocol) ? value : '#'
    const match = url.pathname.match(/^\/storage\/v1\/object\/(?:public|sign)\/(evidence|signatures)\/(.+)$/)
    if (!match) return value
    return `/api/files?bucket=${match[1]}&path=${encodeURIComponent(decodeURIComponent(match[2]))}`
  } catch { return '#' }
}
