const hosts = new Set(['jrm-wms-staging.vercel.app', 'jrm-wms.vercel.app'])
export function validateWmsTarget(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.username || url.password || url.port || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('El robot requiere el sitio independiente jrm-wms-staging.vercel.app o jrm-wms.vercel.app.')
  }
  return url.origin
}
