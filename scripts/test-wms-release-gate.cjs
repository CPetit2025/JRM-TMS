// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Salida liberada por el WMS: asignar y programar sigue permitido; la SALIDA (PROGRAMADO → EN_CURSO / EN RUTA y
// solicitud → EN TRANSITO) exige la liberación del almacén para despachos APT con OT. Corte con excepción de sistema
// para lo ya asignado, excepción del supervisor con motivo, falla cerrada sin latido, fotos fuera de orden y
// RECOJO/TRASLADO sin cambio. Termina corriendo la prueba de caja C222.
const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const read = path => readFileSync(path, 'utf8')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const KEY = 'clave-de-prueba-wms-' + 'x'.repeat(40)
;(async () => {
 const db = new PGlite()
 try {
  await db.exec(read('scripts/fixtures/hhee-schema.sql'))
  // Tipo producción: columnas reales usadas, dispatch_requests con created_at, índices únicos de unidad y conductor,
  // system_settings con PK key, sin updated_at en dispatches.
  await db.exec(`
   ALTER TABLE contracts ADD COLUMN client_id uuid, ADD COLUMN type text DEFAULT 'CONTRATO';
   CREATE TABLE clients(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_name text, tax_id text); -- como producción: RUC en tax_id; no existen ruc ni commercial_name
   CREATE TABLE transport_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_number varchar, requester_name varchar,
     request_type varchar, status varchar, contract_id uuid, pickup_address text, delivery_address text, required_date timestamptz,
     site_id uuid, attention_mode text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
   CREATE TABLE transport_request_components(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid, component_contract_id uuid,
     requested_weight_kg numeric, requested_volume_m3 numeric);
   CREATE TABLE drivers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid, is_active boolean DEFAULT true);
   CREATE TABLE dispatches(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dispatch_number varchar, status varchar DEFAULT 'PROGRAMADO',
     vehicle_plate text, driver_id uuid, driver_name text, scheduled_departure timestamptz, site_id uuid, modalidad text);
   CREATE UNIQUE INDEX dispatch_one_active_driver ON dispatches(driver_id) WHERE status IN ('PROGRAMADO','EN_CURSO','EN RUTA');
   CREATE UNIQUE INDEX dispatch_one_active_vehicle ON dispatches(vehicle_plate) WHERE status IN ('PROGRAMADO','EN_CURSO','EN RUTA');
   CREATE TABLE dispatch_requests(dispatch_id uuid REFERENCES dispatches, transport_request_id uuid REFERENCES transport_requests,
     status varchar DEFAULT 'PROGRAMADO', created_at timestamptz DEFAULT now());
   CREATE TABLE system_settings(key varchar PRIMARY KEY, value text, description text, updated_at timestamptz);
   ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
   INSERT INTO contracts(id, code) VALUES ('${id(20)}', '16596');
   INSERT INTO roles(id, name, permissions) VALUES ('${id(90)}', 'Supervisor de Despacho', '["despacho-aprobacion","despacho"]'),
     ('${id(91)}', 'Programador', '["despacho","solicitudes"]'), ('${id(92)}', 'Conductor', '[]');
   INSERT INTO profiles(id, role_id, first_name, last_name) VALUES ('${id(93)}', '${id(90)}', 'Sara', 'Supervisora'),
     ('${id(94)}', '${id(91)}', 'Pablo', 'Programador'), ('${id(95)}', '${id(92)}', 'Carlos', 'Conductor');
   INSERT INTO auth.users VALUES ('${id(93)}'), ('${id(94)}'), ('${id(95)}');
   INSERT INTO user_site_access SELECT u, primary_site_id() FROM unnest(ARRAY['${id(93)}','${id(94)}','${id(95)}']::uuid[]) u;
   INSERT INTO drivers(id, profile_id) VALUES ('${id(80)}', '${id(95)}'), ('${id(81)}', NULL), ('${id(82)}', NULL), ('${id(83)}', NULL);
   -- Antes del corte: L1 ya asignada y programada; A1/A2 aprobadas; recojo, traslado, despacho sin OT y de otro origen.
   INSERT INTO transport_requests(id, request_number, request_type, status, contract_id, pickup_address, site_id) VALUES
     ('${id(40)}', 'RT-000040', 'DESPACHO', 'ASIGNADA', '${id(20)}', 'Planta Chilca', primary_site_id()),
     ('${id(41)}', 'RT-000041', 'DESPACHO', 'APROBADA', '${id(20)}', 'Planta Chilca', primary_site_id()),
     ('${id(42)}', 'RT-000042', NULL, 'APROBADA', '${id(20)}', 'Planta Chilca', primary_site_id()),
     ('${id(43)}', 'RT-000043', 'RECOJO', 'APROBADA', '${id(20)}', 'Av. Argentina 523', primary_site_id()),
     ('${id(44)}', 'RT-000044', 'TRASLADO', 'APROBADA', '${id(20)}', 'FUNDO EL TRIGAL, CHILCA', primary_site_id()),
     ('${id(45)}', 'RT-000045', 'DESPACHO', 'APROBADA', NULL, 'Planta Chilca', primary_site_id()),
     ('${id(46)}', 'RT-000046', 'DESPACHO', 'APROBADA', '${id(20)}', 'Almacén tercero Lurín', primary_site_id());
   INSERT INTO dispatches(id, dispatch_number, vehicle_plate, driver_id, site_id) VALUES ('${id(60)}', 'R-60', 'AAA-111', '${id(81)}', primary_site_id());
   INSERT INTO dispatch_requests(dispatch_id, transport_request_id) VALUES ('${id(60)}', '${id(40)}');`)
  await db.exec(read('supabase/migrations/20261231090000_wms_integracion.sql'))
  await db.query(`UPDATE integration_keys SET key_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex') WHERE name = 'wms'`, [KEY])
  const migration = read('supabase/migrations/20261231180000_salida_liberada_por_wms.sql')
  assert.doesNotMatch(migration, /\b(drivers|vehicles|dispatches)\.updated_at\b/, 'no usa columnas inexistentes en producción')
  await db.exec(migration); await db.exec(migration)
  await db.exec(read('supabase/migrations/20261231190000_feed_wms_ruc_tax_id.sql'))
  await db.exec(read('supabase/migrations/20261231200000_feed_wms_commercial_name.sql'))

  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0]
  const rpc = async (sql, params = []) => (await one(`SELECT ${sql} AS value`, params)).value
  const as = u => db.exec(`SELECT set_config('request.jwt.claim.sub', '${u ? id(u) : ''}', false)`)
  const report = (req, status, at, extra = {}) => rpc(`wms_report_request_status($1, $2::jsonb)`,
    [KEY, JSON.stringify([{ transport_request_id: id(req), status, task_code: `WH-${req}`, snapshot_at: at, ...extra }])])
  const depart = (d, to = 'EN_CURSO') => db.query(`UPDATE dispatches SET status = $2 WHERE id = $1`, [id(d), to])
  const t0 = new Date('2026-11-12T10:00:00Z').getTime(), at = m => new Date(t0 + m * 60000).toISOString()

  // Corte: una sola excepción de sistema (aunque la migración corra dos veces) y solo para lo ya asignado.
  const legacy = await one(`SELECT count(*)::int n, min(reason) reason, bool_and(created_by IS NULL) sys FROM request_wms_release_overrides`)
  assert.deepEqual(legacy, { n: 1, reason: 'Solicitud asignada antes del flujo con WMS', sys: true })
  assert.ok((await one(`SELECT value FROM system_settings WHERE key = 'wms_release_gate_cutover'`)).value)
  await depart(60) // L1 (asignada antes del corte) sale sin WMS
  assert.equal((await one(`SELECT status FROM dispatches WHERE id = $1`, [id(60)])).status, 'EN_CURSO')

  // Asignar y programar A1 antes de la liberación: permitido.
  await db.exec(`INSERT INTO dispatches(id, dispatch_number, vehicle_plate, driver_id, site_id) VALUES ('${id(61)}', 'R-61', 'BBB-222', '${id(80)}', primary_site_id());
   INSERT INTO dispatch_requests(dispatch_id, transport_request_id) VALUES ('${id(61)}', '${id(41)}');
   UPDATE transport_requests SET status = 'ASIGNADA' WHERE id = '${id(41)}';`)
  // Salida sin latido del WMS: falla cerrada.
  await assert.rejects(depart(61), /La solicitud RT-000041 aún no fue liberada por el almacén \(picking y auditoría en el WMS\); no puede salir\. Estado WMS: Sin respuesta del WMS/)
  // Clave incorrecta rechazada; con la clave informa estados y latido.
  await assert.rejects(db.query(`SELECT wms_report_request_status('clave-incorrecta-clave-incorrecta-12345', '[]')`), /Clave de integración inválida/)
  assert.equal((await report(41, 'EN_PICKING', at(1))).applied, 1)
  assert.equal((await report(41, 'EN_PICKING', at(1))).applied, 0, 'reintento de la misma foto no escribe')
  await assert.rejects(depart(61), /RT-000041.*Estado WMS: En picking/)
  // Orden: EN_AUDITORIA 10:02, misma foto con estado igual 10:04 (avanza la marca) y un LIBERADO atrasado de 10:03.
  await report(41, 'EN_AUDITORIA', at(2))
  assert.equal((await report(41, 'EN_AUDITORIA', at(4))).applied, 1, 'una foto más nueva avanza la marca aunque no cambie')
  assert.equal((await report(41, 'LIBERADO', at(3), { released_at: at(3) })).applied, 0, 'un LIBERADO atrasado no reabre la salida')
  await assert.rejects(depart(61), /RT-000041.*Estado WMS: En auditoría/)
  // Desconocidas y estados inválidos se ignoran sin romper el lote.
  assert.equal((await rpc(`wms_report_request_status($1, $2::jsonb)`, [KEY, JSON.stringify([
    { transport_request_id: id(999), status: 'LIBERADO' }, { transport_request_id: id(41), status: 'OTRO' }])])).applied, 0)
  // Liberada: sale; una foto vieja posterior no la pisa.
  await report(41, 'LIBERADO', at(5), { released_at: at(5) })
  await report(41, 'EN_AUDITORIA', at(3))
  assert.equal((await one(`SELECT status FROM request_wms_status WHERE transport_request_id = $1`, [id(41)])).status, 'LIBERADO')
  await depart(61); await depart(61, 'EN RUTA')
  // El feed al WMS informa la placa y el conductor de la ruta asignada.
  const feed = await rpc(`wms_feed_solicitudes($1, $2::uuid[])`, [KEY, [id(41)]])
  assert.equal(feed.find(r => r.id === id(41)).dispatch.vehicle_plate, 'BBB-222')
  const legacyFeed = await rpc(`wms_feed_solicitudes($1, $2::uuid[])`, [KEY, [id(40), id(41)]])
  assert.deepEqual(legacyFeed.filter(r => [id(40), id(41)].includes(r.id)).map(r => [r.request_number, r.legacy_flow]).sort(), [['RT-000040', true], ['RT-000041', false]])

  // A2 (tipo nulo = DESPACHO): liberación deshecha bloquea; cambio manual a EN TRANSITO también bloqueado.
  await report(42, 'LIBERADO', at(6), { released_at: at(6) })
  await report(42, 'EN_AUDITORIA', at(7))
  await db.exec(`INSERT INTO dispatches(id, dispatch_number, vehicle_plate, driver_id, site_id) VALUES ('${id(62)}', 'R-62', 'CCC-333', '${id(82)}', primary_site_id());
   INSERT INTO dispatch_requests(dispatch_id, transport_request_id) VALUES ('${id(62)}', '${id(42)}');
   UPDATE transport_requests SET status = 'ASIGNADA' WHERE id = '${id(42)}';`)
  await assert.rejects(depart(62), /RT-000042.*En auditoría/)
  await assert.rejects(db.query(`UPDATE transport_requests SET status = 'EN TRANSITO' WHERE id = $1`, [id(42)]), /RT-000042 aún no fue liberada/)

  // Excepción: solo Supervisor de Despacho / Administrador, con motivo de 20+ caracteres; queda auditada.
  await as(94)
  assert.match((await rpc(`wms_release_override($1, $2)`, [id(42), 'Cliente espera en planta, urgente'])).error, /Supervisor de Despacho/)
  const listed = await rpc(`wms_release_status($1::uuid[], NULL)`, [[id(41), id(42), id(43)]])
  assert.equal(listed.can_override, false)
  assert.deepEqual(listed.items.map(i => [i.request_number, i.required, i.blocked]).sort(),
    [['RT-000041', true, false], ['RT-000042', true, true], ['RT-000043', false, false]])
  await as(93)
  assert.match((await rpc(`wms_release_override($1, $2)`, [id(42), 'urgente'])).error, /mínimo 20/)
  assert.equal((await rpc(`wms_release_override($1, $2)`, [id(42), 'Cliente espera en planta, emergencia autorizada'])).success, true)
  assert.match((await rpc(`wms_release_override($1, $2)`, [id(42), 'Cliente espera en planta, emergencia autorizada'])).error, /ya está liberada o tiene excepción/)
  assert.match((await rpc(`wms_release_override($1, $2)`, [id(43), 'Recojo no necesita liberación del WMS'])).error, /no requiere/)
  const ov = await one(`SELECT created_by, reason FROM request_wms_release_overrides WHERE transport_request_id = $1`, [id(42)])
  assert.equal(ov.created_by, id(93))
  const gate = await rpc(`wms_release_status(NULL, $1)`, [id(62)])
  assert.equal(gate.items[0].override.by, 'Sara Supervisora')
  await as(null)
  await depart(62)

  // El conductor ve el estado de su propio despacho; un tercero sin permisos no.
  await db.exec(`INSERT INTO dispatches(id, dispatch_number, vehicle_plate, driver_id, site_id, status) VALUES ('${id(63)}', 'R-63', 'DDD-444', '${id(83)}', primary_site_id(), 'PROGRAMADO');`)
  await as(95)
  assert.equal((await rpc(`wms_release_status(NULL, $1)`, [id(61)])).success, true)
  assert.equal((await rpc(`wms_release_status(NULL, $1)`, [id(63)])).success, false)
  assert.equal((await rpc(`wms_release_status($1::uuid[], NULL)`, [[id(41)]])).success, false)
  await as(null)

  // RECOJO, TRASLADO, despacho sin OT y despacho de otro origen: salen sin WMS.
  await db.exec(`INSERT INTO dispatch_requests(dispatch_id, transport_request_id) VALUES
    ('${id(63)}', '${id(43)}'), ('${id(63)}', '${id(44)}'), ('${id(63)}', '${id(45)}'), ('${id(63)}', '${id(46)}');`)
  await depart(63)

  // Privilegios: nada interno expuesto; anónimo solo con clave en el informe.
  const priv = await one(`SELECT has_function_privilege('authenticated','wms_release_gate(uuid)','EXECUTE') g,
    has_function_privilege('anon','wms_release_status(uuid[],uuid)','EXECUTE') s, has_function_privilege('anon','wms_release_override(uuid,text)','EXECUTE') o,
    has_table_privilege('authenticated','request_wms_status','INSERT') i, has_table_privilege('anon','request_wms_status','SELECT') a`)
  assert.deepEqual(priv, { g: false, s: false, o: false, i: false, a: false })

  await db.exec(`SELECT set_config('request.jwt.claims', '', false)`)
  await assert.rejects(db.exec(read('supabase/tests/caja_c222_salida_liberada_wms.test.sql')), /CAJA C222 PASS/)
  console.log('PASS salida liberada por WMS: asignar permitido, salida bloqueada hasta liberar, corte, excepción con motivo, falla cerrada, fotos ordenadas, recojo/traslado sin cambio, C222')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
