// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Control de Jornada · Fase 2 (docs/control-jornada-plan.md): toneladas APT de una guía compartida contadas una vez;
// «odómetro retrocede» sin repetir; fleet_workdays con estado de jornada (D1), referencias, incidencias sin duplicar (D4),
// ahorro solo valorizado con lo pendiente aparte (D2), mantenimiento pendiente y alcance por sede.
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { PGlite } = require('@electric-sql/pglite')
const read = file => readFileSync(file, 'utf8')
const patch = (source, marker) => { const a = source.indexOf(marker); assert.ok(a >= 0, marker); const s = source.indexOf('DO $patch$', a); return source.slice(s, source.indexOf('END $patch$;', s) + 12) }
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
;(async () => {
 const db = new PGlite()
 try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT '${id(9)}'::uuid$$;
   CREATE TABLE public.vehicles(plate text, type text, status text, site_id uuid, current_odometer numeric);
   CREATE TABLE public.dispatches(id uuid, dispatch_number text, status text, driver_name text, scheduled_departure timestamptz,
     vehicle_plate text, modalidad text, actual_distance_km numeric, estimated_distance_km numeric, actual_distance_source text,
     start_odometer numeric, end_odometer numeric, operational_closed_at timestamptz, returned_at timestamptz, arrival_time timestamptz, liquidation_data jsonb);
   CREATE TABLE public.route_track_points(dispatch_id uuid, cumulative_m numeric);
   CREATE TABLE public.unit_odometer_readings(vehicle_plate text, operation_date date, kind text, captured_at timestamptz, odometer numeric, flag text, photo_path text);
   CREATE TABLE public.driver_preuse_inspections(vehicle_plate text, operation_date date, can_operate boolean, driver_name text);
   CREATE TABLE public.dispatch_requests(dispatch_id uuid, transport_request_id uuid, sequence_order int, status text, leg_actual_km numeric, leg_gps_complete boolean,
     leg_km_source text, stop_odometer numeric, stop_odometer_photo text, stop_odometer_flag text, document_number text);
   CREATE TABLE public.transport_requests(id uuid, request_number text, request_type text, contract_id uuid, client_id uuid, reference_type text, reference_number text,
     pickup_address text, pickup_district text, pickup_province text, pickup_department text, delivery_address text, delivery_district text, delivery_province text,
     delivery_department text, estimated_weight numeric, reference_supplier_id uuid);
   CREATE TABLE public.contracts(id uuid, code text, client_id uuid);
   CREATE TABLE public.clients(id uuid, business_name text);
   CREATE TABLE public.delivery_conformities(dispatch_id uuid, request_id uuid, state text, current_submission_id uuid);
   CREATE TABLE public.delivery_submissions(id uuid, guide_number text);
   CREATE TABLE public.apt_movements(documento text, peso_kg numeric, active bool, valid bool, kind text);
   CREATE TABLE public.suppliers(id uuid, business_name text);
   CREATE TABLE public.cost_allocations(dispatch_id uuid, status text, amount_pen numeric, kind text, basis text, expense_id uuid, request_id uuid, detail jsonb, created_at timestamptz);
   CREATE TABLE public.dispatch_expenses(id uuid, fuel_gallons numeric, fuel_odometer numeric, expense_type text);
   CREATE TABLE public.dispatch_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dispatch_id uuid, event_type text, description text, created_at timestamptz DEFAULT now());
   CREATE TABLE public.delivery_rejections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dispatch_id uuid, kind text, reason_code text, note text, captured_at timestamptz DEFAULT now());
   CREATE TABLE public.vehicle_incidents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), vehicle_plate text, incident_type text, description text, occurred_at timestamptz);
   CREATE TABLE public.maintenance_requests(vehicle_plate text, description text, status text, reported_at timestamptz DEFAULT now());
   CREATE FUNCTION public.can_view_unit_report() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
   CREATE FUNCTION public.can_access_site(p uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT p IS DISTINCT FROM '${id(2)}'::uuid $$;
   CREATE FUNCTION public.apt_guia_key(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT upper($1) $$;
   CREATE FUNCTION public.is_active_tms_user() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
   CREATE FUNCTION public.is_tms_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
   CREATE FUNCTION public.has_tms_permission(text) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
   CREATE FUNCTION public.budget_can_read() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
   CREATE TABLE public.freight_rates(vehicle_class text, is_active boolean, concept text);`)
  // Definiciones vigentes: reporte por unidad (base + 3 parches) y ahorro por consolidación
  await db.exec(read('supabase/migrations/20261024090000_reporte_unidad_km_referencias.sql'))
  await db.exec(patch(read('supabase/migrations/20261209100000_referencia_proveedor_y_reporte_costos.sql'), '-- Agrega proveedor y origen'))
  await db.exec(patch(read('supabase/migrations/20261209110000_km_ruta_odometro_y_reporte.sql'), '-- Expone kilómetros por OT'))
  await db.exec(patch(read('supabase/migrations/20261210100000_seguimiento_despachos_datos.sql'), '-- Alcance por sede'))
  await db.exec(read('supabase/migrations/20261211090000_ahorro_consolidacion.sql'))
  const migration = read('supabase/migrations/20261214090000_control_jornada_datos.sql')
  await db.exec(migration); await db.exec(migration)
  // Fase 3: id de ruta y de solicitud para abrir el detalle del despacho (idempotente)
  for (let i = 0; i < 2; i++) await db.exec(read('supabase/migrations/20261215090000_control_jornada_ids.sql'))
  const def = async f => (await db.query(`SELECT pg_get_functiondef('${f}'::regprocedure) d`)).rows[0].d
  assert.ok((await def('consolidation_savings(date,date,uuid,uuid)')).includes("WHEN f.hours_cost_missing THEN 'COSTO_HORA_PENDIENTE'"), 'D2 installed')
  assert.equal((await def('unit_daily_report(text,date,date)')).split('DISTINCT ON (public.apt_guia_key(s.guide))').length, 2, 'tn patch idempotent')
  const reportOids = `ARRAY['consolidation_savings(date,date,uuid,uuid)'::regprocedure,'fleet_workdays(date,date,text[])'::regprocedure,'unit_daily_report(text,date,date)'::regprocedure]::oid[]`
  const definitions = async () => (await db.query(`SELECT oid,prosrc,proacl,proowner,prosecdef FROM pg_proc WHERE oid=ANY(${reportOids}) ORDER BY oid`)).rows
  const beforeJit = await definitions()
  const noJit = read('supabase/migrations/20261226120000_reportes_jornada_sin_jit.sql')
  await db.exec(noJit); await db.exec(noJit)
  assert.deepEqual(await definitions(), beforeJit, 'La configuración JIT conserva cuerpos, ACL, propietarios y SECURITY DEFINER')
  assert.equal(Number((await db.query(`SELECT count(*) n FROM pg_proc WHERE oid=ANY(${reportOids}) AND proconfig @> ARRAY['jit=off']`)).rows[0].n),3)
  // Ahorro: se simula la respuesta de consolidation_savings (su cálculo tiene su propia prueba)
  await db.exec(`CREATE OR REPLACE FUNCTION public.consolidation_savings(p_from date DEFAULT NULL, p_to date DEFAULT NULL, p_contract uuid DEFAULT NULL, p_dispatch uuid DEFAULT NULL)
   RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{"success":true,"rows":[
    {"dispatch_number":"R-1","principal":true,"state":"PRINCIPAL"},
    {"dispatch_number":"R-1","principal":false,"state":"VALORIZADO","standalone_pen":300,"marginal_pen":100,"saving_pen":200},
    {"dispatch_number":"R-1","principal":false,"state":"COSTO_HORA_PENDIENTE","standalone_pen":500,"marginal_pen":20,"saving_pen":null}]}'::jsonb $$`)

  await db.exec(`INSERT INTO vehicles VALUES ('T8B-942','CAMION','DISPONIBLE','${id(1)}',1300),('OTRA-1','CAMION','DISPONIBLE','${id(2)}',0),('EXTERNO','X','X','${id(1)}',0),('AAA-2','CAMION','DISPONIBLE','${id(1)}',0);
   INSERT INTO contracts VALUES ('${id(30)}','16544',NULL);
   -- 29/10: jornada completa, dos paradas con la misma guía (2 000 kg APT)
   INSERT INTO unit_odometer_readings VALUES ('T8B-942','2026-10-29','INICIO','2026-10-29 11:30+00',1000,NULL,'p1'),('T8B-942','2026-10-29','CIERRE','2026-10-29 20:45+00',1150,NULL,'p2'),
    -- 30/10: sin cierre; el fin sale del inicio del día siguiente
    ('T8B-942','2026-10-30','INICIO','2026-10-30 11:30+00',1150,NULL,'p3'),
    -- 31/10: el cierre retrocede (marcado al registrar) → una sola alerta
    ('T8B-942','2026-10-31','INICIO','2026-10-31 11:30+00',1300,NULL,'p4'),('T8B-942','2026-10-31','CIERRE','2026-10-31 20:00+00',1290,'RETROCESO','p5'),
    -- otra unidad: inicio sin cierre ni lecturas posteriores → abierta
    ('AAA-2','2026-10-31','INICIO','2026-10-31 11:30+00',500,NULL,'p6');
   INSERT INTO driver_preuse_inspections VALUES ('T8B-942','2026-10-29',true,'OMAR RONCO'),('T8B-942','2026-10-30',true,'OMAR RONCO'),('T8B-942','2026-10-31',true,'OMAR RONCO'),('AAA-2','2026-10-31',true,'ANA');
   INSERT INTO dispatches(id,dispatch_number,status,driver_name,scheduled_departure,vehicle_plate,modalidad) VALUES
    ('${id(61)}','R-1','LIQUIDADO','OMAR RONCO','2026-10-29 13:00+00','T8B-942','PROPIA'),('${id(62)}','R-2','LIQUIDADO','OMAR RONCO','2026-10-30 13:00+00','T8B-942','PROPIA');
   INSERT INTO route_track_points VALUES ('${id(61)}',140000),('${id(62)}',10000);
   INSERT INTO transport_requests(id,request_number,request_type,contract_id,reference_type,reference_number,estimated_weight) VALUES
    ('${id(41)}','S-1','DESPACHO','${id(30)}','OC','57954',900),('${id(42)}','S-2','DESPACHO','${id(30)}','OS','58006',800),('${id(43)}','S-3','RECOJO',NULL,'RQ','77',500);
   INSERT INTO dispatch_requests(dispatch_id,transport_request_id,sequence_order,status) VALUES ('${id(61)}','${id(41)}',1,'ENTREGADO'),('${id(61)}','${id(42)}',2,'ENTREGADO'),('${id(62)}','${id(43)}',1,'ENTREGADO');
   INSERT INTO delivery_submissions VALUES ('${id(71)}','G1'),('${id(72)}','g1');
   INSERT INTO delivery_conformities VALUES ('${id(61)}','${id(41)}','VALIDADA','${id(71)}'),('${id(61)}','${id(42)}','VALIDADA','${id(72)}');
   INSERT INTO apt_movements VALUES ('G1',2000,true,true,'SALIDA');
   INSERT INTO dispatch_events(dispatch_id,event_type,description) VALUES ('${id(62)}','INCIDENCIA','Llanta baja'),('${id(62)}','CHECKPOINT','Paso');
   INSERT INTO delivery_rejections(dispatch_id,kind,reason_code) VALUES ('${id(62)}','PARCIAL','CLIENTE_AUSENTE');
   INSERT INTO vehicle_incidents(vehicle_plate,incident_type,description,occurred_at) VALUES ('T8B-942','DANO','Golpe en retroceso','2026-10-30 15:00+00');
   INSERT INTO maintenance_requests VALUES ('T8B-942','Revisar frenos','PENDIENTE'),('T8B-942','Ya atendida','CERRADA');`)

  // Toneladas: una guía compartida por dos paradas cuenta una vez (antes 4 t)
  const ud = (await db.query(`SELECT unit_daily_report('T8B-942','2026-10-28','2026-10-31') v`)).rows[0].v
  const day = d => ud.days.find(x => x.date === d)
  assert.deepEqual([Number(day('2026-10-29').tn_apt), Number(day('2026-10-29').tn)], [2, 2], 'APT of a shared guide counted once')
  assert.deepEqual(day('2026-10-31').alerts.filter(a => a === 'ODOMETRO_RETROCEDE').length, 1, 'alert not repeated')
  const route = day('2026-10-29').dispatches[0]
  assert.deepEqual([route.id, route.stops.map(x => x.request_id)], [id(61), [id(41), id(42)]], 'ids exposed for the dispatch detail')

  const r = (await db.query(`SELECT fleet_workdays('2026-10-28','2026-10-31') v`)).rows[0].v
  assert.equal(r.success, true, r.error)
  assert.deepEqual(r.units.map(u => u.plate), ['AAA-2', 'T8B-942'], 'other site and EXTERNO excluded')
  const row = (p, d) => r.rows.find(x => x.plate === p && x.date === d)
  // Estados (D1)
  assert.deepEqual([row('T8B-942', '2026-10-28').status, row('T8B-942', '2026-10-29').status, row('T8B-942', '2026-10-30').status,
   row('T8B-942', '2026-10-31').status, row('AAA-2', '2026-10-31').status], ['SIN_OPERACION', 'CERRADA', 'EN_REVISION', 'EN_REVISION', 'ABIERTA'])
  // Referencias
  assert.deepEqual(row('T8B-942', '2026-10-29').refs, { OT: ['16544'], OC: ['57954'], OS: ['58006'], RQ: [] })
  assert.deepEqual(row('T8B-942', '2026-10-30').refs.RQ, ['77'])
  // Incidencias (D4): evento de incidencia, rechazo e incidente de unidad, una vez cada uno; el checkpoint no cuenta
  assert.deepEqual(row('T8B-942', '2026-10-30').incidents.map(i => i.source).sort(), ['EVENTO', 'RECHAZO', 'UNIDAD'])
  assert.equal(row('T8B-942', '2026-10-29').incidents.length, 0)
  // Ahorro (D2): solo lo valorizado; lo pendiente se cuenta aparte; días sin rutas compartidas sin ahorro
  assert.deepEqual(row('T8B-942', '2026-10-29').saving, { value: 300, marginal: 100, saving: 200, valued: 1, pending: 1 })
  assert.equal(row('T8B-942', '2026-10-30').saving, null)
  // Mantenimiento pendiente
  assert.deepEqual(r.units.find(u => u.plate === 'T8B-942').maintenance.map(m => m.detail), ['Revisar frenos'])
  // Filtro por unidades y validación del período
  const one = (await db.query(`SELECT fleet_workdays('2026-10-28','2026-10-31', ARRAY['AAA-2']) v`)).rows[0].v
  assert.deepEqual([...new Set(one.rows.map(x => x.plate))], ['AAA-2'])
  assert.match((await db.query(`SELECT fleet_workdays('2026-10-01','2027-01-31') v`)).rows[0].v.error, /hasta 3 meses/)

  await assert.rejects(db.exec(read('supabase/tests/caja_c211_control_jornada.test.sql')), /CAJA C211 PASS/)
  console.log('PASS control de jornada (fase 2): toneladas APT sin duplicar, alerta única, estados de jornada, referencias, incidencias, ahorro valorizado, mantenimiento y sede')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
