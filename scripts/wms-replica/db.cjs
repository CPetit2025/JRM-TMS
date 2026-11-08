// Conexión directa con el usuario temporal que crea la CLI de Supabase (sin contraseñas guardadas).
const { execFileSync } = require('node:child_process')
const { Client } = require('pg')
const REFS = { tms: 'eojfsbogysifxrlrnjvx', staging: 'rquujukgtturdlkuzgdc', wms: 'glecgvomkaqmkfkhtxhi' }
function cred(name) {
  const out = execFileSync('supabase', ['db', 'dump', `--remote=${REFS[name]}`, '--dry-run', '-s', 'public'], { encoding: 'utf8', cwd: 'C:/Users/cpetit/JRM-TMS', shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const v = k => (out.match(new RegExp(`export ${k}="?([^"\n]*)"?`)) || [])[1]
  return { host: v('PGHOST'), port: Number(v('PGPORT') || 5432), user: v('PGUSER'), password: v('PGPASSWORD'), database: v('PGDATABASE') || 'postgres', ssl: { rejectUnauthorized: false } }
}
// Destino de la copia: usuario temporal wms_replica_copy (lo crea y borra el usuario dueño; contraseña en COPY_PASSWORD)
// Origen de la copia: usuario temporal de solo lectura wms_replica_read en el TMS (contraseña en READ_PASSWORD)
function copyCred(name) { const c = cred(name); return name === 'tms'
  ? { ...c, user: `wms_replica_read.${REFS.tms}`, password: process.env.READ_PASSWORD }
  : { ...c, user: `wms_replica_copy.${REFS[name]}`, password: process.env.COPY_PASSWORD } }
async function connect(name, opts = {}) { const c = new Client({ ...(opts.copy ? copyCred(name) : cred(name)), application_name: 'fase4-replica', statement_timeout: 0 }); await c.connect(); return c }
module.exports = { connect, REFS }
