export type LoginSystem = 'tms' | 'almacen'

// Older Preview builds may have a WMS database without the deployment mode flag.
export function loginSystemForDatabase(supabaseUrl: string | undefined): LoginSystem | null {
  try {
    const url = new URL(supabaseUrl || '')
    if (url.protocol !== 'https:') return null
    if (url.hostname === 'eojfsbogysifxrlrnjvx.supabase.co') return 'tms'
    if (['rquujukgtturdlkuzgdc.supabase.co', 'glecgvomkaqmkfkhtxhi.supabase.co'].includes(url.hostname)) return 'almacen'
  } catch {}
  return null
}

export function remoteLoginUrl(system: LoginSystem, configuredOrigin: string | undefined, currentOrigin: string): string {
  const origin = configuredOrigin || (system === 'tms' ? 'https://jrm-tms.vercel.app' : '')
  let url: URL
  try { url = new URL(origin) } catch { throw new Error('El acceso a este sistema todavía no está configurado. Contacta al administrador.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin === currentOrigin) {
    throw new Error('La dirección de acceso a este sistema no es válida. Contacta al administrador.')
  }
  url.pathname = system === 'tms' ? '/login' : '/almacen/login'
  return url.href
}
