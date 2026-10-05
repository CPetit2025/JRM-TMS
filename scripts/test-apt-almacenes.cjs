// PostgreSQL aislado: funciones reales y datos sintéticos; nunca conecta a Supabase.
// CI usa Docker. Sin Docker se puede indicar JRM_PGLITE_MODULE (instalación externa).
const {readFileSync} = require('node:fs')
const {spawnSync} = require('node:child_process')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const name = `jrm-apt-almacenes-${process.pid}`
const read = file => readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n')
function run(args, input) {
  const result = spawnSync('docker', args, {input, encoding: 'utf8'})
  if (result.status !== 0) throw Error(result.stderr || result.stdout || String(result.error))
  return result.stdout
}
function fn(source, name) {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  assert.ok(start >= 0, `Missing function ${name}`)
  return source.slice(start, source.indexOf('$$;', start) + 3)
}
async function main() {
  let db
  let dockerStarted = false
  try {
    if (process.env.JRM_PGLITE_MODULE) {
      const {PGlite} = require(process.env.JRM_PGLITE_MODULE)
      db = new PGlite()
    } else {
      run(['run', '-d', '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:16-alpine'])
      dockerStarted = true
      let ready = false
      for (let n = 0; n < 40; n++) {
        if (spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status === 0) {ready = true; break}
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      assert.ok(ready, 'Scratch PostgreSQL did not become ready')
      db = {
        exec: async input => run(['exec', '-i', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], input),
        query: async input => ({rows: [{result: JSON.parse(run(['exec', '-i', name, 'psql', '-U', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1'], input))}]}),
      }
    }
    const base = read('supabase/migrations/20261002100000_apt_estadia_inventario.sql')
    const latest = read('supabase/migrations/20261002110000_apt_cliente_ot_lote.sql')
    const flow = read('supabase/migrations/20261003100000_apt_flujo_multialmacen.sql')
    const migration = read('supabase/migrations/20261007120000_apt_filtro_almacenes.sql')
    await db.exec(base.slice(base.indexOf('CREATE TABLE IF NOT EXISTS public.apt_uploads'), base.indexOf('-- Lectura directa')) + `
      ALTER TABLE apt_layers ADD COLUMN cliente text;
      ALTER TABLE apt_movements ADD COLUMN almacen text;
      CREATE FUNCTION apt_can_view() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    ` + ['apt_num', 'apt_date', 'apt_lote_tipo', 'apt_arr', 'apt_like'].map(name => fn(base, name)).join('\n') +
      fn(flow, 'apt_almacen') + fn(latest, 'apt_filtered') + fn(latest, 'apt_group') + fn(latest, 'apt_detail') + `
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      REVOKE ALL ON FUNCTION apt_filtered(jsonb) FROM PUBLIC, anon, authenticated;
      GRANT EXECUTE ON FUNCTION apt_filtered(jsonb) TO service_role;
      CREATE TABLE expected_acl AS SELECT proacl FROM pg_proc WHERE oid='apt_filtered(jsonb)'::regprocedure;
      INSERT INTO apt_uploads(id,file_name) VALUES('11111111-1111-1111-1111-111111111111','fixture');
      INSERT INTO apt_movements(upload_id,kind,row_no,raw,active,valid,fecha,lote,producto,peso_kg,almacen,bodega)
      SELECT '11111111-1111-1111-1111-111111111111','ENTRADA',i,'{}',true,true,'2026-01-01',
        'ZZ-APT-'||CASE WHEN i<=3 THEN 1 ELSE 2 END,'P',i*1000,
        CASE i WHEN 1 THEN '647' WHEN 2 THEN '540' WHEN 3 THEN 'ST' END,
        CASE WHEN i=4 THEN '540-04 APT LB' END FROM generate_series(1,6)i;
      INSERT INTO apt_layers(movement_id,lote,producto,fecha_ingreso,kg_in,kg_out,kg_saldo,estado,tn_dias,cliente)
      SELECT id,lote,producto,fecha,peso_kg,CASE WHEN row_no=6 THEN peso_kg ELSE row_no*100 END,
        CASE WHEN row_no=6 THEN 0 ELSE peso_kg-row_no*100 END,'En APT',row_no*10,
        CASE WHEN row_no IN (2,4) THEN 'ACME' ELSE 'OTHER' END FROM apt_movements;
      UPDATE apt_state SET cutoff='2026-01-31';
    `)
    const detail = async (filters = {}, level = 'capa', limit = 20000, offset = 0) => {
      const json = JSON.stringify(filters).replaceAll("'", "''")
      const result = await db.query(`SELECT apt_detail('${json}'::jsonb,'${level}','kg_in',false,${limit},${offset}) AS result`)
      return result.rows[0].result
    }
    const levels = ['capa','lote','producto','glosa','familia','numrel_op','ipt','contrato','cliente']
    const before = await Promise.all(levels.map(level => detail({}, level)))
    await db.exec(migration)
    await db.exec(migration) // Idempotente y conserva permisos.
    await db.exec(`DO $$ BEGIN
      IF (SELECT proacl FROM pg_proc WHERE oid='apt_filtered(jsonb)'::regprocedure)
        IS DISTINCT FROM (SELECT proacl FROM expected_acl) THEN RAISE EXCEPTION 'ACL changed'; END IF;
    END $$;`)
    assert.deepEqual(await Promise.all(levels.map(level => detail({}, level))), before, 'Unfiltered behavior changed')
    assert.deepEqual(await detail({almacenes: []}), before[0], 'Clearing must restore all rows')
    for (const [almacen, ids] of [['647',[1,5,6]], ['540',[2,4]], ['ST',[3]]]) {
      const result = await detail({almacenes: [almacen]})
      assert.deepEqual(result.rows.map(row => row.id), ids, `Warehouse ${almacen}`)
      for (const level of levels.slice(1)) {
        const grouped = await detail({almacenes: [almacen]}, level)
        assert.deepEqual(grouped.totals, result.totals, `${almacen}/${level} totals`)
      }
    }
    const combined = await detail({almacenes:['540','ST']})
    assert.equal(combined.total, 3)
    assert.equal(combined.totals.tn_in, 9)
    assert.equal(combined.totals.tn_saldo, 8.1)
    const paged = await detail({almacenes:['540','ST']}, 'capa', 1, 1)
    assert.deepEqual(paged.totals, combined.totals, 'Totals must cover the full filtered set')
    assert.equal(paged.total, 3)
    assert.equal(paged.rows.length, 1)
    assert.equal(paged.rows[0].id, 3)
    assert.equal((await detail({almacenes:['540','ST'], clientes:['ACME']})).total, 2)
    assert.equal((await detail({almacenes:['647'], solo_saldo:true})).total, 2)
    assert.equal((await detail({almacenes:['UNKNOWN']})).total, 0)
    // Producción puede tener bodega sin la columna opcional almacen.
    await db.exec("ALTER TABLE apt_movements DROP COLUMN almacen; UPDATE apt_movements SET bodega='540-04 APT LB' WHERE id=2;")
    assert.deepEqual((await detail({almacenes:['540']})).rows.map(row => row.id), [2,4])
    console.log('PASS: almacenes individual/múltiple; nueve niveles; totales, paginación y exportación; filtros combinados; legado sin almacen; ACL e idempotencia.')
  } finally {
    if (db?.close) await db.close()
    if (dockerStarted) spawnSync('docker', ['rm', '-f', name], {stdio:'ignore'})
  }
}
main().catch(error => {console.error(error); process.exitCode = 1})
