// Habla con la base WMS para saber si toca actualizar ingresos y para informar el resultado.
//   node robot.mjs inicio            -> imprime {"id":..,"kind":..} si hay que ejecutar; nada si no toca
//   node robot.mjs fin <id> ok|error <mensaje>
// Variables: WMS_SUPABASE_URL, WMS_SUPABASE_ANON, WMS_USUARIO, WMS_CLAVE.
const [cmd, ...rest] = process.argv.slice(2)
const { WMS_SUPABASE_URL: base, WMS_SUPABASE_ANON: anon, WMS_USUARIO: user, WMS_CLAVE: password } = process.env
if (!base || !anon || !user || !password || !['inicio', 'fin'].includes(cmd)) {
  console.error('Uso: node robot.mjs inicio | fin <id> ok|error <mensaje> (WMS_SUPABASE_URL, WMS_SUPABASE_ANON, WMS_USUARIO, WMS_CLAVE)')
  process.exit(2)
}

async function rpc(name, body, token = anon) {
  const r = await fetch(`${base}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: anon, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`${name}: ${text}`)
  return text ? JSON.parse(text) : null
}

// Igual que el login de la web: sin arroba se usa el dominio de JRM (y el antiguo como respaldo)
async function login() {
  const emails = user.includes('@') ? [user] : [`${user}@jrmsac.com.pe`, `${user}@jrm.com`]
  let reason = ''
  for (const email of emails) {
    const r = await fetch(`${base}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: anon, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
    })
    if (r.ok) return (await r.json()).access_token
    const body = await r.json().catch(() => ({}))
    reason = body.error_description || body.msg || body.message || `HTTP ${r.status}`
  }
  throw new Error(`No se pudo iniciar sesión WMS con la cuenta del robot (${emails[0]}: ${reason}); revise la cuenta o vuelva a guardarla.`)
}

try {
  if (cmd === 'inicio') {
    // Sin sesión: cada minuto solo se pregunta si toca (la mayoría de las veces, no)
    // Sin process.exit: en Windows, cortar Node con una conexión de fetch abierta lo hace fallar (UV_HANDLE_CLOSING)
    if (await rpc('wh_receipt_robot_due', {})) {
      const run = await rpc('wh_receipt_robot_start', {}, await login())
      if (run) console.log(JSON.stringify(run))
    }
  } else {
    const [id, result, ...message] = rest
    await rpc('wh_receipt_robot_finish', { p_id: Number(id), p_ok: result === 'ok', p_message: message.join(' ') }, await login())
  }
} catch (e) {
  console.error('ERROR ' + (e instanceof Error ? e.message : e))
  process.exitCode = 1
}
