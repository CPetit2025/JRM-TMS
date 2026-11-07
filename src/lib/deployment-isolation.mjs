export const WMS_PRODUCTION_REF = 'glecgvomkaqmkfkhtxhi'
export const WMS_STAGING_REF = 'rquujukgtturdlkuzgdc'

export function assertDeploymentIsolation(system, supabaseUrl, environment) {
  if (system !== undefined && system !== '' && system !== 'tms' && system !== 'wms') {
    throw new Error('Unknown deployment system')
  }
  if (system !== 'wms') return
  let url
  try { url = new URL(supabaseUrl) } catch { throw new Error('WMS requires its dedicated Supabase URL') }
  const allowed = environment === 'production' ? [WMS_PRODUCTION_REF] : [WMS_PRODUCTION_REF, WMS_STAGING_REF]
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed.some(ref => url.hostname === `${ref}.supabase.co`)) {
    throw new Error('WMS deployment blocked: database target is not an approved WMS project')
  }
}

export function wmsRouteAllowed(path, method) {
  if (path === '/api/app-version') return method === 'GET'
  if (path.startsWith('/api/') || path === '/api') return false
  return path === '/almacen' || path.startsWith('/almacen/') || path === '/perfil' || path === '/login/restablecer'
}
