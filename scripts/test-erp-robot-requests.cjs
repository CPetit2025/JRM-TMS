// «Actualizar ahora» del ERP y estado del banner (PGlite, sin producción).
const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
;(async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '00000000-0000-4000-8000-000000000001'::uuid $$;
      CREATE FUNCTION apt_can_load() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('test.load', true) = 'on' $$;
      CREATE FUNCTION is_active_tms_user() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
      CREATE TABLE erp_imports(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text, status text, created_at timestamptz DEFAULT now(), applied_at timestamptz);
      INSERT INTO erp_imports(kind,status,created_at,applied_at) VALUES ('STOCK','ACTIVA',now()-interval '2 hours',now()-interval '2 hours'),('CONTRATOS','ACTIVA',now()-interval '3 hours',now()-interval '3 hours');
      SELECT set_config('test.load','on',false);`)
    await db.exec(readFileSync('supabase/migrations/20261231130000_erp_robot_solicitudes.sql', 'utf8'))
    await db.exec(readFileSync('supabase/migrations/20261231140000_erp_robot_due_sin_anon.sql', 'utf8'))
    const one = async s => Object.values((await db.query(s)).rows[0])[0]
    assert.equal(await one('SELECT public.erp_robot_due()'), false, 'sin solicitud no toca')
    const r1 = await one('SELECT public.erp_robot_request()'), r2 = await one('SELECT public.erp_robot_request()')
    assert.equal(r1.existing, false); assert.equal(r2.existing, true); assert.equal(r2.id, r1.id, 'una sola solicitud abierta')
    assert.equal(await one('SELECT public.erp_robot_due()'), true, 'con solicitud pendiente toca')
    // Una carga horaria en curso: el pedido manual espera, no se pisan.
    await db.exec(`INSERT INTO erp_imports(kind,status) VALUES ('STOCK','CARGANDO')`)
    assert.equal(await one('SELECT public.erp_robot_due()'), false, 'espera a la carga horaria')
    await db.exec(`UPDATE erp_imports SET status='ACTIVA', applied_at=now() WHERE status='CARGANDO'`)
    const run = await one('SELECT public.erp_robot_start()')
    assert.equal(run.id, r1.id); assert.equal(await one('SELECT public.erp_robot_start()'), null, 'nunca dos a la vez')
    assert.equal(await one('SELECT public.erp_robot_due()'), false, 'en curso: no toca otra')
    await db.query('SELECT public.erp_robot_finish($1,true,$2)', [run.id, 'OK carga'])
    const st = await one('SELECT public.data_update_status()')
    assert.equal(st.erp.request.status, 'OK'); assert.equal(st.erp.can_request, true); assert.equal(st.erp.loading_since, null)
    assert.ok(new Date(st.erp.stock_at) > new Date(st.erp.contratos_at), 'fechas de cada carga activa')
    // Una ejecución que no informa en 60 minutos se da por fallida.
    const r3 = await one('SELECT public.erp_robot_request()'); await one('SELECT public.erp_robot_start()')
    await db.query(`UPDATE erp_robot_runs SET started_at = now() - interval '61 minutes' WHERE id = $1`, [r3.id])
    await one('SELECT public.erp_robot_start()')
    assert.equal((await db.query('SELECT status FROM erp_robot_runs WHERE id=$1', [r3.id])).rows[0].status, 'ERROR')
    // Un corte del robot sin otra solicitud: el robot igual consulta y cierra la ejecución vencida.
    const r4 = await one('SELECT public.erp_robot_request()'); await one('SELECT public.erp_robot_start()')
    await db.query(`UPDATE erp_robot_runs SET started_at = now() - interval '61 minutes' WHERE id = $1`, [r4.id])
    assert.equal(await one('SELECT public.erp_robot_due()'), true, 'ejecución vencida: el robot consulta')
    await one('SELECT public.erp_robot_start()')
    assert.equal((await db.query('SELECT status FROM erp_robot_runs WHERE id=$1', [r4.id])).rows[0].status, 'ERROR')
    assert.equal(await one('SELECT public.erp_robot_due()'), false)
    // Una carga abandonada no queda «en curso» si después se aplicó otra del mismo tipo.
    await db.exec(`INSERT INTO erp_imports(kind,status,created_at) VALUES ('CONTRATOS','CARGANDO',now()-interval '2 hours'); INSERT INTO erp_imports(kind,status,created_at,applied_at) VALUES ('CONTRATOS','ACTIVA',now()-interval '1 hour',now()-interval '1 hour')`)
    assert.equal((await one('SELECT public.data_update_status()')).erp.loading_since, null, 'carga abandonada superada')
    // C55: ninguna función privilegiada abierta a anónimos.
    assert.equal((await db.query("SELECT has_function_privilege('anon','public.erp_robot_due()','EXECUTE') AS x")).rows[0].x, false, 'erp_robot_due cerrada a anon')
    await db.exec(`SELECT set_config('test.load','off',false)`)
    await assert.rejects(db.query('SELECT public.erp_robot_request()'), /permiso/, 'solo quien carga el ERP')
    console.log('PASS: Actualizar ahora del ERP: una solicitud abierta, espera a la carga horaria, robot sin solaparse, estado del banner y permisos.')
  } finally { await db.close() }
})().catch(e => { console.error(e); process.exitCode = 1 })
