// Conexión directa con el usuario temporal que crea la CLI de Supabase (sin contraseñas guardadas).
const { execFileSync } = require('node:child_process')
const { Client } = require('pg')
const REFS = { tms: 'eojfsbogysifxrlrnjvx', staging: 'rquujukgtturdlkuzgdc', wms: 'glecgvomkaqmkfkhtxhi' }
function cred(name) {
  const out = execFileSync('supabase', ['db', 'dump', `--remote=${REFS[name]}`, '--dry-run', '-s', 'public'], { encoding: 'utf8', cwd: 'C:/Users/cpetit/JRM-TMS', shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const v = k => (out.match(new RegExp(`export ${k}="?([^"\n]*)"?`)) || [])[1]
  return { host: v('PGHOST'), port: Number(v('PGPORT') || 5432), user: v('PGUSER'), password: v('PGPASSWORD'), database: v('PGDATABASE') || 'postgres', ssl: { rejectUnauthorized: false } }
}
async function connect(name) { const c = new Client({ ...cred(name), application_name: 'fase4-replica', statement_timeout: 0 }); await c.connect(); return c }
module.exports = { connect, REFS }
