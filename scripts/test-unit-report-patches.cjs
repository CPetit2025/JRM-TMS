const assert = require('node:assert/strict')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const name = `jrm-unit-report-${process.pid}`
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
function docker(args, input) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 180000 })
  if (result.error) throw result.error
  if (result.status) throw new Error(result.stderr || result.stdout)
  return result.stdout
}
function fn(source, name) {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  assert.ok(start >= 0, `function ${name} exists`)
  const end = source.indexOf('END $$;', start)
  assert.ok(end > start, `function ${name} has an end`)
  return source.slice(start, end + 'END $$;'.length)
}
function patch(source, marker) {
  const anchor = source.indexOf(marker)
  assert.ok(anchor >= 0, `patch anchor ${marker} exists`)
  const start = source.indexOf('DO $patch$', anchor)
  const end = source.indexOf('END $patch$;', start)
  assert.ok(start > anchor && end > start, `patch block after ${marker} exists`)
  return source.slice(start, end + 'END $patch$;'.length)
}
function sql(input) { return docker(['exec', '-i', name, 'psql', '-U', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], input).trim() }

try {
  docker(['run', '-d', '--rm', '--network', 'none', '--name', name, '-e', 'POSTGRES_PASSWORD=isolated-test', 'postgres:16-alpine'])
  let ready = false
  for (let i = 0; i < 40; i++) {
    try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
  }
  assert.ok(ready, 'PostgreSQL starts')

  const base = read('supabase/migrations/20261024090000_reporte_unidad_km_referencias.sql')
  sql(fn(base, 'unit_daily_report'))
  sql(patch(read('supabase/migrations/20261209080000_referencia_proveedor_y_reporte_costos.sql'), '-- Agrega proveedor y origen'))
  sql(patch(read('supabase/migrations/20261209100000_km_ruta_odometro_y_reporte.sql'), '-- Expone kilómetros por OT'))

  const definition = sql("SELECT pg_get_functiondef('public.unit_daily_report(text,date,date)'::regprocedure)")
  for (const token of ['reference_supplier', 'pickup_address', 'fuel_gallons', 'km_real_source', 'odo_reading', 'odo_photo']) {
    assert.ok(definition.includes(token), `patched report includes ${token}`)
  }
  console.log('PASS: both production SQL patches compile against the current report and expose suppliers, addresses, fuel allocation, km source and odometer evidence.')
} finally {
  spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' })
}
