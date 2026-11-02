// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Ahorro por consolidación (docs/control-presupuestal/ahorro-consolidacion.md): servicio principal sin ahorro; aprovechado =
// tarifa por distrito y clase − costo marginal. Propia: combustible de km extra + horas × (unidad + tripulación) + peajes;
// tercero: flete pagado + peajes. Programados juntos, agregado en ruta, sin tarifa, ruta de un servicio, filtro por OT,
// costos por hora faltantes y permisos. Importes calculados a mano.
const assert = require('node:assert/strict')
const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const read = p => readFileSync(p, 'utf8')
const fn = (file, name, end = 'END $$;') => { const s = read(file), a = s.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`); assert(a >= 0, name); return s.slice(a, s.indexOf(end, s.indexOf('AS $$', a) + 5) + end.length) }
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
;(async () => {
 const db = new PGlite()
 try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT '${id(9)}'::uuid$$;
   CREATE FUNCTION is_active_tms_user() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
   CREATE FUNCTION is_tms_admin() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
   CREATE FUNCTION is_contract_administrator() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
   CREATE FUNCTION has_assigned_contract(uuid, boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
   CREATE FUNCTION has_tms_permission(p text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT p = ANY(string_to_array(current_setting('test.perms', true), ','))$$;
   CREATE FUNCTION budget_can_read() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.read', true) IS DISTINCT FROM 'no'$$;
   CREATE FUNCTION can_access_site(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
   CREATE FUNCTION norm_address(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT lower(trim($1))$$;
   CREATE TABLE clients(id uuid PRIMARY KEY, business_name text);
   CREATE TABLE contracts(id uuid PRIMARY KEY, code text, parent_contract_id uuid, client_id uuid, site_id uuid);
   CREATE FUNCTION contract_root_id(p uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
    WITH RECURSIVE up(id, parent) AS (SELECT id, parent_contract_id FROM contracts WHERE id = p UNION SELECT c.id, c.parent_contract_id FROM contracts c JOIN up ON c.id = up.parent)
    SELECT id FROM up WHERE parent IS NULL$$;
   CREATE TABLE freight_rates(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), concept text DEFAULT 'FLETE', rate numeric, rate_basis text DEFAULT 'VIAJE', scope text DEFAULT 'GENERAL',
    client_price numeric, vehicle_class text, plate_number text, district text, zone text, is_active boolean DEFAULT true, valid_from date DEFAULT '2020-01-01', valid_to date,
    client_id uuid, contract_id uuid, capacity_ton numeric);
   CREATE TABLE dispatches(id uuid PRIMARY KEY, dispatch_number text, status text, vehicle_plate text, driver_id uuid, site_id uuid, modalidad text, scheduled_departure timestamptz,
    departure_time timestamptz, returned_at timestamptz, actual_distance_km numeric NOT NULL DEFAULT 0, estimated_distance_km numeric, created_at timestamptz DEFAULT now());
   CREATE TABLE transport_requests(id uuid PRIMARY KEY, request_number text, contract_id uuid, request_type text, attention_mode text, delivery_district text, pickup_district text, estimated_weight numeric);
   CREATE TABLE dispatch_requests(dispatch_id uuid, transport_request_id uuid, sequence_order int);
   CREATE TABLE dispatch_route_estimates(dispatch_id uuid, request_id uuid, distance_km numeric, duration_min numeric);
   CREATE TABLE dispatch_service_additions(dispatch_id uuid, request_id uuid, extra_km numeric);
   CREATE TABLE dispatch_crew(dispatch_id uuid, profile_id uuid, crew_role text, removed_at timestamptz);
   CREATE TABLE dispatch_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dispatch_id uuid, transport_request_id uuid, expense_type text, amount numeric, approved_amount numeric, status text);
   CREATE TABLE dispatch_request_freight(dispatch_id uuid, request_id uuid, contract_id uuid, amount_pen numeric, status text DEFAULT 'CONSUMIDO');
   CREATE TABLE dispatch_request_freight_stages(dispatch_id uuid, request_id uuid, final_applied_pen numeric);
   CREATE TABLE vehicles(plate text, expected_km_per_gallon numeric);
   CREATE TABLE caja_settings(id boolean PRIMARY KEY DEFAULT true, default_km_per_gallon numeric DEFAULT 10, fuel_price_per_gallon numeric DEFAULT 16);
   INSERT INTO caja_settings DEFAULT VALUES;
   SELECT set_config('test.perms', 'control-presupuestal-autorizar', false);`)
  await db.exec(fn('supabase/migrations/20260930100000_tarifario_transporte.sql', 'tariff_pick', '$$;'))
  const circuit = read('supabase/migrations/20261201090000_circuito_economico_movimientos.sql')
  const fam = circuit.indexOf('CREATE OR REPLACE FUNCTION public.budget_family('); await db.exec(circuit.slice(fam, circuit.indexOf('END $$;', fam) + 7))
  const migration = read('supabase/migrations/20261211090000_ahorro_consolidacion.sql')
  await db.exec(migration); await db.exec(migration)
  const rpc = async (sql, params = []) => (await db.query(`SELECT ${sql} AS v`, params)).rows[0].v

  // Tarifario: 4T y 1T con capacidad; tarifa de placa para la clase de la unidad propia
  await db.exec(`INSERT INTO freight_rates(vehicle_class, district, rate, capacity_ton) VALUES ('4T','Chilca',900,4),('1T','Chilca',500,1),('4T','Lurin',450,4),('1T','Lurin',300,1),
    ('4T','Cercado',400,4); INSERT INTO freight_rates(vehicle_class, plate_number, district, rate) VALUES ('4T','PRO-1','Chilca',900);
   INSERT INTO vehicles VALUES ('PRO-1',20);
   INSERT INTO clients VALUES ('${id(5)}','METALPREN');
   INSERT INTO contracts VALUES ('${id(10)}','OT-A',NULL,'${id(5)}',NULL),('${id(20)}','OT-B',NULL,'${id(5)}',NULL),('${id(21)}','OT-B-S1','${id(20)}','${id(5)}',NULL);
   INSERT INTO transport_requests VALUES
    ('${id(41)}','S-1','${id(10)}','DESPACHO',NULL,'Chilca',NULL,3000),('${id(42)}','S-2','${id(10)}','RECOJO',NULL,'Almacen','Lurin',500),('${id(43)}','S-3','${id(21)}','DESPACHO',NULL,'Cercado',NULL,NULL),
    ('${id(44)}','S-4','${id(10)}','DESPACHO',NULL,'Chilca',NULL,3000),('${id(45)}','S-5',NULL,'TRASLADO',NULL,'Lurin',NULL,500),
    ('${id(46)}','S-6','${id(10)}','DESPACHO',NULL,'Chilca',NULL,3000),('${id(47)}','S-7','${id(20)}','DESPACHO',NULL,'Cercado',NULL,NULL),('${id(48)}','S-8','${id(20)}','DESPACHO',NULL,'Ica',NULL,NULL),
    ('${id(49)}','S-9','${id(10)}','DESPACHO',NULL,'Chilca',NULL,3000);
   -- D1 propia: tres servicios programados juntos, 120 km y 6 h reales, conductor y un auxiliar
   INSERT INTO dispatches(id,dispatch_number,status,vehicle_plate,driver_id,modalidad,scheduled_departure,departure_time,returned_at,actual_distance_km) VALUES
    ('${id(61)}','R-1','LIQUIDADO','PRO-1','${id(7)}','PROPIA','2026-11-01 13:00+00','2026-11-01 13:00+00','2026-11-01 19:00+00',120),
    ('${id(62)}','R-2','LIQUIDADO','PRO-1','${id(7)}','PROPIA','2026-11-01 13:00+00','2026-11-01 13:00+00','2026-11-01 18:00+00',110),
    ('${id(63)}','R-3','LIQUIDADO','TER-9',NULL,'TERCERO','2026-11-01 13:00+00',NULL,NULL,0),
    ('${id(64)}','R-4','LIQUIDADO','PRO-1','${id(7)}','PROPIA','2026-11-01 13:00+00',NULL,NULL,50);
   INSERT INTO dispatch_requests VALUES ('${id(61)}','${id(41)}',1),('${id(61)}','${id(42)}',2),('${id(61)}','${id(43)}',3),('${id(62)}','${id(44)}',1),('${id(62)}','${id(45)}',2),
    ('${id(63)}','${id(46)}',1),('${id(63)}','${id(47)}',2),('${id(63)}','${id(48)}',3),('${id(64)}','${id(49)}',1);
   INSERT INTO dispatch_route_estimates VALUES ('${id(61)}','${id(41)}',100,150),('${id(61)}','${id(42)}',20,40),('${id(61)}','${id(43)}',30,60),('${id(62)}','${id(44)}',100,150),('${id(62)}','${id(45)}',25,45);
   INSERT INTO dispatch_service_additions VALUES ('${id(62)}','${id(45)}',10);
   INSERT INTO dispatch_crew VALUES ('${id(61)}','${id(8)}','AUXILIAR',NULL);
   INSERT INTO dispatch_expenses(dispatch_id,transport_request_id,expense_type,amount,status) VALUES ('${id(61)}','${id(43)}','PEAJE',7,'APROBADO'),('${id(61)}','${id(43)}','PEAJE',9,'RECHAZADO');
   INSERT INTO dispatch_request_freight VALUES ('${id(63)}','${id(46)}','${id(10)}',700),('${id(63)}','${id(47)}','${id(20)}',150),('${id(63)}','${id(48)}','${id(20)}',80);`)
  for (const [k, v] of [['UNIDAD:4T', 30], ['ROL:CONDUCTOR', 15], ['ROL:AUXILIAR', 10]]) assert.equal((await rpc('consolidation_hour_cost_set($1,$2)', [k, v])).success, true)

  const r = await rpc(`consolidation_savings('2026-11-01','2026-11-01')`)
  assert.equal(r.success, true, r.error)
  const row = n => r.rows.find(x => x.request_number === n)
  const pick = x => [x.state, Number(x.standalone_pen), x.vehicle_class, x.extra_km == null ? null : Number(x.extra_km), Number(x.extra_hours), Number(x.fuel_pen), Number(x.hours_pen), Number(x.tolls_pen), x.marginal_pen == null ? null : Number(x.marginal_pen), x.saving_pen == null ? null : Number(x.saving_pen)]
  // R-1: principal S-1 (Chilca 4T 900). Extra de la ruta: 120 − 100 = 20 km y 6 − 2.5 = 3.5 h, repartidos por km directos (20:30)
  assert.deepEqual(pick(row('S-1')), ['PRINCIPAL', 900, '4T', 0, 0, 0, 0, 0, null, null])
  // S-2 recojo en Lurín, 500 kg → 1T 300. 8 km → 8/20×16 = 6.40; 1.4 h × (30+15+10) = 77.00 → ahorro 216.60
  assert.deepEqual(pick(row('S-2')), ['VALORIZADO', 300, '1T', 8, 1.4, 6.4, 77, 0, 83.4, 216.6])
  // S-3 sin peso → clase de la unidad (4T) a Cercado 400. 12 km → 9.60; 2.1 h × 55 = 115.50; peaje aprobado 7 → ahorro 267.90
  assert.deepEqual(pick(row('S-3')), ['VALORIZADO', 400, '4T', 12, 2.1, 9.6, 115.5, 7, 132.1, 267.9])
  assert.equal(row('S-3').root_code, 'OT-B', 'subcontract attributed to its root OT')
  // R-2: S-5 agregado en ruta con 10 km extra; velocidad 110/5 = 22 km/h → 0.45 h; sin OT (operación general); sin auxiliar
  const s5 = row('S-5')
  assert.deepEqual([s5.added, s5.contract_code, Number(s5.extra_km), Number(s5.fuel_pen), Number(s5.hours_pen), Number(s5.saving_pen)], [true, null, 10, 8, 20.45, 271.55])
  // R-3 tercero: flete pagado por el servicio; Ica sin tarifa
  assert.deepEqual([row('S-7').state, Number(row('S-7').freight_paid_pen), Number(row('S-7').marginal_pen), Number(row('S-7').saving_pen)], ['VALORIZADO', 150, 150, 250])
  assert.deepEqual([row('S-8').state, row('S-8').saving_pen], ['SIN_TARIFA', null])
  // R-4 de un solo servicio: no aparece, pero cuenta para la tasa de aprovechamiento
  assert.equal(row('S-9'), undefined)
  assert.deepEqual([r.services_total, r.leveraged, Number(r.saving_total), r.hours_cost_missing], [9, 5, 216.6 + 267.9 + 271.55 + 250, false])

  // Filtro por OT (familia): solo sus servicios; la tasa cuenta las rutas donde participa
  const b = await rpc(`consolidation_savings('2026-11-01','2026-11-01',$1)`, [id(20)])
  assert.deepEqual(b.rows.map(x => x.request_number).sort(), ['S-3', 'S-7', 'S-8'])
  // Un viaje
  const one = await rpc(`consolidation_savings(NULL,NULL,NULL,$1)`, [id(61)])
  assert.deepEqual(one.rows.map(x => x.request_number), ['S-1', 'S-2', 'S-3'])
  // Sin costo del auxiliar: las horas quedan sin valorizar y se avisa
  await rpc(`consolidation_hour_cost_set('ROL:AUXILIAR', NULL)`)
  const miss = await rpc(`consolidation_savings('2026-11-01','2026-11-01')`)
  assert.deepEqual([miss.hours_cost_missing, Number(miss.rows.find(x => x.request_number === 'S-2').hours_pen)], [true, 0])
  // Validaciones y permisos
  assert.match((await rpc(`consolidation_savings('2026-11-02','2026-11-01')`)).error, /período válido/)
  assert.match((await rpc(`consolidation_hour_cost_set('ROL:CONDUCTOR', 1.234)`)).error, /dos decimales/)
  await db.exec(`SELECT set_config('test.perms', '', false)`)
  assert.match((await rpc(`consolidation_hour_cost_set('ROL:CONDUCTOR', 20)`)).error, /Administrador o Gerencia/)
  assert.equal((await rpc('consolidation_hour_costs_get()')).can_edit, false)
  await db.exec(`SELECT set_config('test.read', 'no', false)`)
  assert.match((await rpc(`consolidation_savings('2026-11-01','2026-11-01')`)).error, /Sin acceso/)

  await assert.rejects(db.exec(read('supabase/tests/caja_c209_ahorro_consolidacion.test.sql')), /CAJA C209 PASS/)
  console.log('PASS ahorro por consolidación: principal, programados juntos, agregado en ruta, tercero, sin tarifa, filtro por OT, costos por hora y permisos')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
