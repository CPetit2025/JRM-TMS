// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Detalle del despacho: hitos desde registros reales, conexión GPS solo con presencia confirmada, historial sin
// reconstruir desde el estado actual, eventos económicos solo con lectura económica y tolerancia a fuentes ausentes.
const assert = require('node:assert/strict')
const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const read = path => readFileSync(path, 'utf8')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
;(async () => {
 const db = new PGlite()
 try {
  await db.exec(read('scripts/fixtures/hhee-schema.sql'))
  await db.exec(read('scripts/fixtures/route-operations-schema.sql'))
  // Tipo producción: dispatches sin returned_at/tercero_salida_at/modalidad, actual_distance_km con DEFAULT 0;
  // dispatch_events sin user_id; sin la tabla vehicle_incidents.
  await db.exec(`ALTER TABLE dispatches ADD COLUMN estimated_distance_km numeric NOT NULL DEFAULT 0, ADD COLUMN last_gps_at timestamptz;
   CREATE TABLE kpi_dispatch_log(id bigint GENERATED ALWAYS AS IDENTITY,dispatch_id uuid NOT NULL,estado_anterior text,estado_nuevo text NOT NULL,at timestamptz NOT NULL DEFAULT now(),by uuid,origen text DEFAULT 'SISTEMA');
   CREATE TABLE delivery_conformities(dispatch_id uuid,request_id uuid,state text DEFAULT 'PENDIENTE',arrived_at timestamptz,current_submission_id uuid,PRIMARY KEY(dispatch_id,request_id));
   CREATE TABLE delivery_submissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),dispatch_id uuid,request_id uuid,photos text[],guide_number text,received_by text,source text,submitted_by uuid,captured_at timestamptz,submitted_at timestamptz DEFAULT now());
   CREATE TABLE delivery_reviews(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),submission_id uuid,decision text,reason text,reviewed_by uuid,reviewed_at timestamptz DEFAULT now());
   CREATE TABLE delivery_rejections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),dispatch_id uuid,request_id uuid,kind text,reason_code text,note text,photos text[],captured_at timestamptz,created_by uuid,decision text,decision_reason text,decided_by uuid,decided_at timestamptz);
   CREATE TABLE transport_request_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),request_id uuid,actor_id uuid,action text,previous_state jsonb,next_state jsonb,created_at timestamptz DEFAULT now());
   CREATE TABLE documentary_closure_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),dispatch_id uuid,request_id uuid,action text,previous_status text,new_status text,reason text,actor_id uuid,created_at timestamptz DEFAULT now());
   CREATE TABLE dispatch_documents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),dispatch_id uuid,transport_request_id uuid,doc_type text,document_number text,uploaded_by uuid,uploaded_at timestamptz DEFAULT now(),voided_at timestamptz,voided_by uuid,void_reason text);
   CREATE TABLE economic_closure_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),dispatch_id uuid,action text,from_status text,to_status text,reason text,created_by uuid,created_at timestamptz DEFAULT now());
   CREATE TABLE service_cost_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),service_kind text,dispatch_id uuid,transport_request_id uuid,concept text,stage text,old_amount numeric,new_amount numeric,old_status text,new_status text,reason text,created_by uuid,created_at timestamptz DEFAULT now());
   CREATE TABLE driver_app_presence(driver_id uuid PRIMARY KEY,profile_id uuid,last_seen_at timestamptz,disconnected_at timestamptz,gps_state text);
   CREATE FUNCTION economic_can_read() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT has_tms_read_permission('cierre-economico') OR has_tms_read_permission('despacho')$$;`)
  const migration = read('supabase/migrations/20261120100000_detalle_despacho.sql')
  assert.doesNotMatch(migration, /UPDATE public\.(dispatch_request_freight|transport_requests) /i, 'never updates guarded tables')
  assert.doesNotMatch(migration, /^\s*(UPDATE|INSERT|DELETE) /im, 'read-only migration')
  await db.exec(migration); await db.exec(migration)
  await db.exec(`INSERT INTO roles(id,name,permissions) VALUES('${id(92)}','Torre','["torre-control"]'),('${id(94)}','Despacho','["despacho","torre-control"]'),('${id(96)}','Otro','["caja"]');
   INSERT INTO profiles(id,role_id,first_name,last_name) VALUES('${id(93)}','${id(92)}','Ana','Torre'),('${id(95)}','${id(94)}','Luis','Despacho'),('${id(97)}','${id(96)}','Sin','Acceso');
   INSERT INTO auth.users VALUES('${id(93)}'),('${id(95)}'),('${id(97)}');
   INSERT INTO user_site_access(user_id,site_id) SELECT u,primary_site_id() FROM unnest(ARRAY['${id(93)}','${id(95)}','${id(97)}']::uuid[]) u;
   INSERT INTO drivers(id,first_name,last_name,document_number) VALUES('${id(40)}','Ivan','Salazar','45832165');
   INSERT INTO transport_requests(id) VALUES('${id(30)}'),('${id(31)}'),('${id(32)}');
   INSERT INTO dispatches(id,dispatch_number,driver_id,vehicle_plate,status,scheduled_departure,site_id,estimated_distance_km,last_gps_at)
    VALUES('${id(70)}','10103','${id(40)}','BDK791','EN RUTA','2026-10-30T21:00:00Z',primary_site_id(),72,'2026-10-30T22:52:00Z'),
          ('${id(71)}','10104',NULL,'EXT-1','PROGRAMADO','2026-10-31T13:00:00Z',primary_site_id(),0,NULL);
   INSERT INTO dispatch_requests VALUES('${id(70)}','${id(30)}'),('${id(70)}','${id(31)}'),('${id(71)}','${id(32)}');
   INSERT INTO kpi_dispatch_log(dispatch_id,estado_anterior,estado_nuevo,at) VALUES('${id(70)}','PROGRAMADO','EN RUTA','2026-10-30T21:25:00Z');
   INSERT INTO delivery_conformities(dispatch_id,request_id,state,arrived_at) VALUES('${id(70)}','${id(30)}','RECIBIDA','2026-10-30T22:51:00Z'),('${id(70)}','${id(31)}','PENDIENTE',NULL);
   INSERT INTO delivery_submissions(id,dispatch_id,request_id,photos,guide_number,source,submitted_by,captured_at,submitted_at) VALUES('${id(80)}','${id(70)}','${id(30)}','{a.jpg}','T002-4165','APP','${id(95)}','2026-10-30T22:50:00Z','2026-10-30T22:52:00Z');
   INSERT INTO dispatch_events(dispatch_id,created_at,event_type,description,created_by) VALUES('${id(70)}','2026-10-30T22:40:00Z','RETRASO','Tráfico en Panamericana','Monitoreo');
   INSERT INTO transport_request_events(request_id,actor_id,action,previous_state,next_state,created_at) VALUES('${id(30)}','${id(95)}','STATUS_CHANGED','{"status":"PENDIENTE"}','{"status":"ASIGNADA"}','2026-10-29T23:30:00Z');
   INSERT INTO dispatch_documents(dispatch_id,transport_request_id,doc_type,document_number,uploaded_by,uploaded_at) VALUES('${id(70)}','${id(31)}','GUIA_REMISION','T001-9',NULL,'2026-10-30T20:00:00Z');
   INSERT INTO economic_closure_events(dispatch_id,action,from_status,to_status,created_by) VALUES('${id(70)}','ENVIAR','PENDIENTE','EN_REVISION','${id(95)}');
   INSERT INTO driver_app_presence(driver_id,last_seen_at,gps_state) VALUES('${id(40)}',now()-interval '20 minutes','active');`)
  const as = u => db.exec(`SELECT set_config('request.jwt.claim.sub','${id(u)}',false)`)
  const detail = async (d, r) => (await db.query(`SELECT get_dispatch_detail($1,$2) AS v`, [d, r])).rows[0].v

  await as(93)
  let v = await detail(id(70), id(30))
  assert.deepEqual(v.sources_failed, ['vehicle_incidents'], 'missing production table is reported, not fatal')
  assert.equal(v.dispatch.number, '10103'); assert.equal(Number(v.dispatch.estimated_distance_km), 72); assert.equal(v.dispatch.services_count, 2)
  assert.equal(v.dispatch.driver.document_number, '45832165')
  assert.equal(new Date(v.milestones.salida).toISOString(), '2026-10-30T21:25:00.000Z', 'departure from the state log')
  assert.equal(new Date(v.milestones.llegada).toISOString(), '2026-10-30T22:51:00.000Z')
  assert.equal(v.milestones.conformidad, null, 'received guide is not a conformity')
  assert.equal(v.milestones.retorno, null); assert.equal(v.milestones.cierre, null)
  assert.equal(v.presence.applies, true); assert.equal(v.presence.connected, false, 'stale presence is never online')
  const types = v.events.map(e => e.type)
  for (const t of ['RETRASO', 'SOLICITUD_STATUS_CHANGED', 'GUIA_RECIBIDA', 'LLEGADA_DESTINO']) assert.ok(types.includes(t), t)
  assert.ok(!types.includes('DOCUMENTO_REGISTRADO'), 'another stop documents stay out')
  assert.ok(!types.includes('ECONOMICO_ENVIAR'), 'economic events need economic read')
  assert.equal(v.events.find(e => e.type === 'RETRASO').level, 'INCIDENCIA')
  assert.equal(v.events.find(e => e.type === 'SOLICITUD_STATUS_CHANGED').actor, 'Luis Despacho')
  assert.ok(v.events.every((e, i, all) => i === 0 || Date.parse(all[i - 1].at) >= Date.parse(e.at)), 'newest first')

  await db.exec(`INSERT INTO delivery_reviews(submission_id,decision,reviewed_by,reviewed_at) VALUES('${id(80)}','VALIDADA','${id(95)}','2026-10-30T23:10:00Z');
   UPDATE driver_app_presence SET last_seen_at=now();
   INSERT INTO kpi_dispatch_log(dispatch_id,estado_anterior,estado_nuevo,at) VALUES('${id(70)}','EN RUTA','CIERRE_OPERATIVO','2026-10-31T01:00:00Z');`)
  await as(95)
  v = await detail(id(70), id(30))
  assert.equal(v.milestones.conformidad.decision, 'VALIDADA'); assert.equal(v.milestones.conformidad.by, 'Luis Despacho')
  assert.equal(v.milestones.cierre_estado, 'CIERRE_OPERATIVO')
  assert.equal(v.presence.connected, true, 'recent presence is online')
  assert.ok(v.events.some(e => e.type === 'ECONOMICO_ENVIAR' && e.scope === 'RUTA'), 'economic read sees route economic events')

  v = await detail(id(71), id(32))
  assert.equal(v.presence.applies, false, 'no driver: GPS does not apply'); assert.equal(v.dispatch.estimated_distance_km, null, 'default 0 means no data')
  await assert.rejects(detail(id(70), id(32)), /no pertenece/)
  await as(97)
  await assert.rejects(detail(id(70), id(30)), /Sin permiso/)
  const grants = (await db.query(`SELECT has_function_privilege('anon','public.get_dispatch_detail(uuid,uuid)','EXECUTE') OR has_function_privilege('authenticated','public.dispatch_detail_payload(uuid,uuid,boolean)','EXECUTE') AS open`)).rows[0]
  assert.equal(grants.open, false, 'no anonymous access and no direct access to the internal payload')

  // Documentos y evidencias: archivos de la parada y de la ruta (no de otra parada), revisión de la guía, rechazo y
  // cierre documentario sin sincronizar; sin permiso de documentos no se listan archivos.
  const files = read('supabase/migrations/20261120110000_detalle_despacho_archivos.sql')
  assert.doesNotMatch(files, /^\s*(UPDATE|INSERT|DELETE) /im, 'read-only migration')
  await db.exec(`CREATE TABLE dispatch_document_references(dispatch_id uuid,request_id uuid,doc_type text,document_number text,created_by uuid,created_at timestamptz DEFAULT now());
   CREATE TABLE documentary_closures(dispatch_id uuid,request_id uuid,status text,source text,missing jsonb DEFAULT '[]',completed_at timestamptz,completed_by uuid,reopened_at timestamptz,updated_at timestamptz DEFAULT now());
   CREATE FUNCTION can_view_dispatch_documents(p uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT has_tms_read_permission('despacho')$$;
   ALTER TABLE dispatch_documents ADD COLUMN file_path text, ADD COLUMN file_name text, ADD COLUMN mime_type text, ADD COLUMN size_bytes bigint;
   UPDATE dispatch_documents SET file_path='d70/gr.pdf',mime_type='application/pdf',size_bytes=2048;
   INSERT INTO dispatch_documents(dispatch_id,transport_request_id,doc_type,document_number,file_path,uploaded_by,uploaded_at) VALUES('${id(70)}',NULL,'PACKING_LIST',NULL,'d70/pl.pdf','${id(95)}','2026-10-30T19:00:00Z'),
    ('${id(70)}','${id(30)}','OTRO',NULL,'d70/old.pdf','${id(95)}','2026-10-30T19:30:00Z');
   UPDATE dispatch_documents SET voided_at=now() WHERE file_path='d70/old.pdf';
   INSERT INTO dispatch_document_references VALUES('${id(70)}','${id(30)}','GR','T001-77','${id(95)}','2026-10-30T20:10:00Z');
   INSERT INTO documentary_closures(dispatch_id,request_id,status,missing) VALUES('${id(70)}','${id(30)}','EN_VALIDACION','["CONFORMIDAD"]');
   INSERT INTO delivery_rejections(dispatch_id,request_id,kind,reason_code,photos,captured_at) VALUES('${id(70)}','${id(30)}','PARCIAL','MERCADERIA_DANADA','{r.jpg}','2026-10-30T22:55:00Z');`)
  await db.exec(files); await db.exec(files)
  await as(95)
  const filesOf = async (d, r) => (await db.query(`SELECT get_dispatch_detail_files($1,$2) AS v`, [d, r])).rows[0].v
  let f = await filesOf(id(70), id(30))
  assert.deepEqual(f.sources_failed, [])
  assert.deepEqual(f.documents.map(x => x.doc_type), ['PACKING_LIST'], 'route documents only; other stop and voided files excluded')
  assert.equal(f.documents[0].scope, 'RUTA'); assert.equal(f.documents[0].uploaded_by, 'Luis Despacho')
  assert.equal(f.references[0].number, 'T001-77')
  assert.equal(f.documentary.status, 'EN_VALIDACION'); assert.deepEqual(f.documentary.missing, ['CONFORMIDAD'])
  assert.equal(f.submissions[0].guide_number, 'T002-4165'); assert.deepEqual(f.submissions[0].packing_photos, [], 'missing packing column reads as empty')
  assert.equal(f.submissions[0].review.decision, 'VALIDADA'); assert.deepEqual(f.rejection.photos, ['r.jpg'])
  assert.equal((await db.query(`SELECT status FROM documentary_closures`)).rows[0].status, 'EN_VALIDACION', 'reading never syncs or closes')
  f = await filesOf(id(70), id(31))
  assert.deepEqual(f.documents.map(x => x.doc_type).sort(), ['GUIA_REMISION', 'PACKING_LIST'])
  await as(93)
  f = await filesOf(id(70), id(30))
  assert.equal(f.can_view_documents, false); assert.deepEqual(f.documents, [], 'no document files without document access')
  await as(97)
  await assert.rejects(filesOf(id(70), id(30)), /Sin permiso/)
  await assert.rejects(db.exec(read('supabase/tests/caja_c192_detalle_despacho_archivos.test.sql')), /CAJA C192 PASS/)
  await db.exec('ROLLBACK').catch(() => {})

  await assert.rejects(db.exec(read('supabase/tests/caja_c191_detalle_despacho.test.sql')), /CAJA C191 FAIL: fuentes no legibles en producción: \["vehicle_incidents"\]/)
  await db.exec('ROLLBACK').catch(() => {})
  await db.exec(`CREATE TABLE vehicle_incidents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),incident_type text,severity text,dispatch_id uuid,occurred_at timestamptz,location text,description text,created_by uuid)`)
  await assert.rejects(db.exec(read('supabase/tests/caja_c191_detalle_despacho.test.sql')), /CAJA C191 PASS/)
  await db.exec('ROLLBACK').catch(() => {})

  // Evidencias operativas con etapa y estimado OSRM: solo quien opera la ruta registra, en su carpeta y con el archivo
  // ya cargado; anular exige motivo y no borra; el estimado solo lo guarda Despacho y solo para solicitudes de la ruta.
  const extras = read('supabase/migrations/20261122090000_detalle_despacho_evidencias_estimados.sql')
  assert.doesNotMatch(extras, /UPDATE public\.(dispatch_request_freight|transport_requests) /i, 'never updates guarded tables')
  await db.exec(`CREATE SCHEMA storage; CREATE TABLE storage.objects(bucket_id text, name text);
   ALTER TABLE documentary_closures ADD COLUMN service_kind text; UPDATE documentary_closures SET service_kind='RECOJO';
   CREATE FUNCTION dispatch_document_folder(p_name text) RETURNS uuid LANGUAGE plpgsql IMMUTABLE AS $$BEGIN RETURN split_part(p_name,'/',1)::uuid; EXCEPTION WHEN others THEN RETURN NULL; END$$;
   CREATE FUNCTION can_operate_dispatch(s uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT (has_tms_permission('despacho') OR has_tms_permission('torre-control')) AND (s IS NULL OR can_access_site(s))$$;`)
  await db.exec(extras); await db.exec(extras)
  const call = async (sql, args) => (await db.query(sql, args)).rows[0].v
  const register = (path, stage = 'RECOJO', request = id(30)) => call(`SELECT register_dispatch_evidence($1,$2,$3,$4,'f.jpg','image/jpeg',1200000,'Unidad en punto de recojo') AS v`, [id(70), request, stage, path])
  await as(93)
  const mine = `${id(70)}/evidencia/${id(93)}/1.jpg`
  assert.match((await register(mine)).error, /no se cargó/, 'file must exist in storage first')
  await db.query(`INSERT INTO storage.objects VALUES('dispatch_documents',$1),('dispatch_documents',$2)`, [mine, `${id(70)}/evidencia/${id(95)}/x.jpg`])
  assert.match((await register(mine, 'VUELO')).error, /Etapa inválida/)
  assert.match((await register(`${id(70)}/evidencia/${id(95)}/x.jpg`)).error, /Archivo inválido/, 'only the own folder')
  assert.match((await register(mine, 'RECOJO', id(32))).error, /no pertenece/)
  const ok = await register(mine); assert.equal(ok.success, true)
  assert.match((await register(mine)).error, /ya está registrada/)
  let f2 = await filesOf(id(70), id(30))
  assert.equal(f2.evidence.length, 1); assert.equal(f2.evidence[0].stage, 'RECOJO'); assert.equal(f2.evidence[0].size_bytes, 1200000)
  assert.equal(f2.evidence[0].uploaded_by, 'Ana Torre'); assert.equal(f2.evidence[0].can_void, true); assert.equal(f2.can_add_evidence, true); assert.equal(f2.service_kind, 'RECOJO')
  assert.match((await call(`SELECT void_dispatch_evidence($1,'corto') AS v`, [ok.id])).error, /motivo/)
  await as(97)
  assert.match((await register(mine)).error, /Sin permiso/)
  assert.match((await call(`SELECT void_dispatch_evidence($1,'Foto de otra unidad por error') AS v`, [ok.id])).error, /Sin permiso/)
  await as(93)
  assert.equal((await call(`SELECT void_dispatch_evidence($1,'Foto de otra unidad por error') AS v`, [ok.id])).success, true)
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM dispatch_evidence WHERE voided_at IS NOT NULL`)).rows[0].n, 1, 'voided, never deleted')
  assert.deepEqual((await filesOf(id(70), id(30))).evidence, [])
  const items = JSON.stringify([{ request_id: id(30), distance_km: 72, duration_min: 110, origin: { lat: -12.09, lon: -76.87 }, destination: { lat: -12.52, lon: -76.73 }, geometry: [[-12.09, -76.87], [-12.52, -76.73]] }, { request_id: id(32), distance_km: 5 }])
  assert.match((await call(`SELECT save_dispatch_route_estimates($1,$2::jsonb) AS v`, [id(70), items])).error, /Sin permiso/, 'only Despacho saves estimates')
  await as(95)
  assert.equal((await call(`SELECT save_dispatch_route_estimates($1,$2::jsonb) AS v`, [id(70), items])).saved, 1, 'other route requests are ignored')
  v = await detail(id(70), id(30))
  assert.equal(Number(v.estimate.duration_min), 110); assert.equal(v.estimate.geometry.length, 2); assert.deepEqual(v.sources_failed, [])
  assert.equal((await detail(id(70), id(31))).estimate, null, 'no estimate is invented for other stops')
  // Mismo criterio que C55: toda FK de las tablas nuevas cubierta por un índice
  await db.exec(read('supabase/migrations/20261122100000_detalle_despacho_indices_fk.sql'))
  const uncovered = (await db.query(`SELECT c.conname FROM pg_constraint c WHERE c.contype='f' AND c.conrelid IN ('dispatch_evidence'::regclass,'dispatch_route_estimates'::regclass)
    AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.conrelid AND i.indisvalid AND i.indpred IS NULL AND (i.indkey::smallint[])[0:cardinality(c.conkey)-1] @> c.conkey)`)).rows
  assert.deepEqual(uncovered, [], 'every foreign key has a covering index')
  await assert.rejects(db.exec(read('supabase/tests/caja_c194_detalle_evidencias_estimados.test.sql')), /CAJA C194 (PASS|FAIL: faltan las políticas)/)
  await db.exec('ROLLBACK').catch(() => {})
  console.log('PASS detalle del despacho: hitos reales, GPS confirmado, historial por parada, permisos y fuentes ausentes informadas')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
