// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Circuito económico: los movimientos vigentes de cada fuente explican el comprometido y el ejecutado de la OT sin doble
// conteo (ruta propia con reverso de tarifa, multi-OT, tercero, sin OT, descarga, Caja corregida y anulada, combustible
// estimado reemplazado por el real, cancelación, ajuste de cierre, cargos manuales, componentes); la diferencia histórica
// se expone y no se fuerza; pendientes con dato; permisos; paginación; editar el flete de una OT actualiza su renglón.
const assert = require('node:assert/strict')
const { setupBudget, read, id, fn } = require('./fixtures/budget-setup.cjs')
;(async () => {
 const db = await setupBudget()
 try {
  const rpc = async (sql, params = []) => (await db.query(`SELECT ${sql} AS v`, params)).rows[0].v
  await db.exec(`ALTER TABLE contracts ADD COLUMN site_id uuid, ADD COLUMN client_id uuid, ADD COLUMN type text DEFAULT 'CONTRATO', ADD COLUMN created_at timestamptz DEFAULT now();
   CREATE TABLE clients(id uuid PRIMARY KEY, business_name text);
   CREATE TABLE transport_margin_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope text, contract_id uuid, client_id uuid, operating_pct numeric,
    reason text, active boolean DEFAULT true, valid_until date);
   ALTER TABLE transport_requests ADD COLUMN status text, ADD COLUMN reserved_pen numeric DEFAULT 0, ADD COLUMN approved_at timestamptz, ADD COLUMN created_at timestamptz DEFAULT now();
   ALTER TABLE dispatches ADD COLUMN dispatch_number text, ADD COLUMN created_at timestamptz DEFAULT now();
   ALTER TABLE dispatch_request_freight ADD COLUMN service_id uuid;
   ALTER TABLE dispatch_expenses ADD COLUMN created_at timestamptz DEFAULT now();
   CREATE TABLE dispatch_freight_stages(dispatch_id uuid PRIMARY KEY, final_applied_pen numeric);
   CREATE TABLE dispatch_service_additions(dispatch_id uuid, request_id uuid, extra_km numeric);
   CREATE TABLE documentary_closures(dispatch_id uuid, request_id uuid, status text);
   CREATE TABLE carriers(id uuid PRIMARY KEY, business_name text);
   -- Tipo producción: tabla antigua de otro modelo con el mismo nombre (00002); la ampliación usa transport_budget_extensions
   CREATE TABLE budget_extensions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ot_budget_id uuid, extra_amount numeric, justification text);
   CREATE TABLE budget_deviation_reviews(key text PRIMARY KEY, contract_id uuid);
   CREATE TABLE budget_deviation_events(key text, action text, amount_pen numeric, note text, created_by uuid, created_at timestamptz DEFAULT now());
   CREATE TABLE dispatch_documents(dispatch_id uuid, doc_type text, document_number text, voided_at timestamptz);
   CREATE TABLE contract_budget_adjustments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), budget_id uuid, contract_id uuid, field text, old_value numeric, new_value numeric, reason text, created_at timestamptz DEFAULT now());
   ALTER TABLE transport_requests ADD COLUMN pickup_address text, ADD COLUMN delivery_address text;
   ALTER TABLE dispatch_requests ADD COLUMN sequence_order int;
   CREATE TABLE dispatch_request_freight_stages(dispatch_id uuid, request_id uuid, final_applied_pen numeric, PRIMARY KEY (dispatch_id, request_id));
   CREATE TABLE contract_services(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_id uuid, budget_contract_id uuid, service_type text, description text,
    amount_pen numeric, service_date date DEFAULT current_date, plate text, driver_name text, hours numeric, provider_ruc text, provider_name text, category text,
    referral_guide text, created_by uuid, dispatch_id uuid, status text, created_at timestamptz DEFAULT now());
   CREATE TABLE transport_unloading_costs(id uuid PRIMARY KEY, transport_request_id uuid, dispatch_id uuid, contract_id uuid, concept text, status text,
    estimated_pen numeric DEFAULT 0, planned_pen numeric, actual_pen numeric, contract_service_id uuid, expense_id uuid, provider_name text,
    created_at timestamptz DEFAULT now(), planned_at timestamptz, consumed_at timestamptz);
   CREATE FUNCTION is_tms_admin() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
   CREATE FUNCTION is_contract_administrator() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
   CREATE FUNCTION has_assigned_contract(uuid, boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
   CREATE FUNCTION has_tms_permission(p text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT p = ANY(string_to_array(current_setting('test.perms', true), ','))$$;
   CREATE FUNCTION economic_user_name(uuid) RETURNS text LANGUAGE sql STABLE AS $$SELECT 'Usuario'$$;
   CREATE FUNCTION economic_closure_status(uuid) RETURNS text LANGUAGE sql STABLE AS $$SELECT 'PENDIENTE'$$;
   CREATE FUNCTION service_cost_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'no se modifica'; END$$;
   CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT '${id(99)}'::uuid$$;
   SELECT set_config('test.perms', 'contratos-servicios', false);
   INSERT INTO clients VALUES ('${id(5)}','Cliente');
   UPDATE contracts SET client_id = '${id(5)}', site_id = '${id(6)}';
   INSERT INTO contract_budgets(contract_id,concept,allocated_pen) VALUES ('${id(31)}','PARTIDA_TRANSPORTE',0);`)
  const margin = 'supabase/migrations/20261015100000_transport_margin_override.sql'
  for (const name of ['transport_margin_override_for','transport_operating_pct','transport_operating_limit']) await db.exec(fn(margin, name, '$$;'))
  for (const m of ['20261125090000_control_presupuestal_posicion.sql','20261126090000_control_presupuestal_imputacion.sql','20261127090000_control_presupuestal_autorizaciones.sql'])
   await db.exec(read('supabase/migrations/' + m))
  await db.exec(fn('supabase/migrations/20261130090000_operaciones_correcciones_auditoria.sql', 'update_contract_service_amount'))
  // Activación: solo las rutas con salida desde ahora entran a la imputación (D7)
  await db.exec(`UPDATE economic_settings SET budget_imputation_since = now() - interval '1 day'`)
  const migration = read('supabase/migrations/20261201090000_circuito_economico_movimientos.sql')
  await db.exec(migration); await db.exec(migration)
  // Pendientes sin búsqueda cuadrática (auditoría, hallazgo 12): parche idempotente sobre budget_pending
  for (let i = 0; i < 2; i++) await db.exec(read('supabase/migrations/20261204090000_pendientes_sin_busqueda_cuadratica.sql'))
  // Decisiones D2, D3 y D5 de la reingeniería (idempotente)
  for (let i = 0; i < 2; i++) await db.exec(read('supabase/migrations/20261206090000_control_presupuestal_reglas_d2_d3_d5.sql'))
  // Cierre final (historial de la OT) y detalle por OT con ampliaciones (idempotentes)
  await db.exec(fn('supabase/migrations/20261111110000_cierre_economico_bandeja.sql', 'economic_documentary_status'))
  for (const m of ['20261205090000_torre_cierre_final.sql', '20261208090000_control_presupuestal_detalle_ot.sql']) for (let i = 0; i < 2; i++) await db.exec(read('supabase/migrations/' + m))

  const budget = (c, r, x) => db.query(`UPDATE contract_budgets SET reserved_pen = reserved_pen + $2, consumed_pen = consumed_pen + $3 WHERE contract_id = $1`, [c, r, x])
  const used = async c => (await db.query(`SELECT round(reserved_pen,2)::float r, round(consumed_pen,2)::float c FROM contract_budgets WHERE contract_id=$1`, [c])).rows[0]
  const moves = (c, opts = {}) => rpc('budget_movements($1,$2,$3,$4,$5,$6,$7)', [c, opts.from ?? null, opts.to ?? null, opts.effect ?? null, opts.q ?? null, opts.limit ?? 500, opts.offset ?? 0])
  const reconciled = async c => { const m = await moves(c); assert.equal(m.success, true, m.error); return [Number(m.difference.reserved_pen), Number(m.difference.consumed_pen)] }
  const expense = (n, d, type, amount, req = null) => db.query(`INSERT INTO dispatch_expenses(id,dispatch_id,transport_request_id,expense_type,amount) VALUES ($1,$2,$3,$4,$5)`, [id(n), d, req, type, amount])
  const approve = (n, amount = null) => db.query(`UPDATE dispatch_expenses SET status='APROBADO', approved_amount=$2 WHERE id=$1`, [id(n), amount])
  // Cierre de ruta como close_dispatch_route / settle_mixed_dispatch_freight: tarifa de comprometido a ejecutado (una transacción)
  const close = async (d, moves) => { await db.exec('BEGIN'); for (const [c, amt] of moves) await budget(c, -amt, amt)
   await db.query(`UPDATE dispatch_request_freight SET status='CONSUMIDO' WHERE dispatch_id=$1 AND status='RESERVADO'`, [d])
   await db.query(`UPDATE dispatches SET status='LIQUIDADO' WHERE id=$1`, [d]); await db.exec('COMMIT') }

  await db.exec(`INSERT INTO transport_requests(id,request_number,contract_id,estimated_weight) VALUES ('${id(40)}','S-1','${id(10)}',NULL),('${id(41)}','S-2','${id(10)}',NULL),
    ('${id(42)}','S-3','${id(20)}',NULL),('${id(43)}','S-4',NULL,NULL),('${id(44)}','S-5','${id(30)}',NULL),('${id(46)}','S-7','${id(20)}',NULL),('${id(47)}','S-8','${id(10)}',NULL);
   INSERT INTO dispatches(id,dispatch_number,status,contract_id,freight_cost,vehicle_plate,scheduled_departure,actual_distance_km,modalidad) VALUES
    ('${id(60)}','R-60','EN RUTA','${id(10)}',300,'PRO-1',now(),0,'PROPIA'),
    ('${id(61)}','R-61','EN RUTA',NULL,500,'PRO-1',now(),100,'PROPIA'),
    ('${id(62)}','R-62','EN RUTA','${id(30)}',800,'TER-1',now(),0,'TERCERO'),
    ('${id(64)}','R-64','PROGRAMADO',NULL,100,'TER-2',now(),0,'TERCERO'),
    ('${id(65)}','R-65','PROGRAMADO',NULL,100,'TER-3',now(),0,'TERCERO');
   INSERT INTO dispatch_requests VALUES ('${id(60)}','${id(40)}'),('${id(61)}','${id(41)}'),('${id(61)}','${id(42)}'),('${id(61)}','${id(43)}'),('${id(62)}','${id(44)}'),
    ('${id(64)}','${id(46)}'),('${id(65)}','${id(47)}');
   INSERT INTO contract_services(id,contract_id,service_type,amount_pen,dispatch_id,provider_name) VALUES
    ('${id(80)}','${id(10)}','FLETE',300,'${id(60)}',NULL),('${id(81)}','${id(10)}','FLETE',350,'${id(61)}',NULL),('${id(82)}','${id(20)}','FLETE',150,'${id(61)}',NULL),
    ('${id(83)}','${id(30)}','FLETE',800,'${id(62)}','Transportes Sur'),('${id(84)}','${id(20)}','FLETE',100,'${id(64)}','Tercero 2'),('${id(85)}','${id(10)}','FLETE',100,'${id(65)}','Tercero 3');
   INSERT INTO dispatch_request_freight(dispatch_id,request_id,contract_id,amount_pen,service_id) VALUES ('${id(61)}','${id(41)}','${id(10)}',350,'${id(81)}'),
    ('${id(61)}','${id(42)}','${id(20)}',150,'${id(82)}'),('${id(61)}','${id(43)}',NULL,0,NULL),('${id(64)}','${id(46)}','${id(20)}',100,'${id(84)}'),('${id(65)}','${id(47)}','${id(10)}',100,'${id(85)}');`)
  // Programación: reservas como reserve_mixed_dispatch / schedule_dispatch
  await budget(id(10), 300 + 350 + 100, 0); await budget(id(20), 150 + 100, 0); await budget(id(30), 800, 0)
  assert.deepEqual([await reconciled(id(10)), await reconciled(id(20)), await reconciled(id(30))], [[0, 0], [0, 0], [0, 0]], 'commitments explained at scheduling')

  // Ruta propia (sin detalle por OT): Caja pendiente mientras está abierta, luego tarifa reemplazada por costos reales
  await expense(500, id(60), 'COMBUSTIBLE', 120); await approve(500)
  let pend = (await rpc('budget_pending()')).rows
  assert.ok(pend.some(p => p.kind === 'POR_IMPUTAR' && p.contract_code === 'OT-A' && Number(p.amount_pen) === 120), 'open own route: Caja waits for the close')
  await close(id(60), [[id(10), 300]])
  assert.deepEqual(await used(id(10)), { r: 450, c: 120 })
  // Caja corregida y luego rechazada: reverso explícito, nada se borra
  await expense(503, id(60), 'VIATICOS', 50); await approve(503); await approve(503, 45)
  await db.query(`UPDATE dispatch_expenses SET status='RECHAZADO' WHERE id=$1`, [id(503)])
  assert.deepEqual(await used(id(10)), { r: 450, c: 120 })
  assert.deepEqual(await reconciled(id(10)), [0, 0], 'own route + corrected/voided Caja reconcile')
  let m = await moves(id(10), { q: 'R-60' })
  assert.deepEqual(m.rows.map(r => [r.source, r.status, Number(r.reserved_pen), Number(r.consumed_pen)]).sort(),
   [['CAJA','ANULADO',0,0],['CAJA','ANULADO',0,0],['CAJA','APLICADO',0,120],['FLETE','LIQUIDADO',0,300],['TARIFA_PROPIA','APLICADO',0,-300]].sort(),
   'route R-60: freight executed and reversed by the own-tariff reversal, Caja applied, both Caja reversals visible')

  // Multi-OT propia con una solicitud sin OT: combustible estimado por partes iguales; la parte sin OT no se carga
  await close(id(61), [[id(10), 350], [id(20), 150]])
  pend = (await rpc('budget_pending()')).rows
  assert.ok(pend.some(p => p.kind === 'COMBUSTIBLE_ESTIMADO' && p.dispatch_number === 'R-61' && p.age_days === 0), 'estimated fuel pending substitution, aged from its application date')
  await expense(511, id(61), 'COMBUSTIBLE', 99); await approve(511)
  pend = (await rpc('budget_pending()')).rows
  assert.ok(!pend.some(p => p.kind === 'COMBUSTIBLE_ESTIMADO'), 'real fuel replaced the estimate')
  // Ajuste aprobado en Costos por ruta: flete final de OT-A 370 (economic_apply_item)
  await db.exec(`INSERT INTO dispatch_request_freight_stages VALUES ('${id(61)}','${id(41)}',370)`); await budget(id(10), 0, 20)
  assert.deepEqual([await reconciled(id(10)), await reconciled(id(20))], [[0, 0], [0, 0]], 'multi-OT split, fuel replaced and closure adjustment reconcile')
  const est = await moves(id(20), { q: 'combustible' })
  assert.ok(est.rows.some(r => r.estimated && r.status === 'ANULADO') && est.rows.some(r => !r.estimated && r.status === 'APLICADO'), 'estimated vs real fuel are labelled')

  // Tercero: gasto extraordinario directo; la tarifa contratada queda como ejecutado
  await expense(520, id(62), 'PEAJE', 60); await approve(520)
  await close(id(62), [[id(30), 800]])
  assert.deepEqual(await used(id(30)), { r: 0, c: 860 })
  assert.deepEqual(await reconciled(id(30)), [0, 0])

  // Cancelación: la reserva del flete se libera y el movimiento queda como reverso sin efecto
  await db.exec(`BEGIN; UPDATE dispatch_request_freight SET status='LIBERADO' WHERE dispatch_id='${id(64)}'; UPDATE contract_services SET status='ANULADO' WHERE id='${id(84)}';
   UPDATE dispatches SET status='CANCELADO' WHERE id='${id(64)}'; COMMIT;`); await budget(id(20), -100, 0)
  // Servicio especial: estiba planificada 50 (comprometido), consumida 55 por Caja y ajustada a 60 en el cierre
  await db.exec(`INSERT INTO transport_unloading_costs(id,transport_request_id,dispatch_id,contract_id,concept,status,planned_pen,planned_at) VALUES
    ('${id(70)}','${id(42)}','${id(61)}','${id(20)}','ESTIBA','PLANIFICADO',50,now())`); await budget(id(20), 50, 0)
  assert.deepEqual(await reconciled(id(20)), [0, 0])
  await db.exec(`UPDATE transport_unloading_costs SET status='CONSUMIDO', actual_pen=60, consumed_at=now() WHERE id='${id(70)}'`); await budget(id(20), -50, 60)
  // Cargos manuales: dos iguales sin sustento (posible duplicado) y uno con guía
  await db.exec(`INSERT INTO contract_services(id,contract_id,budget_contract_id,service_type,amount_pen,service_date) VALUES
    ('${id(90)}','${id(20)}','${id(20)}','OTROS',40,current_date),('${id(91)}','${id(20)}','${id(20)}','OTROS',40,current_date);
   INSERT INTO contract_services(id,contract_id,budget_contract_id,service_type,amount_pen,referral_guide,provider_name) VALUES ('${id(92)}','${id(20)}','${id(20)}','PEAJE',15,'GR-1','Peajes SA')`)
  await budget(id(20), 0, 95)
  assert.deepEqual(await reconciled(id(20)), [0, 0], 'cancellation, special service and manual charges reconcile')
  pend = (await rpc('budget_pending()')).rows.filter(p => p.contract_code === 'OT-B')
  assert.deepEqual(pend.map(p => p.kind).sort(), ['POSIBLE_DUPLICADO','SIN_SUSTENTO','SIN_SUSTENTO'])
  assert.ok(pend.every(p => p.registered_by === null || p.registered_by === 'Usuario'), 'no invented responsible')
  const b = await moves(id(20), { effect: 'SIN_EFECTO' })
  assert.ok(b.rows.some(r => r.source === 'FLETE' && r.status === 'LIBERADO' && r.reversal), 'released freight listed as reversal')

  // Componente de la OT (subcontrato con su partida): entra en la familia de OT-C
  await db.exec(`INSERT INTO contract_services(id,contract_id,budget_contract_id,service_type,amount_pen,referral_guide) VALUES ('${id(93)}','${id(31)}','${id(31)}','OTROS',10,'GR-9')`)
  await budget(id(31), 0, 10)
  // Histórico anterior al registro de movimientos: 25 ejecutados sin rastro. Se expone, no se fuerza
  await budget(id(30), 0, 25)
  m = await moves(id(30))
  assert.deepEqual([Number(m.difference.reserved_pen), Number(m.difference.consumed_pen), Number(m.position.consumed_pen), Number(m.explained.consumed_pen)], [0, 25, 895, 870])
  assert.ok(m.rows.some(r => r.budget_code === 'OT-C-S1'), 'component movements in the family')
  assert.deepEqual(await used(id(30)), { r: 0, c: 885 }, 'reading never rewrites the balance')
  pend = (await rpc('budget_pending()')).rows
  assert.ok(pend.some(p => p.kind === 'CONCILIACION' && p.contract_code === 'OT-C' && Number(p.amount_pen) === 25))

  // Gasto de Caja de una ruta cerrada que no se imputó (falló el disparador): pendiente
  await db.exec(`SET session_replication_role = replica; INSERT INTO dispatch_expenses(id,dispatch_id,expense_type,amount,status) VALUES ('${id(540)}','${id(62)}','PEAJE',12,'APROBADO'); SET session_replication_role = origin`)
  pend = (await rpc('budget_pending()')).rows
  assert.ok(pend.some(p => p.kind === 'SIN_IMPUTAR' && p.ref === id(540) && Number(p.amount_pen) === 12))

  // Editar el flete de una OT en ruta abierta actualiza su renglón: al cerrar no queda comprometido huérfano
  assert.equal(await rpc('update_contract_service_amount($1,$2)', [id(85), 130]), true)
  assert.equal(Number((await db.query(`SELECT amount_pen FROM dispatch_request_freight WHERE service_id=$1`, [id(85)])).rows[0].amount_pen), 130)
  assert.deepEqual(await reconciled(id(10)), [0, 0], 'edited freight explained')
  await close(id(65), [[id(10), 130]])
  assert.deepEqual([(await used(id(10))).r, await reconciled(id(10))], [0, [0, 0]], 'no orphan commitment after close')

  // D5: flete final aprobado después del cierre en ruta propia: el reverso de la tarifa lo sigue (neto cero).
  // El ajuste aprobado antes de esta regla (370 sobre 350, insertado arriba) quedó en el ejecutado y se conserva.
  const before = (await used(id(10))).c
  await db.exec(`UPDATE dispatch_request_freight_stages SET final_applied_pen = 380 WHERE dispatch_id='${id(61)}' AND request_id='${id(41)}'`); await budget(id(10), 0, 10)
  assert.equal(Math.round(((await used(id(10))).c - before) * 100) / 100, -20, 'D5: net own-route freight back to zero (+10 adjustment, reversal 350 → 380)')
  assert.deepEqual(await reconciled(id(10)), [0, 0], 'D5 reconciles')
  // D3: ruta propia multi-OT con 20 km agregados por el servicio de OT-B: combustible estimado 100 km / 20 km/gal × 16 = 80;
  // 16 por los km extra a OT-B y 64 por partes iguales → OT-A 32, OT-B 48
  await db.exec(`INSERT INTO transport_requests(id,request_number,contract_id) VALUES ('${id(48)}','S-9','${id(10)}'),('${id(49)}','S-10','${id(20)}');
   INSERT INTO dispatches(id,dispatch_number,status,contract_id,freight_cost,vehicle_plate,scheduled_departure,actual_distance_km,modalidad) VALUES ('${id(66)}','R-66','EN RUTA',NULL,200,'PRO-1',now(),100,'PROPIA');
   INSERT INTO dispatch_requests VALUES ('${id(66)}','${id(48)}'),('${id(66)}','${id(49)}');
   INSERT INTO dispatch_request_freight(dispatch_id,request_id,contract_id,amount_pen) VALUES ('${id(66)}','${id(48)}','${id(10)}',100),('${id(66)}','${id(49)}','${id(20)}',100);
   INSERT INTO dispatch_service_additions VALUES ('${id(66)}','${id(49)}',20)`)
  await budget(id(10), 100, 0); await budget(id(20), 100, 0)
  await close(id(66), [[id(10), 100], [id(20), 100]])
  const fuel = (await db.query(`SELECT request_id, amount_pen::float a, detail FROM cost_allocations WHERE dispatch_id=$1 AND kind='COMBUSTIBLE_ESTIMADO' ORDER BY request_id`, [id(66)])).rows
  assert.deepEqual(fuel.map(f => [f.request_id, f.a]), [[id(48), 32], [id(49), 48]], 'D3: extra-km fuel goes to the OT that added them')
  assert.equal(Number(fuel[1].detail.km_extra), 20)
  assert.deepEqual([await reconciled(id(10)), await reconciled(id(20))], [[0, 0], [0, 0]], 'D3 reconciles')
  // D2: combustible de Caja en ruta de tercero: se imputa y queda como posible duplicado con la tarifa
  await expense(550, id(62), 'COMBUSTIBLE', 50); await approve(550)
  pend = (await rpc('budget_pending()')).rows
  assert.ok(pend.some(p => p.kind === 'COMBUSTIBLE_EN_TARIFA' && p.contract_code === 'OT-C' && Number(p.amount_pen) === 50 && p.dispatch_number === 'R-62'), 'D2 flagged')
  assert.ok(!pend.some(p => p.kind === 'COMBUSTIBLE_EN_TARIFA' && p.dispatch_number !== 'R-62'), 'own-route fuel is not flagged')

  // Detalle por OT: suma lo mismo que la partida (viajes + cargos sin ruta = ejecutado explicado; conceptos = total)
  let det = await rpc('budget_ot_detail($1)', [id(20)]); assert.equal(det.success, true, det.error)
  m = await moves(id(20))
  const sum = (rows, k) => Math.round(rows.reduce((a, r) => a + Number(r[k]), 0) * 100) / 100
  const noRoute = Math.round(m.rows.filter(r => !r.dispatch_id && r.has_budget).reduce((a, r) => a + Number(r.consumed_pen), 0) * 100) / 100
  assert.equal(Math.round((sum(det.trips, 'consumed_pen') + noRoute) * 100) / 100, Number(m.explained.consumed_pen), 'trips + charges without route = executed')
  assert.equal(sum(det.concepts, 'consumed_pen'), Number(m.explained.consumed_pen), 'concepts = executed (no double counting)')
  assert.equal(sum(det.concepts, 'reserved_pen'), Number(m.explained.reserved_pen))
  assert.ok(det.concepts.some(c => c.concept === 'Combustible') && det.concepts.some(c => c.concept === 'Estiba'))
  assert.equal(det.series.at(-1).cumulative_pen, Number(m.explained.consumed_pen), 'series ends at the executed total')
  const r66 = det.trips.find(t => t.number === 'R-66'); assert.deepEqual([Number(r66.planned_pen), r66.closure.economico], [100, 'PENDIENTE'])
  assert.match((await rpc('budget_ot_detail($1,$2,$3)', [id(20), '2026-02-01', '2026-01-01'])).error, /posterior/)
  // Ampliación (D4): solicita el Jefe, decide Gerencia (no la propia), suma al asignado y queda en el historial
  await db.exec(`SELECT set_config('test.perms', 'despacho', false)`)
  assert.match((await rpc('budget_extension_request($1,$2,$3)', [id(20), 200, 'Mayor volumen del cliente'])).error, /Solo el Jefe/)
  await db.exec(`SELECT set_config('test.perms', 'control-presupuestal-recomendar,control-presupuestal-autorizar', false)`)
  assert.match((await rpc('budget_extension_request($1,$2,$3)', [id(20), 200, 'corto'])).error, /mínimo 10/)
  const ext = await rpc('budget_extension_request($1,$2,$3,$4)', [id(20), 200, 'Mayor volumen del cliente', 'Correo del cliente']); assert.equal(ext.success, true, ext.error)
  assert.match((await rpc('budget_extension_request($1,$2,$3)', [id(20), 100, 'Otra ampliación más'])).error, /pendiente/)
  assert.match((await rpc('budget_extension_action($1,$2)', [ext.id, 'APROBAR'])).error, /usted solicitó/)
  await db.exec(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT '${id(98)}'::uuid$$`)
  const allocated = Number((await db.query(`SELECT allocated_pen FROM contract_budgets WHERE contract_id=$1`, [id(20)])).rows[0].allocated_pen)
  assert.equal((await rpc('budget_extension_action($1,$2,$3)', [ext.id, 'APROBAR', 'Aprobado'])).success, true)
  assert.equal(Number((await db.query(`SELECT allocated_pen FROM contract_budgets WHERE contract_id=$1`, [id(20)])).rows[0].allocated_pen), allocated + 200)
  assert.match((await rpc('budget_extension_action($1,$2)', [ext.id, 'RECHAZAR'])).error, /ya fue decidida/)
  det = await rpc('budget_ot_detail($1)', [id(20)])
  assert.deepEqual([Number(det.position.extensions_pen), det.extensions[0].status], [200, 'APROBADA'])
  assert.ok(det.timeline.some(h => h.kind === 'AMPLIACION' && /aprobada/.test(h.title)) && det.timeline.some(h => h.kind === 'PARTIDA'))
  assert.deepEqual(await reconciled(id(20)), [0, 0], 'an extension changes the allocation, not the movements')
  await db.exec(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT '${id(99)}'::uuid$$; SELECT set_config('test.perms', 'contratos-servicios', false)`)

  // Período: ejecutado inicial + del período = al corte; filtros y paginación
  m = await moves(id(20), { from: '2000-01-01', to: '2100-01-01' })
  assert.equal(Number(m.period.closing_consumed_pen), Number(m.explained.consumed_pen))
  const page1 = await moves(id(20), { limit: 2 }), page2 = await moves(id(20), { limit: 2, offset: 2 })
  assert.deepEqual([page1.rows.length, page2.rows.length, page1.total], [2, 2, m.total])
  assert.notDeepEqual(page1.rows.map(r => r.id), page2.rows.map(r => r.id))
  assert.match((await moves(id(20), { effect: 'X' })).error, /inválido/)
  assert.match((await moves(id(20), { from: '2026-02-01', to: '2026-01-01' })).error, /posterior/)

  // Permisos: subcontrato directo, sede sin acceso y usuario sin lectura
  assert.equal((await moves(id(31))).contract.code, 'OT-C', 'a component opens its root OT')
  await db.exec(`CREATE OR REPLACE FUNCTION can_access_site(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$`)
  assert.match((await moves(id(20))).error, /no disponible/)
  assert.deepEqual((await rpc('budget_pending()')).rows, [], 'pending list limited to accessible sites')
  await db.exec(`CREATE OR REPLACE FUNCTION has_tms_read_permission(text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$; SELECT set_config('test.perms', '', false)`)
  assert.match((await moves(id(20))).error, /Sin acceso/)
  assert.match((await rpc('budget_pending()')).error, /Sin acceso/)

  await assert.rejects(db.exec(read('supabase/tests/caja_c203_circuito_economico.test.sql')), /CAJA C203 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  await assert.rejects(db.exec(read('supabase/tests/caja_c207_reglas_d2_d3_d5.test.sql')), /CAJA C207 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  console.log('PASS circuito económico: movimientos explican comprometido y ejecutado sin doble conteo (propia, multi-OT, tercero, sin OT, descarga, Caja, combustible, cancelación, ajuste, cargos, componentes), diferencia histórica expuesta, pendientes, permisos, paginación y flete por OT editable')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
