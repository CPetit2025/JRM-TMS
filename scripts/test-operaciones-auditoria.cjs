// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Correcciones de la auditoría de Monitoreo GPS y Registro de Servicios: el flete de una ruta mixta sigue siendo la suma de
// sus OT al editar uno; una ruta ejecutada se corrige en Cierre económico; el saldo de cargos y ediciones considera lo
// autorizado por Gerencia; el diagnóstico de conexión filtra los puntos por fecha.
const assert = require('node:assert/strict')
const { setupBudget, read, id, fn } = require('./fixtures/budget-setup.cjs')
;(async () => {
 const db = await setupBudget()
 try {
  const rpc = async (sql, params = []) => (await db.query(`SELECT ${sql} AS v`, params)).rows[0].v
  await db.exec(`ALTER TABLE contracts ADD COLUMN site_id uuid, ADD COLUMN client_id uuid;
   CREATE TABLE transport_margin_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope text, contract_id uuid, client_id uuid, operating_pct numeric,
    reason text, active boolean DEFAULT true, valid_until date);
   CREATE TABLE contract_services(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_id uuid, budget_contract_id uuid, service_type text, description text,
    amount_pen numeric, service_date date, plate text, driver_name text, hours numeric, provider_ruc text, provider_name text, category text, referral_guide text,
    created_by uuid, dispatch_id uuid, status text);
   CREATE FUNCTION is_tms_admin() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
   CREATE FUNCTION is_contract_administrator() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
   CREATE FUNCTION has_assigned_contract(uuid, boolean) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
   CREATE FUNCTION has_tms_permission(p text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT p = ANY(string_to_array(current_setting('test.perms', true), ','))$$;
   CREATE FUNCTION economic_user_name(uuid) RETURNS text LANGUAGE sql STABLE AS $$SELECT 'Usuario'$$;
   CREATE FUNCTION service_cost_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'no se modifica'; END$$;
   CREATE TABLE economic_closures(dispatch_id uuid PRIMARY KEY, status text);
   CREATE FUNCTION economic_closure_status(p uuid) RETURNS text LANGUAGE sql STABLE AS $$SELECT COALESCE((SELECT status FROM economic_closures WHERE dispatch_id = p), 'PENDIENTE')$$;
   -- Diagnóstico de conexión (tipo producción)
   CREATE TABLE drivers(id uuid PRIMARY KEY, first_name text, last_name text);
   CREATE TABLE route_track_points(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dispatch_id uuid, driver_id uuid, recorded_at timestamptz, gap_detected boolean DEFAULT false, created_at timestamptz DEFAULT now());
   CREATE TABLE driver_connectivity_gaps(driver_id uuid, dispatch_id uuid, seconds numeric, started_at timestamptz);
   CREATE TABLE driver_app_presence(driver_id uuid, last_seen_at timestamptz, client_info jsonb, pending_points int);
   ALTER TABLE dispatches ADD COLUMN driver_id uuid, ADD COLUMN created_at timestamptz DEFAULT now();
   CREATE TABLE dispatch_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dispatch_id uuid, event_type text);
   SELECT set_config('test.perms', 'contratos-servicios', false);`)
  const margin = 'supabase/migrations/20261015100000_transport_margin_override.sql'
  for (const name of ['transport_margin_override_for','transport_operating_pct','transport_operating_limit']) await db.exec(fn(margin, name, '$$;'))
  for (const m of ['20261125090000_control_presupuestal_posicion.sql','20261126090000_control_presupuestal_imputacion.sql','20261127090000_control_presupuestal_autorizaciones.sql'])
   await db.exec(read('supabase/migrations/' + m))
  await db.exec(fn('supabase/migrations/20260930130000_gastos_ot_regularizacion.sql', 'register_contract_service'))
  const migration = read('supabase/migrations/20261130090000_operaciones_correcciones_auditoria.sql')
  await db.exec(migration); await db.exec(migration)
  const update = (sid, amount) => rpc('update_contract_service_amount($1,$2)', [sid, amount])

  // Ruta mixta abierta: dos OT con flete 300 + 200; editar el de OT-A deja la ruta en 350 + 200
  await db.exec(`INSERT INTO dispatches(id,status,freight_cost) VALUES ('${id(60)}','EN RUTA',500), ('${id(61)}','LIQUIDADO',400), ('${id(62)}','LIQUIDADO',300);
   INSERT INTO transport_requests VALUES ('${id(40)}','S-1','${id(10)}',NULL),('${id(41)}','S-2','${id(20)}',NULL);
   INSERT INTO dispatch_request_freight VALUES ('${id(60)}','${id(40)}','${id(10)}',300,'RESERVADO'),('${id(60)}','${id(41)}','${id(20)}',200,'RESERVADO');
   INSERT INTO contract_services(id,contract_id,service_type,dispatch_id,amount_pen) VALUES ('${id(80)}','${id(10)}','FLETE','${id(60)}',300),('${id(81)}','${id(20)}','FLETE','${id(60)}',200),
    ('${id(82)}','${id(10)}','FLETE','${id(61)}',400),('${id(83)}','${id(10)}','FLETE','${id(62)}',300),('${id(84)}','${id(10)}','OTROS',NULL,100);
   UPDATE contract_budgets SET reserved_pen = 300 WHERE contract_id='${id(10)}'; UPDATE contract_budgets SET reserved_pen = 200 WHERE contract_id='${id(20)}';
   INSERT INTO economic_closures VALUES ('${id(62)}','CERRADO');`)
  assert.equal(await update(id(80), 350), true)
  assert.equal(Number((await db.query(`SELECT freight_cost FROM dispatches WHERE id=$1`, [id(60)])).rows[0].freight_cost), 550, 'mixed route freight = sum of its OT freights')
  // Ruta ya ejecutada: se corrige en Cierre económico (con o sin cierre registrado)
  await assert.rejects(update(id(82), 450), /La ruta ya se ejecutó: corrija el costo final en Cierre económico/)
  await assert.rejects(update(id(83), 250), /Cierre económico \(observar o reabrir\)/, 'approved closure keeps its original message')
  // Saldo con autorizaciones: OT-A tiene 1 000 asignado y 350 comprometido (tope 800); un cargo de 500 no entra…
  await assert.rejects(rpc(`register_contract_service($1,'OTROS','Peaje',500,current_date)`, [id(10)]), /Saldo insuficiente/)
  // …con 100 autorizados por Gerencia, sí (450 + 100)
  await db.exec(`INSERT INTO budget_authorizations(contract_id, amount_pen, reason, status, decided_by, decided_at) VALUES ('${id(10)}',100,'Autorizado por Gerencia','AUTORIZADA','${id(9)}',now())`)
  assert.equal(await rpc(`register_contract_service($1,'OTROS','Peaje',500,current_date)`, [id(10)]), true)
  await assert.rejects(update(id(84), 200), /incluye lo autorizado/, 'manual charge edit over balance + authorized still blocked')

  // Diagnóstico de conexión: compila y cuenta solo los puntos del período
  await db.exec(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT '${id(9)}'::uuid$$`)
  await db.exec(`CREATE OR REPLACE FUNCTION is_tms_admin() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
   INSERT INTO drivers VALUES ('${id(70)}','Ana','Ruiz'); UPDATE dispatches SET driver_id='${id(70)}', scheduled_departure=now() WHERE id='${id(60)}';
   INSERT INTO route_track_points(dispatch_id,driver_id,recorded_at,created_at) VALUES ('${id(60)}','${id(70)}',now()-interval '1 hour',now()-interval '1 hour'+interval '200 seconds'),
    ('${id(60)}','${id(70)}',now()-interval '20 days',now()-interval '20 days');`)
  const rep = await rpc('get_driver_connectivity_report(7)')
  assert.deepEqual([rep.success, rep.drivers.length, rep.drivers[0].points, Number(rep.drivers[0].late_pct)], [true, 1, 1, 100], 'only the point of the last 7 days, uploaded 200 s late')

  await assert.rejects(db.exec(read('supabase/tests/caja_c202_operaciones_correcciones_auditoria.test.sql')), /CAJA C202 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  console.log('PASS correcciones de auditoría: flete de ruta mixta, ruta ejecutada al Cierre económico, saldo con autorizaciones y diagnóstico de conexión por fecha')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
