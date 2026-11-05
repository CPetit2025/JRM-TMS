// Hallazgos F3 (20261226100000_hallazgos_bloqueo_salida.sql): un Mayor/Crítico sin cerrar bloquea la salida del despacho
// vinculado por cualquier camino (el trigger mira dispatches.status), con excepción formal fuera de categorías de seguridad.
// dispatches y dispatch_events tienen la forma de producción; las tablas de F1 siguen el contrato (hallazgos-contrato.md).
const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const shape = readFileSync('scripts/security/production-shape.sql', 'utf8')
const table = name => { const start = shape.indexOf(`CREATE TABLE public."${name}" (`); assert.ok(start >= 0, name); return shape.slice(start, shape.indexOf(';', start) + 1) }
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const [D1, D2, D3, D4] = [1, 2, 3, 4].map(id), [F1, F2, F3, F4] = [11, 12, 13, 14].map(id)
const [SAFE, SAFETY] = [21, 22].map(id), [JEFE, RESP, DRIVER] = [31, 32, 33].map(id)

;(async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;GRANT USAGE ON SCHEMA auth TO authenticated;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('test.user',true),'')::uuid$$;
      CREATE FUNCTION is_tms_admin() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
      CREATE FUNCTION is_active_tms_user() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
      CREATE FUNCTION has_tms_permission(text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT auth.uid()='${JEFE}'::uuid$$;
      CREATE FUNCTION has_tms_read_permission(text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT auth.uid() IS NOT NULL$$;
      ${['dispatches', 'dispatch_events'].map(table).join('\n')}
      CREATE UNIQUE INDEX dispatch_one_active_driver ON dispatches(driver_id) WHERE driver_id IS NOT NULL AND status IN('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO');
      CREATE UNIQUE INDEX dispatch_one_active_vehicle ON dispatches(vehicle_plate) WHERE vehicle_plate IS NOT NULL AND vehicle_plate<>'EXTERNO' AND status IN('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO');
      CREATE TABLE audit_finding_categories(id uuid PRIMARY KEY,code text UNIQUE,name text,is_safety boolean NOT NULL DEFAULT false,active boolean DEFAULT true,sort int);
      CREATE TABLE audit_findings(id uuid PRIMARY KEY,number text UNIQUE,contract_id uuid,dispatch_id uuid REFERENCES dispatches(id),
        severity text NOT NULL,status text NOT NULL,responsible_id uuid,auditor_id uuid);
      CREATE TABLE audit_finding_category_links(finding_id uuid REFERENCES audit_findings(id),category_id uuid REFERENCES audit_finding_categories(id),PRIMARY KEY(finding_id,category_id));
      CREATE TABLE audit_finding_events(id bigserial PRIMARY KEY,finding_id uuid,event_type text,from_status text,to_status text,detail jsonb,actor uuid,at timestamptz DEFAULT now());
      ALTER TABLE audit_findings ENABLE ROW LEVEL SECURITY;
      CREATE POLICY f_read ON audit_findings FOR SELECT TO authenticated USING (has_tms_read_permission('hallazgos'));
      GRANT SELECT ON audit_findings TO authenticated;
      INSERT INTO audit_finding_categories(id,code,name,is_safety) VALUES('${SAFE}','DOC','Documentación',false),('${SAFETY}','ESTIBA','Estiba o seguridad',true);`)
    await db.exec(readFileSync('supabase/migrations/20261226100000_hallazgos_bloqueo_salida.sql', 'utf8'))

    const as = user => db.query("SELECT set_config('test.user',$1,false)", [user || ''])
    const one = async (sql, p = []) => (await db.query(sql, p)).rows[0]
    const route = (d, n, mod = 'PROPIO', driver = null, plate = 'P-' + n) => db.query(
      "INSERT INTO dispatches(id,dispatch_number,status,modalidad,driver_id,vehicle_plate,scheduled_departure) VALUES($1,$2,'PROGRAMADO',$3,$4,$5,now())", [d, 'R-' + n, mod, driver, plate])
    const finding = async (f, n, d, sev, status = 'ABIERTO', cat = SAFE) => {
      await db.query('INSERT INTO audit_findings(id,number,dispatch_id,severity,status,responsible_id) VALUES($1,$2,$3,$4,$5,$6)', [f, n, d, sev, status, RESP])
      await db.query('INSERT INTO audit_finding_category_links VALUES($1,$2)', [f, cat])
    }
    const statusOf = async d => (await one('SELECT status FROM dispatches WHERE id=$1', [d])).status
    const depart = (d, status) => db.query('UPDATE dispatches SET status=$2 WHERE id=$1', [d, status])
    const blocked = async (d, status, number) => {
      const before = await statusOf(d)
      await assert.rejects(depart(d, status), e => e.message.startsWith('HALLAZGO_BLOQUEA_SALIDA: ') && e.message.includes(number), `${d} → ${status}`)
      assert.equal(await statusOf(d), before)
    }

    // Dos rutas de la misma OT: el hallazgo solo bloquea la ruta vinculada (D1), no D2.
    await route(D1, 1, 'PROPIO', DRIVER); await route(D2, 2); await route(D3, 3, 'TERCERO', null, 'EXTERNO'); await route(D4, 4)
    await finding(F1, 'HAL-2026-00001', D1, 'MAYOR')
    await finding(F2, 'HAL-2026-00002', D3, 'CRITICO', 'PENDIENTE_VALIDACION', SAFETY)
    await finding(F3, 'HAL-2026-00003', D4, 'MENOR')
    for (const s of ['EN_CURSO', 'EN RUTA', 'EN_RUTA', 'EN_TRANSITO']) await blocked(D1, s, 'HAL-2026-00001')
    await blocked(D3, 'EN_CURSO', 'HAL-2026-00002')
    await depart(D2, 'EN_CURSO') // otra ruta de la misma OT
    await depart(D4, 'EN RUTA') // un Menor no bloquea
    await depart(D1, 'CANCELADO'); await depart(D1, 'PROGRAMADO') // cancelar / reprogramar no se bloquean

    // Consulta para Torre de Control
    await as(RESP)
    let r = (await one('SELECT audit_finding_release_check($1) v', [D1])).v
    assert.equal(r.blocked, true); assert.equal(r.can_grant, false); assert.deepEqual(r.findings.map(f => f.number), ['HAL-2026-00001'])
    assert.equal((await one('SELECT audit_finding_release_check($1) v', [D2])).v.blocked, false)
    await as(null)
    assert.equal((await one('SELECT audit_finding_release_check($1) v', [D1])).v.success, false)

    // Excepción: permiso, motivo, seguridad, vínculo, responsable que no se autoriza
    const grant = async (user, f, d, reason) => { await as(user); return (await one('SELECT audit_finding_grant_exception($1,$2,$3) v', [f, d, reason])).v }
    const why = 'Material repuesto en almacén, sale con control del supervisor'
    assert.match((await grant(RESP, F1, D1, why)).error, /Jefe de Distribución/)
    assert.match((await grant(JEFE, F1, D1, 'muy corto')).error, /20 caracteres/)
    assert.match((await grant(JEFE, F2, D3, why)).error, /seguridad/)
    assert.match((await grant(JEFE, F1, D2, why)).error, /no está vinculado/)
    assert.match((await grant(JEFE, F3, D4, why)).error, /no bloquea/)
    await db.query('UPDATE audit_findings SET responsible_id=$1 WHERE id=$2', [JEFE, F1])
    assert.match((await grant(JEFE, F1, D1, why)).error, /responsable/)
    await db.query('UPDATE audit_findings SET responsible_id=$1 WHERE id=$2', [RESP, F1])
    r = await grant(JEFE, F1, D1, why)
    assert.equal(r.success, true, JSON.stringify(r))
    assert.match((await grant(JEFE, F1, D1, why)).error, /vigente/)
    assert.equal((await one("SELECT count(*)::int n FROM audit_finding_events WHERE finding_id=$1 AND event_type='EXCEPCION_SALIDA'", [F1])).n, 1)
    assert.equal((await one("SELECT created_by FROM dispatch_events WHERE dispatch_id=$1 AND event_type='EXCEPCION_HALLAZGO'", [D1])).created_by, JEFE)
    assert.equal((await one('SELECT audit_finding_release_check($1) v', [D1])).v.blocked, false)
    await depart(D1, 'EN_CURSO') // pasa con excepción

    // Flota propia: EN_CURSO → EN RUTA también es salida. Un hallazgo cerrado ya no bloquea.
    await finding(F4, 'HAL-2026-00004', D1, 'CRITICO', 'EN_CORRECCION')
    await blocked(D1, 'EN RUTA', 'HAL-2026-00004')
    await db.query("UPDATE audit_findings SET status='CERRADO' WHERE id=$1", [F4])
    await depart(D1, 'EN RUTA')

    // Sin escritura directa
    await as(JEFE)
    await db.query('SET ROLE authenticated')
    await assert.rejects(db.query("INSERT INTO audit_finding_release_exceptions(finding_id,dispatch_id,reason,approved_by) VALUES($1,$2,'xxxxxxxxxxxxxxxxxxxxxxxx',$3)", [F2, D3, JEFE]), /permission denied/)
    assert.equal((await one('SELECT count(*)::int n FROM audit_finding_release_exceptions')).n, 1)
    await db.query('RESET ROLE')
    console.log('test-audit-findings-release: OK')
  } finally { await db.close() }
})().catch(error => { console.error(error); process.exit(1) })
