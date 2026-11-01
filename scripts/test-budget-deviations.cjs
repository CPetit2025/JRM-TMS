// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Control presupuestal · etapa 4: bandeja de desvíos — costo sobre lo acordado (cierre económico), OT sobre el tope sin
// autorización y emergencia sin ratificar; flujo Supervisor sustenta → Jefe recomienda → decide el Jefe o Gerencia si toca
// el margen; aprobar imputa el costo (cierre), rechazar lo devuelve a corrección; un desvío resuelto reaparece si crece.
const assert = require('node:assert/strict')
const { setupBudget, read, id, fn } = require('./fixtures/budget-setup.cjs')
;(async () => {
 const db = await setupBudget()
 try {
  const rpc = async (sql, params = []) => (await db.query(`SELECT ${sql} AS v`, params)).rows[0].v
  await db.exec(`ALTER TABLE contracts ADD COLUMN site_id uuid, ADD COLUMN client_id uuid; ALTER TABLE dispatches ADD COLUMN dispatch_number text;
   CREATE TABLE transport_margin_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope text, contract_id uuid, client_id uuid, operating_pct numeric,
    reason text, active boolean DEFAULT true, valid_until date);
   CREATE FUNCTION is_tms_admin() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
   CREATE FUNCTION has_tms_permission(p text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT p = ANY(string_to_array(current_setting('test.perms', true), ','))$$;
   CREATE FUNCTION economic_user_name(uuid) RETURNS text LANGUAGE sql STABLE AS $$SELECT 'Usuario'$$;
   CREATE FUNCTION service_cost_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'El historial de costos no se modifica ni se borra'; END$$;
   CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT '${id(99)}'::uuid$$;
   -- Cierre económico simulado: ítems por ruta, aprobación (imputa su diferencia) y sincronización del estado
   CREATE TABLE economic_closures(dispatch_id uuid PRIMARY KEY, status text, updated_at timestamptz DEFAULT now());
   CREATE TABLE economic_closure_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dispatch_id uuid, action text, from_status text, to_status text, reason text, detail jsonb, created_by uuid, created_at timestamptz DEFAULT now());
   CREATE TABLE test_items(dispatch_id uuid, key text, status text, concept text, request_number text, contract_id uuid, agreed_pen numeric, final_pen numeric);
   CREATE FUNCTION economic_route_items(p uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object('key', key, 'status', status, 'concept', concept, 'request_number', request_number, 'contract_id', contract_id,
     'agreed_pen', agreed_pen, 'final_pen', final_pen)), '[]'::jsonb) FROM test_items WHERE dispatch_id = p$$;
   CREATE FUNCTION economic_item_set(p uuid, k text, a text, r text) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
    UPDATE test_items SET status = CASE a WHEN 'APROBAR' THEN 'APROBADO' ELSE 'OBSERVADO' END WHERE dispatch_id = p AND key = k;
    RETURN jsonb_build_object('key', k, 'label', 'Grúa', 'from', 'EN_REVISION', 'to', a, 'budget_delta_by_contract', '{}'::jsonb); END$$;
   CREATE FUNCTION economic_route_sync(p uuid, a text, r text) RETURNS text LANGUAGE sql AS $$UPDATE economic_closures SET status = 'CIERRE_PARCIAL' WHERE dispatch_id = p RETURNING status$$;`)
  const margin = 'supabase/migrations/20261015100000_transport_margin_override.sql'
  for (const name of ['transport_margin_override_for','transport_operating_pct','transport_operating_limit']) await db.exec(fn(margin, name, '$$;'))
  for (const m of ['20261125090000_control_presupuestal_posicion.sql','20261126090000_control_presupuestal_imputacion.sql','20261127090000_control_presupuestal_autorizaciones.sql'])
   await db.exec(read('supabase/migrations/' + m))
  const migration = read('supabase/migrations/20261128090000_control_presupuestal_desvios.sql')
  await db.exec(migration); await db.exec(migration)
  const as = perms => db.exec(`SELECT set_config('test.perms', '${perms}', false)`)
  const list = async () => (await rpc('budget_deviations_list()'))
  const act = (key, action, note = null, evidence = null) => rpc('budget_deviation_action($1,$2,$3,$4)', [key, action, note, evidence])

  // Datos: ruta con grúa sobre lo acordado (OT-A dentro del tope) y OT-B con gasto ejecutado sobre el tope
  await db.exec(`INSERT INTO dispatches(id,status,contract_id,dispatch_number) VALUES ('${id(60)}','LIQUIDADO','${id(10)}','R-60');
   INSERT INTO economic_closures VALUES ('${id(60)}','EN_REVISION');
   INSERT INTO test_items VALUES ('${id(60)}','S:grua','EN_REVISION','GRUA','S-1','${id(10)}',300,420), ('${id(60)}','F:${id(60)}','APROBADO','FLETE','S-1','${id(10)}',500,500);
   UPDATE contract_budgets SET consumed_pen = 850 WHERE contract_id='${id(20)}';`)  // OT-B: 850 ejecutado > 800
  await as('despacho')
  let l = await list()
  assert.equal(l.success, true, l.error)
  const costo = `COSTO:${id(60)}:S:grua`, ot = `OT:${id(20)}`
  assert.ok(l.open.some(x => x.key === costo && Number(x.amount_pen) === 120 && !x.needs_management))
  assert.ok(l.open.some(x => x.key === ot && Number(x.amount_pen) === 50 && x.needs_management))

  // Costo sobre lo acordado: sustentar → recomendar → decide el Jefe (no toca el margen)
  assert.match((await act(costo, 'APROBAR')).error, /Solo el Jefe de Distribución o Gerencia/)
  assert.match((await act(costo, 'SUSTENTAR', 'corto')).error, /mínimo 10/)
  assert.equal((await act(costo, 'SUSTENTAR', 'La descarga tomó 4 horas por lluvia', 'Parte del operador')).status, 'SUSTENTADO')
  await as('control-presupuestal-recomendar')
  assert.equal((await act(costo, 'RECOMENDAR', 'Justificado')).status, 'RECOMENDADO')
  assert.equal((await act(costo, 'APROBAR')).status, 'APROBADO', 'the Jefe decides within his attributions')
  assert.equal((await db.query(`SELECT status FROM test_items WHERE key='S:grua'`)).rows[0].status, 'APROBADO', 'cost approved in the economic closure')
  assert.equal((await db.query(`SELECT action FROM economic_closure_events WHERE dispatch_id=$1`, [id(60)])).rows[0].action, 'APROBAR')
  l = await list(); assert.equal(l.open.some(x => x.key === costo), false); assert.ok(l.history.some(h => h.key === costo && h.status === 'APROBADO'))

  // OT sobre el tope: el Jefe no puede decidirlo (toca el margen); Gerencia sí; aprobar no cambia la partida
  await as('despacho'); assert.equal((await act(ot, 'SUSTENTAR', 'Peajes extra por desvío de ruta')).status, 'SUSTENTADO')
  await as('control-presupuestal-recomendar')
  assert.equal((await act(ot, 'RECOMENDAR')).status, 'RECOMENDADO')
  assert.match((await act(ot, 'APROBAR')).error, /margen protegido: lo decide Gerencia/)
  await as('control-presupuestal-autorizar')
  assert.equal((await act(ot, 'APROBAR', 'Sobrecosto aceptado')).status, 'APROBADO')
  assert.deepEqual((await db.query(`SELECT allocated_pen::float a, consumed_pen::float c FROM contract_budgets WHERE contract_id=$1`, [id(20)])).rows[0], { a: 1000, c: 850 })
  assert.equal((await list()).open.some(x => x.key === ot), false)
  // Si el exceso crece, el desvío vuelve a pendiente
  await db.exec(`UPDATE contract_budgets SET consumed_pen = 900 WHERE contract_id='${id(20)}'`)
  l = await list(); const again = l.open.find(x => x.key === ot)
  assert.deepEqual([again.status, Number(again.amount_pen)], ['PENDIENTE_SUSTENTO', 100])
  // Rechazar un costo lo devuelve a corrección
  await db.exec(`INSERT INTO test_items VALUES ('${id(60)}','S:estiba','EN_REVISION','ESTIBA','S-1','${id(10)}',200,260)`)
  const costo2 = `COSTO:${id(60)}:S:estiba`
  await as('despacho'); await act(costo2, 'SUSTENTAR', 'Cuadrilla adicional sin aviso')
  await as('control-presupuestal-recomendar')
  assert.match((await act(costo2, 'RECHAZAR')).error, /acción correctiva/)
  assert.equal((await act(costo2, 'RECHAZAR', 'Reclamar al proveedor: no se pidió')).status, 'RECHAZADO')
  assert.equal((await db.query(`SELECT status FROM test_items WHERE key='S:estiba'`)).rows[0].status, 'OBSERVADO')

  // Emergencia sin ratificar en plazo: aparece y Gerencia la ratifica desde la bandeja
  await as('despacho')
  const em = await rpc('budget_authorization_request($1,$2,$3,$4,$5)', [id(30), 50, 'Emergencia: unidad varada con carga', null, true])
  await db.exec(`UPDATE budget_authorizations SET regularize_by = now() - interval '1 hour' WHERE id='${em.id}'`)
  l = await list(); const emg = l.open.find(x => x.kind === 'EMERGENCIA_SIN_RATIFICAR')
  assert.ok(emg)
  await as('control-presupuestal-autorizar')
  assert.equal((await act(emg.key, 'APROBAR')).status, 'APROBADO', 'ratified without prior support (Gerencia decides directly)')
  assert.equal((await db.query(`SELECT decided_at IS NOT NULL AS d FROM budget_authorizations WHERE id=$1`, [em.id])).rows[0].d, true)

  await assert.rejects(db.exec(`DELETE FROM budget_deviation_events`), /no se modifica/)
  await assert.rejects(db.exec(read('supabase/tests/caja_c201_control_presupuestal_desvios.test.sql')), /CAJA C201 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  console.log('PASS control presupuestal etapa 4: desvíos de costo, de OT sobre el tope y de emergencia; sustento → recomendación → decisión del Jefe o de Gerencia; aprobar imputa, rechazar devuelve a corrección; reaparece si crece')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
