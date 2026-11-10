// «Actualizar ahora» del ERP: pregunta a las bases TMS y WMS si alguien pidió una actualización e informa el resultado.
// No cambia las cargas a horas fijas: es una ejecución adicional (ver docs/carga-erp-automatica.md).
//   node solicitudes.mjs inicio                 -> imprime {"tms":id|null,"wms":id|null} si hay que ejecutar; nada si no
//   node solicitudes.mjs fin ok|error <mensaje>    (con ERP_SOLICITUD = el JSON de inicio; PowerShell 5 quita las comillas de un argumento JSON)
// Variables: TMS_SUPABASE_URL, TMS_SUPABASE_ANON, TMS_USUARIO, TMS_CLAVE y, si el WMS está instalado,
// WMS_SUPABASE_URL, WMS_SUPABASE_ANON, WMS_USUARIO, WMS_CLAVE.
const [cmd, ...rest] = process.argv.slice(2)
const env = process.env
const bases = [
  // En el TMS ninguna función privilegiada es anónima (prueba C55): ahí se pregunta con sesión.
  { key: 'tms', url: env.TMS_SUPABASE_URL, anon: env.TMS_SUPABASE_ANON, user: env.TMS_USUARIO, password: env.TMS_CLAVE, dueWithSession: true },
  { key: 'wms', url: env.WMS_SUPABASE_URL, anon: env.WMS_SUPABASE_ANON, user: env.WMS_USUARIO, password: env.WMS_CLAVE },
].filter(b => b.url && b.anon && b.user && b.password)
if (!['inicio', 'fin'].includes(cmd) || !bases.some(b => b.key === 'tms')) {
  console.error('Uso: node solicitudes.mjs inicio | fin ok|error <mensaje> con ERP_SOLICITUD (TMS_SUPABASE_URL, TMS_SUPABASE_ANON, TMS_USUARIO, TMS_CLAVE)')
  process.exit(2)
}

async function rpc(b, name, body, token = b.anon) {
  const r = await fetch(`${b.url.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: b.anon, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`${b.key} ${name}: ${text}`)
  return text ? JSON.parse(text) : null
}
// Igual que el login de la web: sin arroba se usa el dominio de JRM (y el antiguo como respaldo)
async function login(b) {
  const emails = b.user.includes('@') ? [b.user] : [`${b.user}@jrmsac.com.pe`, `${b.user}@jrm.com`]
  let reason = ''
  for (const email of emails) {
    const r = await fetch(`${b.url.replace(/\/$/, '')}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: b.anon, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: b.password }),
    })
    if (r.ok) return (await r.json()).access_token
    const body = await r.json().catch(() => ({}))
    reason = body.error_description || body.msg || body.message || `HTTP ${r.status}`
  }
  throw new Error(`No se pudo iniciar sesión ${b.key.toUpperCase()} con la cuenta del robot (${emails[0]}: ${reason})`)
}

try {
  if (cmd === 'inicio') {
    // Cada minuto solo se pregunta si toca (la mayoría de las veces, no); en el WMS sin sesión.
    const runs = {}
    for (const b of bases) {
      // Una base caída no impide atender la otra
      try {
        const token = b.dueWithSession ? await login(b) : undefined
        if (await rpc(b, 'erp_robot_due', {}, token)) runs[b.key] = (await rpc(b, 'erp_robot_start', {}, token || await login(b)))?.id ?? null
      }
      catch (e) { console.error('ERROR ' + (e instanceof Error ? e.message : e)) }
    }
    if (Object.values(runs).some(Boolean)) console.log(JSON.stringify(runs))
  } else {
    const [result, ...message] = rest
    const runs = JSON.parse(env.ERP_SOLICITUD || '{}')
    for (const b of bases) if (runs[b.key]) await rpc(b, 'erp_robot_finish', { p_id: Number(runs[b.key]), p_ok: result === 'ok', p_message: message.join(' ') }, await login(b))
  }
} catch (e) {
  console.error('ERROR ' + (e instanceof Error ? e.message : e))
  process.exitCode = 1
}
