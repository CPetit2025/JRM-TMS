// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Hallazgos de auditoría (F1): numeración, OT por búsqueda, flujo registro → asignación → corrección → validación → cierre,
// rechazo con historial, foto de subsanación obligatoria, evidencias sin borrado, separación de funciones, sede y notificaciones.
const assert = require('node:assert/strict')
const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const read = p => readFileSync(p, 'utf8')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function fn(file, name) {
 const s = read(file), a = s.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
 assert(a >= 0, name)
 return s.slice(a, s.indexOf('END $$;', a) + 7)
}
;(async () => {
 const db = new PGlite()
 try {
  await db.exec(read('scripts/fixtures/hhee-schema.sql'))
  await db.exec(read('scripts/fixtures/route-operations-schema.sql'))
  // Tipo producción: OT con cliente y sede, clientes, solicitud con dirección, Storage y la política vigente de avisos.
  await db.exec(`ALTER TABLE contracts ADD COLUMN client_id uuid, ADD COLUMN site_id uuid;
   CREATE TABLE clients(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_name text);
   ALTER TABLE transport_requests ADD COLUMN request_number text, ADD COLUMN delivery_address text, ADD COLUMN delivery_district text;
   CREATE SCHEMA storage;
   CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
   CREATE TABLE storage.objects(bucket_id text, name text, metadata jsonb, PRIMARY KEY(bucket_id, name));
   ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
   CREATE UNIQUE INDEX dispatch_one_active_driver ON dispatches(driver_id) WHERE driver_id IS NOT NULL AND status='PROGRAMADO';
   CREATE UNIQUE INDEX dispatch_one_active_vehicle ON dispatches(vehicle_plate) WHERE status='PROGRAMADO';
   CREATE FUNCTION public.notif_can_see(p text[], t uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
   CREATE FUNCTION public.notif_can_see_event(p_evento text,p_permisos text[],p_target uuid)
   RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $f$
BEGIN
 IF p_evento='FALLA_ASIGNADA' THEN RETURN COALESCE(p_target=auth.uid(),false); END IF;
 RETURN COALESCE(public.notif_can_see(p_permisos,p_target),false);
END $f$;`)
  await db.exec(fn('supabase/migrations/20261004120000_notificaciones_por_rol.sql', 'notif_emit'))

  const migration = read('supabase/migrations/20261226090000_hallazgos_auditoria.sql')
  assert.doesNotMatch(migration, /UPDATE public\.(dispatch_request_freight|transport_requests|dispatches|contracts) /i, 'never updates existing business tables')
  await db.exec(migration); await db.exec(migration) // reaplicable

  // Personas: auditor (sede principal), responsable (solo lectura), validador, otro auditor de otra sede, conductor.
  const site2 = id(900)
  await db.exec(`INSERT INTO sites(id,code,name) VALUES('${site2}','NORTE','Norte');
   INSERT INTO roles(id,name,permissions) VALUES
    ('${id(201)}','Auditor de Despacho','["planificacion:read","packing-list:write","solo-documentos"]'),
    ('${id(202)}','Supervisor de Transporte','["despacho:write"]'),
    ('${id(203)}','Jefe de Distribución','[]'),
    ('${id(204)}','Conductor','[]'),
    ('${id(205)}','Supervisor de Despacho','[]');
   INSERT INTO profiles(id,role_id,first_name,last_name) VALUES
    ('${id(11)}','${id(201)}','Ana','Auditora'),('${id(12)}','${id(202)}','Rubén','Responsable'),
    ('${id(13)}','${id(203)}','Jefa','Distribución'),('${id(14)}','${id(204)}','Carlos','Conductor'),
    ('${id(15)}','${id(201)}','Otro','Auditor'),('${id(16)}','${id(205)}','Sara','Supervisora');
   INSERT INTO user_site_access(user_id,site_id) SELECT u,primary_site_id() FROM unnest(ARRAY['${id(11)}','${id(12)}','${id(13)}','${id(14)}','${id(16)}']::uuid[]) u;
   INSERT INTO user_site_access VALUES('${id(15)}','${site2}');`)
  // La migración da los permisos a los roles base (se vuelve a aplicar para los roles creados después).
  await db.exec(migration)
  const perms = async name => (await db.query(`SELECT permissions FROM roles WHERE name=$1`, [name])).rows[0].permissions
  assert.ok((await perms('Auditor de Despacho')).includes('hallazgos-validar'))
  assert.ok((await perms('Jefe de Distribución')).includes('hallazgos-excepcion'))
  assert.ok((await perms('Supervisor de Transporte')).includes('hallazgos:read'))
  assert.equal((await perms('Conductor')).length, 0)
  assert.equal((await perms('Auditor de Despacho')).filter(p => p === 'hallazgos:write').length, 1, 'idempotent role update')

  await db.exec(`INSERT INTO clients(id,business_name) VALUES('${id(30)}','Minera Andina');
   INSERT INTO contracts(id,code,client_id,site_id) VALUES('${id(20)}','2451','${id(30)}',primary_site_id()),('${id(21)}','2452','${id(30)}',primary_site_id()),
    ('${id(22)}','9001',NULL,'${site2}');
   INSERT INTO transport_requests(id,contract_id,request_number,delivery_address,delivery_district) VALUES
    ('${id(40)}','${id(20)}','S-1','Av. Minera 100','Arequipa'),('${id(41)}','${id(21)}','S-2','Calle 2','Lima');
   INSERT INTO dispatches(id,dispatch_number,status,site_id,vehicle_plate) VALUES('${id(50)}','R-0050','PROGRAMADO',primary_site_id(),'ABC-1'),
    ('${id(51)}','R-0051','CERRADO',primary_site_id(),'ABC-2');
   INSERT INTO dispatch_requests VALUES('${id(50)}','${id(40)}'),('${id(50)}','${id(41)}'),('${id(51)}','${id(40)}');`)

  const as = u => db.exec(`SELECT set_config('request.jwt.claim.sub','${id(u)}',false)`)
  const rpc = async (sql, params = []) => (await db.query(`SELECT ${sql} AS v`, params)).rows[0].v
  const cat = async code => (await db.query(`SELECT id FROM audit_finding_categories WHERE code=$1`, [code])).rows[0].id

  // OT por búsqueda: código o cliente; despachos activos de la OT con su parada y destino. El conductor no busca.
  await as(11)
  const found = await rpc(`audit_finding_search_ot('245')`)
  assert.deepEqual(found.map(x => x.ot_code), ['2451', '2452'])
  assert.equal(found[0].client_name, 'Minera Andina')
  assert.deepEqual(found[0].dispatches.map(d => d.dispatch_number), ['R-0050'], 'closed routes are not offered')
  assert.equal(found[0].dispatches[0].destination, 'Av. Minera 100 · Arequipa')
  assert.equal((await rpc(`audit_finding_search_ot('minera')`)).length, 2)
  assert.equal((await rpc(`audit_finding_search_ot('9001')`)).length, 0, 'other site OT is not visible')
  await as(14); assert.equal((await rpc(`audit_finding_search_ot('2451')`)).length, 0)

  // Registro: número autogenerado, cliente y destino de la OT, auditor autenticado, varias categorías.
  await as(11)
  const base = { contract_id: id(20), dispatch_id: id(50), transport_request_id: id(40), process_area: 'Carga en almacén', severity: 'CRITICO',
   category_ids: [await cat('MATERIAL_FALTANTE'), await cat('PACKING_LIST')], description: 'Faltan 4 cajas de pernos', material_code: 'P-100', quantity: 4, unit: 'CJ', location: 'Muelle 3' }
  const created = await rpc(`audit_finding_create($1)`, [base])
  assert.equal(created.success, true, created.error)
  assert.match(created.number, /^HAL-\d{4}-00001$/)
  const second = await rpc(`audit_finding_create($1)`, [{ ...base, severity: 'MENOR', transport_request_id: id(41), contract_id: id(21) }])
  assert.match(second.number, /-00002$/, 'one OT/route can carry several findings, each with its own number')
  const f1 = created.id
  let row = (await db.query(`SELECT * FROM audit_findings WHERE id=$1`, [f1])).rows[0]
  assert.equal(row.auditor_id, id(11)); assert.equal(row.client_name, 'Minera Andina'); assert.equal(row.destination, 'Av. Minera 100 · Arequipa')
  assert.equal(row.ot_code, '2451'); assert.equal(row.status, 'ABIERTO')
  assert.equal(Number(await rpc(`(SELECT count(*) FROM audit_finding_category_links WHERE finding_id=$1)`, [f1])), 2)
  // Validaciones de entrada
  assert.match((await rpc(`audit_finding_create($1)`, [{ ...base, contract_id: null }])).error, /OT/)
  assert.match((await rpc(`audit_finding_create($1)`, [{ ...base, contract_id: id(21), transport_request_id: id(40) }])).error, /no pertenecen/)
  assert.match((await rpc(`audit_finding_create($1)`, [{ ...base, category_ids: [] }])).error, /tipo de hallazgo/)
  assert.match((await rpc(`audit_finding_create($1)`, [{ ...base, severity: 'GRAVE' }])).error, /criticidad/)
  await as(15); assert.equal((await rpc(`audit_finding_create($1)`, [base])).success, false, 'auditor of another site cannot register')
  await as(12); assert.equal((await rpc(`audit_finding_create($1)`, [base])).success, false, 'read-only user cannot register')

  // Sin escritura directa en tablas (rol authenticated) ni borrado de evidencias.
  await db.exec(`SET ROLE authenticated`)
  for (const sql of [`INSERT INTO audit_findings(number,contract_id,process_area,auditor_id,severity,description) VALUES('X','${id(20)}','a','${id(11)}','MENOR','xxxxx')`,
   `UPDATE audit_findings SET status='CERRADO'`, `DELETE FROM audit_finding_evidence`, `DELETE FROM audit_finding_events`])
   await assert.rejects(db.exec(sql), /permission denied/)
  await db.exec(`RESET ROLE`)

  // Fotos ANTES: ruta del contrato; el archivo debe existir; tipos y tamaño. El responsable no sube ANTES.
  const obj = (phase, user, n) => `${f1}/${phase}/${id(user)}/${id(n)}.jpg`
  await db.exec(`INSERT INTO storage.objects VALUES('audit_findings','${obj('ANTES', 11, 1)}','{}'),('audit_findings','${obj('ANTES', 12, 2)}','{}'),
   ('audit_findings','${obj('DESPUES', 12, 3)}','{}'),('audit_findings','${obj('DESPUES', 12, 4)}','{}')`)
  await as(11)
  const ev1 = await rpc(`audit_finding_add_evidence($1,'ANTES',$2,'Muelle con faltante','image/jpeg',250000)`, [f1, obj('ANTES', 11, 1)])
  assert.equal(ev1.success, true, ev1.error)
  assert.equal((await rpc(`audit_finding_add_evidence($1,'ANTES',$2,'x','image/jpeg',250000)`, [f1, obj('ANTES', 11, 1)])).duplicate, true)
  assert.equal((await rpc(`audit_finding_add_evidence($1,'ANTES',$2,'x','image/jpeg',250000)`, [f1, `${f1}/ANTES/${id(11)}/no-existe.jpg`])).success, false)
  assert.equal((await rpc(`audit_finding_add_evidence($1,'ANTES',$2,'x','application/pdf',250000)`, [f1, obj('ANTES', 11, 1).replace('01.jpg', '09.jpg')])).success, false)
  assert.equal((await rpc(`audit_finding_add_evidence($1,'DESPUES',$2,'x','image/jpeg',100)`, [f1, obj('DESPUES', 12, 3)])).success, false, 'path of another user')
  await as(12)
  assert.equal((await rpc(`audit_finding_add_evidence($1,'ANTES',$2,'x','image/jpeg',100)`, [f1, obj('ANTES', 12, 2)])).success, false, 'responsible does not upload ANTES')
  assert.equal(await rpc(`audit_finding_object_readable($1)`, [obj('ANTES', 11, 1)]), true, 'read permission of the site reads registered evidence')

  // Edición solo en Abierto; asignación con notificación al responsable.
  await as(11)
  assert.equal((await rpc(`audit_finding_update($1,$2)`, [f1, { ...base, description: 'Faltan 4 cajas de pernos M12' }])).success, true)
  assert.match((await rpc(`audit_finding_assign($1,$2,'Almacén','2000-01-01','Reponer')`, [f1, id(12)])).error, /anterior/)
  assert.match((await rpc(`audit_finding_assign($1,$2,'Almacén','2099-01-01','Reponer')`, [f1, id(14)])).error, /acceso a Hallazgos/, 'driver cannot be responsible')
  const assigned = await rpc(`audit_finding_assign($1,$2,'Almacén',(now()::date+1),'Reponer las 4 cajas y corregir el packing')`, [f1, id(12)])
  assert.equal(assigned.status, 'EN_CORRECCION', assigned.error)
  assert.equal((await rpc(`audit_finding_update($1,$2)`, [f1, base])).success, false, 'no editing once in correction')
  const notif = (await db.query(`SELECT * FROM notifications WHERE evento='HALLAZGO_ASIGNADO'`)).rows
  assert.equal(notif.length, 1); assert.equal(notif[0].target_user, id(12)); assert.match(notif[0].link, new RegExp(f1))
  assert.match(await rpc(`pg_get_functiondef('notif_can_see_event(text,text[],uuid)'::regprocedure)`), /HALLAZGO_ASIGNADO/)
  await as(16); assert.equal(await rpc(`notif_can_see_event('HALLAZGO_ASIGNADO','{}',$1)`, [id(12)]), false, 'personal notice only for the responsible')
  await as(12); assert.equal(await rpc(`notif_can_see_event('HALLAZGO_ASIGNADO','{}',$1)`, [id(12)]), true)

  // El responsable ve su hallazgo, corrige, pero no valida ni cierra. Validador tampoco valida su propia corrección.
  await as(12)
  let detail = await rpc(`audit_finding_detail($1)`, [f1])
  assert.equal(detail.success, true); assert.equal(detail.finding.can_correct, true); assert.equal(detail.finding.can_validate, false)
  assert.equal(detail.finding.auditor_name, 'Ana Auditora')
  assert.equal((await rpc(`audit_finding_add_evidence($1,'DESPUES',$2,'Cajas repuestas','image/jpeg',300000)`, [f1, obj('DESPUES', 12, 3)])).success, true)
  assert.equal((await rpc(`audit_finding_submit_correction($1,'Se repusieron las cajas',now(),'Sin novedades')`, [f1])).status, 'PENDIENTE_VALIDACION')
  assert.equal((await rpc(`audit_finding_validate($1,'CONFORME','ok')`, [f1])).success, false, 'responsible cannot close')
  assert.equal((await rpc(`audit_finding_add_evidence($1,'DESPUES',$2,'x','image/jpeg',100)`, [f1, obj('DESPUES', 12, 4)])).success, false, 'no uploads while pending validation')
  // Rechazo: vuelve a En corrección, conserva la ronda y notifica.
  await as(11)
  assert.match((await rpc(`audit_finding_validate($1,'RECHAZADO','')`, [f1])).error, /por qué/)
  assert.equal((await rpc(`audit_finding_validate($1,'RECHAZADO','Falta corregir el packing list')`, [f1])).status, 'EN_CORRECCION')
  assert.equal((await db.query(`SELECT * FROM notifications WHERE evento='HALLAZGO_RECHAZADO'`)).rows[0].target_user, id(12))
  // Segunda ronda sin foto: el cierre exige foto de subsanación o motivo.
  await as(12)
  assert.equal((await rpc(`audit_finding_submit_correction($1,'Packing list reemitido',now(),NULL)`, [f1])).round, 2)
  await as(11)
  assert.match((await rpc(`audit_finding_validate($1,'CONFORME','Conforme')`, [f1])).error, /foto de subsanación/)
  const closed = await rpc(`audit_finding_validate($1,'CONFORME','Conforme',$2)`, [f1, 'Corrección documental, sin evidencia física'])
  assert.equal(closed.status, 'CERRADO', closed.error)
  detail = await rpc(`audit_finding_detail($1)`, [f1])
  assert.deepEqual(detail.corrections.map(c => [c.round, c.result]), [[1, 'RECHAZADO'], [2, 'CONFORME']], 'full history is kept')
  assert.equal(detail.evidence.find(e => e.phase === 'DESPUES').correction_id, detail.corrections[0].id)
  assert.deepEqual(detail.events.map(e => e.event_type), ['REGISTRADO', 'EVIDENCIA_AGREGADA', 'EDITADO', 'ASIGNADO', 'EVIDENCIA_AGREGADA',
   'CORRECCION_REGISTRADA', 'VALIDADO_RECHAZADO', 'CORRECCION_REGISTRADA', 'VALIDADO_CONFORME'])
  assert.equal(await rpc(`audit_finding_object_readable($1)`, [obj('DESPUES', 12, 3)]), true)

  // Un validador no valida la corrección que él mismo registró.
  const f2 = second.id
  await as(11); await rpc(`audit_finding_assign($1,$2,'Despacho',(now()::date+2),'Revisar')`, [f2, id(16)])
  await as(16); await rpc(`audit_finding_submit_correction($1,'Revisado',now(),NULL)`, [f2])
  assert.match((await rpc(`audit_finding_validate($1,'RECHAZADO','no conforme')`, [f2])).error, /no puede validarla/)

  // Anulación de evidencia con motivo y trazabilidad; corrección de fecha solo con autorización.
  await as(12); assert.equal((await rpc(`audit_finding_void_evidence($1,'Foto equivocada del muelle')`, [ev1.id])).success, false)
  await as(11)
  assert.match((await rpc(`audit_finding_void_evidence($1,'corta')`, [ev1.id])).error, /motivo/)
  assert.equal((await rpc(`audit_finding_void_evidence($1,'Foto equivocada del muelle')`, [ev1.id])).success, true)
  assert.ok(await rpc(`(SELECT voided_at IS NOT NULL FROM audit_finding_evidence WHERE id=$1)`, [ev1.id]))
  assert.match((await rpc(`audit_finding_fix_date($1,now()+interval '1 day','Registro tardío en campo')`, [f1])).error, /futura/)
  assert.equal((await rpc(`audit_finding_fix_date($1,now()-interval '2 hours','Registro tardío en campo')`, [f1])).success, true)
  await as(12); assert.equal((await rpc(`audit_finding_fix_date($1,now()-interval '3 hours','Registro tardío en campo')`, [f1])).success, false)

  // Seguimiento: filtros e indicadores; el responsable solo ve lo suyo, otra sede no ve nada, el conductor tampoco.
  await as(11)
  let list = await rpc(`audit_finding_list($1)`, [{}])
  assert.equal(list.rows.length, 2)
  assert.deepEqual(list.kpis, { abiertos: 1, vencidos: 0, pendientes_validacion: 1, cerrados: 1 })
  assert.equal((await rpc(`audit_finding_list($1)`, [{ severity: 'CRITICO' }])).rows.length, 1)
  assert.equal((await rpc(`audit_finding_list($1)`, [{ status: 'CERRADO', contract_id: id(20) }])).rows[0].number, created.number)
  assert.deepEqual((await rpc(`audit_finding_list($1)`, [{ responsible_id: id(16) }])).rows[0].categories.sort(), ['Material faltante', 'Packing list inconsistente'])
  await db.exec(`UPDATE audit_findings SET due_date=now()::date-1 WHERE id='${f2}'`)
  assert.equal((await rpc(`audit_finding_list($1)`, [{ status: 'VENCIDO' }])).rows.length, 1)
  assert.equal((await rpc(`audit_finding_list($1)`, [{}])).kpis.vencidos, 1)
  await as(12); assert.deepEqual((await rpc(`audit_finding_list($1)`, [{}])).rows.map(r => r.id).sort(), [f1, f2].sort(), 'read permission sees the site')
  await as(15); assert.equal((await rpc(`audit_finding_list($1)`, [{}])).rows.length, 0)
  await as(14); assert.equal((await rpc(`audit_finding_list($1)`, [{}])).rows.length, 0)
  assert.equal((await rpc(`audit_finding_detail($1)`, [f1])).success, false)
  assert.equal(await rpc(`audit_finding_object_readable($1)`, [obj('DESPUES', 12, 3)]), false)

  // Usuarios asignables y categorías administrables (sin borrado).
  await as(11)
  const users = (await rpc(`audit_finding_assignable_users()`)).map(u => u.full_name)
  assert.ok(users.includes('Rubén Responsable')); assert.ok(!users.includes('Carlos Conductor'))
  assert.equal((await rpc(`audit_finding_save_category($1)`, [{ name: 'Nueva' }])).success, false)
  await as(13)
  const nc = await rpc(`audit_finding_save_category($1)`, [{ name: 'Temperatura fuera de rango' }])
  assert.equal(nc.success, true, nc.error)
  assert.equal((await rpc(`audit_finding_save_category($1)`, [{ id: nc.id, name: 'Temperatura fuera de rango', active: false }])).success, true)
  await as(11)
  assert.match((await rpc(`audit_finding_create($1)`, [{ ...base, category_ids: [nc.id] }])).error, /vigente/, 'inactive categories cannot be used')

  // Storage: subida solo a carpeta propia según fase y estado; limpieza solo de archivos propios sin registrar.
  await as(11)
  assert.equal(await rpc(`audit_finding_can_upload($1)`, [`${f2}/ANTES/${id(11)}/a.jpg`]), true)
  assert.equal(await rpc(`audit_finding_can_upload($1)`, [`${f1}/ANTES/${id(11)}/a.jpg`]), false, 'closed finding accepts no uploads')
  assert.equal(await rpc(`audit_finding_can_upload($1)`, [`${f2}/ANTES/${id(12)}/a.jpg`]), false)
  assert.equal(await rpc(`audit_finding_can_upload($1)`, [`no-uuid/ANTES/${id(11)}/a.jpg`]), false)
  assert.equal(await rpc(`audit_finding_object_unregistered($1)`, [obj('ANTES', 11, 1)]), false, 'registered evidence cannot be deleted')
  assert.equal(await rpc(`audit_finding_object_unregistered($1)`, [`${f2}/ANTES/${id(11)}/huerfano.jpg`]), true)
  assert.equal(Number(await rpc(`(SELECT count(*) FROM pg_policies WHERE tablename='objects' AND policyname LIKE 'audit_findings_obj_%')`)), 3)
  assert.equal(await rpc(`(SELECT public FROM storage.buckets WHERE id='audit_findings')`), false)

  await assert.rejects(db.exec(read('supabase/tests/caja_c219_hallazgos.test.sql')), /CAJA C219 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  console.log('PASS hallazgos F1: numeración, OT por búsqueda, flujo con rechazo e historial, foto de subsanación, evidencias sin borrado, separación de funciones, sede y avisos')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
