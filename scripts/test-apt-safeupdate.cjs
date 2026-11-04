// En Supabase las consultas que llegan por la API (PostgREST, p. ej. /api/apt/procesar) pasan por pg_safeupdate: un DELETE
// o UPDATE sin WHERE falla con «DELETE requires a WHERE clause», también dentro de funciones y triggers. Desde pg_cron o
// una migración sí funciona, por eso el error solo aparece en la carga. Revisa la última definición de las funciones que
// corren en la carga del APT por la API.
const assert = require('node:assert/strict')
const { readFileSync, readdirSync } = require('node:fs')
const path = require('node:path')

const dir = path.join(__dirname, '../supabase/migrations')
const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
function latest(name) {
  let body = null
  for (const f of files) {
    const s = readFileSync(path.join(dir, f), 'utf8')
    const re = new RegExp('CREATE (?:OR REPLACE )?FUNCTION public\\.' + name + '\\(', 'g')
    for (let m; (m = re.exec(s));) { const b = s.indexOf('$$', m.index); body = { f, sql: s.slice(b + 2, s.indexOf('$$', b + 2)) } }
  }
  if (!body) throw new Error('No se encontró ' + name)
  return body
}

// Lo que ejecuta /api/apt/procesar: aplicar, estadía y flujo (con el trigger del Gantt al terminar el flujo)
for (const name of ['apt_upload_apply_core', 'apt_rebuild', 'apt_flow_rebuild_core', 'apt_gantt_refresh']) {
  const { f, sql } = latest(name)
  const sinComentarios = sql.replace(/--[^\n]*/g, '')
  const bare = sinComentarios.split(';').map(s => s.trim().replace(/\s+/g, ' '))
    .filter(s => /^(DELETE|UPDATE)\b/i.test(s) && !/\bWHERE\b/i.test(s))
  assert.deepEqual(bare, [], `${name} (${f}) tiene sentencias sin WHERE que pg_safeupdate rechaza`)
}
console.log('test-apt-safeupdate OK')
