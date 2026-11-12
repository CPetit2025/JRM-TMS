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
  if (path === '/api/admin/wms') return method === 'GET' || method === 'POST'
  if (path === '/api/app-version') return method === 'GET'
  if (path === '/api/wms/sincronizar') return method === 'POST'
  // Cron del servidor (Vercel Cron con CRON_SECRET): sincroniza con el TMS sin navegadores abiertos
  if (path === '/api/wms/tms-cron') return method === 'GET'
  if (path === '/api/wms/erp-aplicar') return method === 'POST'
  // Cadena del modelo de almacén (fase 4): derivar el día, inventario y APT, con la llave de servicio de la base WMS
  if (['/api/erp/aplicar', '/api/inventario/procesar', '/api/apt/procesar'].includes(path)) return method === 'POST'
  if (path.startsWith('/api/') || path === '/api') return false
  return path === '/almacen' || path.startsWith('/almacen/') || path === '/perfil' || path === '/login/restablecer'
}
