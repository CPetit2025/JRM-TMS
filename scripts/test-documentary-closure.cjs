// Etapa 5: cierre documentario persistido por servicio (20261106090000_documentary_closure.sql) sobre tablas con la
// forma de producción: estado automático por tipo de servicio, cierre manual y deshacer con historial, reapertura con y
// sin permiso, carga inicial idempotente, historial solo de inserción y triggers que no bloquean la operación.
const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const shape = readFileSync('scripts/security/production-shape.sql', 'utf8')
const table = name => { const start = shape.indexOf(`CREATE TABLE public."${name}" (`); assert.ok(start >= 0, name); return shape.slice(start, shape.indexOf(';', start) + 1) }
const fn = (path, name) => {
  const source = readFileSync(path, 'utf8'), start = source.search(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(`))
  assert.ok(start >= 0, name); const body = source.indexOf('$$', start); return source.slice(start, source.indexOf('$$;', body + 2) + 3)
}
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const D1 = id(1), D2 = id(2), D3 = id(3), D4 = id(4), D5 = id(5)
const [R1, R2, R3, R4, R5, R6, R7, R8, R9, R10] = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110].map(id)
const USER = id(50)

;(async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('test.user',true),'')::uuid$$;
      CREATE FUNCTION is_active_tms_user() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(current_setting('test.active',true),'true')='true'$$;
      CREATE FUNCTION has_tms_permission(text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(current_setting('test.read',true),'true')='true'$$;
      CREATE FUNCTION can_settle_manually() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(current_setting('test.manual',true),'true')='true'$$;
      CREATE FUNCTION can_access_site(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT $1 IS DISTINCT FROM '${id(9)}'::uuid$$;
      CREATE FUNCTION delivery_required(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
      CREATE FUNCTION delivery_rejection_reason_label(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT 'Cliente ausente'$$;
      ${['dispatches', 'dispatch_requests', 'transport_requests', 'delivery_conformities', 'delivery_submissions', 'dispatch_documents', 'profiles'].map(table).join('\n')}
      CREATE TABLE dispatch_document_references(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),dispatch_id uuid NOT NULL,request_id uuid NOT NULL,
        doc_type text NOT NULL,document_number text NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE delivery_rejections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),dispatch_id uuid NOT NULL,request_id uuid NOT NULL,kind text NOT NULL,
        reason_code text NOT NULL,note text,photos text[] NOT NULL,captured_at timestamptz NOT NULL DEFAULT now(),decision text,decision_reason text,decided_by uuid,decided_at timestamptz);
      CREATE TABLE settlement_manual_closures(dispatch_id uuid NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,request_id uuid NOT NULL REFERENCES transport_requests(id) ON DELETE CASCADE,
        reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500),missing jsonb NOT NULL DEFAULT '[]'::jsonb,closed_by uuid,closed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (dispatch_id,request_id));
      CREATE UNIQUE INDEX dispatch_one_active_driver ON dispatches(driver_id) WHERE driver_id IS NOT NULL AND status IN('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO');
      CREATE UNIQUE INDEX dispatch_one_active_vehicle ON dispatches(vehicle_plate) WHERE vehicle_plate IS NOT NULL AND vehicle_plate<>'EXTERNO' AND status IN('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO');`)
    // La regla por tipo de servicio, tal como quedó en producción (settlement_checklist renombrada a settlement_checklist_rules)
    await db.exec(fn('supabase/migrations/20261013150000_settlement_rules_by_service.sql', 'settlement_checklist') +
      '\nALTER FUNCTION settlement_checklist(uuid,uuid) RENAME TO settlement_checklist_rules;')

    await db.query("INSERT INTO profiles(id,first_name,last_name,is_active) VALUES($1,'Ana','Torres',true)", [USER])
    const route = (dispatch, status, site, plate) => db.query("INSERT INTO dispatches(id,dispatch_number,status,site_id,vehicle_plate,scheduled_departure) VALUES($1,$2,$3,$4,$5,now())", [dispatch, 'D-' + plate, status, site, plate])
    await route(D1, 'EN RUTA', id(8), 'AAA-001')
    await route(D2, 'PROGRAMADO', id(8), 'AAA-002')
    await route(D3, 'CIERRE_OPERATIVO', id(9), 'AAA-003')
    const service = async (dispatch, request, type, mode = 'TRANSPORTE_JRM', seq = 1) => {
      await db.query("INSERT INTO transport_requests(id,request_number,request_type,attention_mode,status) VALUES($1,$2,$3,$4,'ASIGNADA')", [request, 'S-' + request.slice(-3), type, mode])
      await db.query("INSERT INTO dispatch_requests(dispatch_id,transport_request_id,sequence_order,status) VALUES($1,$2,$3,'PROGRAMADO')", [dispatch, request, seq])
    }
    await service(D1, R1, 'DESPACHO'); await service(D1, R2, 'RECOJO', 'TRANSPORTE_JRM', 2); await service(D1, R3, 'DESPACHO', 'RECOJO_CLIENTE', 3)
    await service(D1, R4, 'TRASLADO', 'TRANSPORTE_JRM', 4); await service(D1, R5, 'DESPACHO', 'TRANSPORTE_JRM', 5); await service(D1, R6, 'DESPACHO', 'TRANSPORTE_JRM', 6)
    await service(D2, R7, 'DESPACHO'); await service(D3, R8, 'TRASLADO')

    await db.exec(readFileSync('supabase/migrations/20261106090000_documentary_closure.sql', 'utf8'))
    const scalar = async (sql, p = []) => (await db.query(sql, p)).rows[0]?.v
    const set = (key, value) => db.query('SELECT set_config($1,$2,false)', ['test.' + key, value])
    const status = (d, r) => scalar('SELECT status AS v FROM documentary_closures WHERE dispatch_id=$1 AND request_id=$2', [d, r])
    const row = (d, r) => scalar('SELECT to_jsonb(c) AS v FROM documentary_closures c WHERE dispatch_id=$1 AND request_id=$2', [d, r])
    const lastEvent = (d, r) => scalar('SELECT to_jsonb(e) AS v FROM documentary_closure_events e WHERE dispatch_id=$1 AND request_id=$2 ORDER BY created_at DESC LIMIT 1', [d, r])
    const counts = async () => ({ rows: await scalar('SELECT count(*)::int AS v FROM documentary_closures'), events: await scalar('SELECT count(*)::int AS v FROM documentary_closure_events') })
    const call = (name, d, r, reason) => scalar(`SELECT ${name}($1,$2,$3) AS v`, [d, r, reason])

    // 1. Carga inicial: solo rutas que salieron (D1 y D3; la programada D2 no), una vez
    assert.equal(await counts().then(c => c.rows), 7, 'la migración carga los servicios de rutas que ya salieron')
    assert.equal(await status(D2, R7), undefined, 'una ruta programada no se carga')
    assert.deepEqual([await status(D1, R1), await status(D1, R4), await status(D3, R8)], ['PENDIENTE', 'COMPLETO', 'COMPLETO'])
    assert.equal((await row(D1, R4)).source, 'AUTOMATICO')
    const initial = await lastEvent(D1, R1)
    assert.equal(initial.action, 'INICIAL'); assert.equal(initial.previous_status, null); assert.equal(initial.details.carga_inicial, true); assert.equal(initial.actor_id, null)
    const before = await counts()
    assert.equal(await scalar('SELECT documentary_closure_backfill() AS v'), 0, 'carga inicial idempotente')
    assert.deepEqual(await counts(), before, 'repetir la carga no agrega filas ni historial')
    await route(D4, 'CIERRE_OPERATIVO', id(8), 'AAA-004'); await service(D4, R9, 'RECOJO')
    //    Rutas liquidadas antiguas no entran en la carga inicial (se registran al consultarlas)
    await route(D5, 'LIQUIDADO', id(8), 'AAA-005'); await service(D5, R10, 'TRASLADO')
    await db.query("UPDATE dispatches SET scheduled_departure=now()-interval '1 year' WHERE id=$1", [D5])
    assert.equal(await scalar('SELECT documentary_closure_backfill() AS v'), 1, 'la carga completa lo que falta')
    assert.equal(await scalar('SELECT documentary_closure_backfill() AS v'), 0)
    assert.equal(await status(D5, R10), undefined)

    await set('user', USER)
    // 2. Estado automático por tipo de servicio, sincronizado desde la evidencia
    //    Entrega: GR enviada → en validación; observada → observado; con Packing List y GR validada → completo
    await db.query("INSERT INTO delivery_conformities(dispatch_id,request_id,state) VALUES($1,$2,'RECIBIDA')", [D1, R1])
    assert.equal(await status(D1, R1), 'EN_VALIDACION')
    await db.query("UPDATE delivery_conformities SET state='OBSERVADA' WHERE dispatch_id=$1 AND request_id=$2", [D1, R1])
    assert.equal(await status(D1, R1), 'OBSERVADO')
    await db.query("INSERT INTO dispatch_documents(id,dispatch_id,doc_type,file_path) VALUES($1,$2,'PACKING_LIST','d1/packing.pdf')", [id(900), D1])
    assert.equal(await status(D1, R1), 'OBSERVADO', 'el Packing List solo no basta: falta la GR validada')
    await db.query("UPDATE delivery_conformities SET state='VALIDADA' WHERE dispatch_id=$1 AND request_id=$2", [D1, R1])
    const done = await row(D1, R1)
    assert.equal(done.status, 'COMPLETO'); assert.equal(done.source, 'AUTOMATICO'); assert.equal(done.completed_by, USER); assert.ok(done.completed_at)
    const auto = await lastEvent(D1, R1)
    assert.deepEqual([auto.action, auto.previous_status, auto.new_status, auto.actor_id], ['AUTOMATICO', 'OBSERVADO', 'COMPLETO', USER])
    //    Recojo: GR validada
    await db.query("INSERT INTO delivery_conformities(dispatch_id,request_id,state) VALUES($1,$2,'VALIDADA')", [D1, R2])
    assert.equal(await status(D1, R2), 'COMPLETO')
    //    Recojo por el cliente: Nota de Despacho
    assert.equal(await status(D1, R3), 'PENDIENTE')
    await db.query("INSERT INTO dispatch_document_references(dispatch_id,request_id,doc_type,document_number,created_by) VALUES($1,$2,'NOTA_DESPACHO','ND01-1',$3)", [D1, R3, USER])
    assert.equal(await status(D1, R3), 'COMPLETO')
    assert.equal((await row(D1, R3)).service_kind, 'RECOJO_CLIENTE')
    //    Rechazo en destino: completo con la decisión de Despacho
    await db.query("INSERT INTO delivery_rejections(id,dispatch_id,request_id,kind,reason_code,photos) VALUES($1,$2,$3,'TOTAL','CLIENTE_AUSENTE','{f.jpg}')", [id(950), D1, R5])
    assert.deepEqual([await status(D1, R5), (await row(D1, R5)).service_kind, (await row(D1, R5)).missing], ['PENDIENTE', 'RECHAZO', ['DECISION_RECHAZO']])
    await db.query("UPDATE delivery_rejections SET decision='ANULADA',decision_reason='Cliente canceló' WHERE id=$1", [id(950)])
    assert.equal(await status(D1, R5), 'COMPLETO')

    // 3. Cierre manual y deshacer con historial
    await set('manual', 'false')
    await assert.rejects(call('settlement_mark_settled', D1, R6, 'Cliente confirmó la recepción por correo'), /Solo el Administrador/)
    await set('manual', 'true')
    await assert.rejects(call('settlement_mark_settled', D1, R6, 'corto'), /Indique el motivo/)
    const manual = await call('settlement_mark_settled', D1, R6, 'Cliente confirmó la recepción por correo')
    assert.equal(manual.complete, true); assert.deepEqual(manual.manual.missing, ['GUIA_O_NOTA']); assert.equal(manual.manual.closed_by, 'Ana Torres')
    assert.deepEqual([(await row(D1, R6)).status, (await row(D1, R6)).source], ['COMPLETO', 'MANUAL'])
    const closeEvent = await lastEvent(D1, R6)
    assert.deepEqual([closeEvent.action, closeEvent.previous_status, closeEvent.new_status, closeEvent.reason, closeEvent.actor_id],
      ['CIERRE_MANUAL', 'PENDIENTE', 'COMPLETO', 'Cliente confirmó la recepción por correo', USER])
    assert.deepEqual(closeEvent.details.faltaba, ['GUIA_O_NOTA'])
    await assert.rejects(call('settlement_mark_settled', D1, R6, 'Cliente confirmó la recepción por correo'), /ya tiene su cierre documentario completo/)
    assert.equal(await scalar("SELECT to_regprocedure('public.settlement_undo_manual(uuid,uuid)') AS v"), null, 'ya no existe el deshacer sin motivo')
    await assert.rejects(call('settlement_undo_manual', D1, R6, ''), /Indique el motivo/)
    await set('manual', 'false')
    await assert.rejects(call('settlement_undo_manual', D1, R6, 'La guía física no llegó al final'), /Sin permiso/)
    await set('manual', 'true')
    const undone = await call('settlement_undo_manual', D1, R6, 'La guía física no llegó al final')
    assert.equal(undone.complete, false); assert.equal(undone.manual, undefined)
    assert.equal(await status(D1, R6), 'PENDIENTE')
    assert.equal(await scalar('SELECT count(*)::int AS v FROM settlement_manual_closures'), 0)
    const undoEvent = await lastEvent(D1, R6)
    assert.deepEqual([undoEvent.action, undoEvent.previous_status, undoEvent.new_status, undoEvent.reason], ['DESHACER_MANUAL', 'COMPLETO', 'PENDIENTE', 'La guía física no llegó al final'])
    assert.equal(undoEvent.details.cierre_manual.reason, 'Cliente confirmó la recepción por correo', 'el cierre manual deshecho queda en el historial')
    assert.equal(undoEvent.details.cierre_manual.closed_by, USER)
    await assert.rejects(call('settlement_undo_manual', D1, R6, 'La guía física no llegó al final'), /no tiene liquidación manual/)

    // 4. Reapertura: con y sin permiso, motivo obligatorio, solo un COMPLETO
    await set('manual', 'false')
    await assert.rejects(call('documentary_reopen', D1, R1, 'La guía validada tiene otro número'), /pueden reabrir/)
    await set('manual', 'true')
    await assert.rejects(call('documentary_reopen', D1, R1, 'corto'), /Indique el motivo/)
    await assert.rejects(call('documentary_reopen', D1, R6, 'La guía validada tiene otro número'), /Solo se reabre un cierre documentario completo/)
    await assert.rejects(call('documentary_reopen', D3, R8, 'La guía validada tiene otro número'), /sede no autorizada/)
    await assert.rejects(call('documentary_reopen', D1, R8, 'La guía validada tiene otro número'), /no pertenece/)
    const reopened = await call('documentary_reopen', D1, R1, 'La guía validada tiene otro número')
    assert.equal(reopened.documentary.status, 'OBSERVADO'); assert.equal(reopened.complete, false)
    assert.ok(reopened.missing.includes('REAPERTURA')); assert.equal(reopened.reopened.reason, 'La guía validada tiene otro número'); assert.equal(reopened.reopened.by, 'Ana Torres')
    const reopenEvent = await lastEvent(D1, R1)
    assert.deepEqual([reopenEvent.action, reopenEvent.previous_status, reopenEvent.new_status, reopenEvent.actor_id], ['REAPERTURA', 'COMPLETO', 'OBSERVADO', USER])
    //    La consulta y los cambios sin evidencia nueva no levantan la reapertura
    const list = await scalar('SELECT get_settlement_checklists($1) AS v', [[D1]])
    assert.equal(list.length, 6); assert.equal(list.find(c => c.request_id === R1).documentary.status, 'OBSERVADO')
    assert.equal(list.find(c => c.request_id === R4).documentary.status, 'COMPLETO')
    await db.query("UPDATE dispatch_documents SET voided_at=now() WHERE id=$1", [id(900)])
    assert.equal(await status(D1, R1), 'OBSERVADO')
    await db.query("INSERT INTO dispatch_documents(id,dispatch_id,doc_type,file_path) VALUES($1,$2,'PACKING_LIST','d1/packing2.pdf')", [id(901), D1])
    assert.equal(await status(D1, R1), 'COMPLETO', 'la evidencia nueva levanta la reapertura y vuelve a la regla automática')
    assert.equal(await scalar('SELECT reopened_at AS v FROM documentary_closures WHERE dispatch_id=$1 AND request_id=$2', [D1, R1]), null)
    //    Reabierto con la evidencia completa: se vuelve a cerrar manualmente con motivo (sin faltantes)
    await call('documentary_reopen', D1, R1, 'Se revisa de nuevo la guía de remisión')
    assert.equal(await status(D1, R1), 'OBSERVADO')
    const reclosed = await call('settlement_mark_settled', D1, R1, 'Revisión conforme con el cliente')
    assert.equal(reclosed.complete, true); assert.equal(reclosed.manual, undefined)
    assert.deepEqual([(await row(D1, R1)).status, (await row(D1, R1)).source], ['COMPLETO', 'MANUAL'])
    assert.equal(await scalar('SELECT count(*)::int AS v FROM settlement_manual_closures'), 0, 'con evidencia completa no se registra cierre manual con faltantes')
    //    Reabrir un cierre manual lo pasa al historial
    await call('settlement_mark_settled', D1, R6, 'Cliente confirmó la recepción por correo')
    const reopenManual = await call('documentary_reopen', D1, R6, 'El cliente desconoce la recepción')
    assert.equal(reopenManual.manual, undefined); assert.equal(await scalar('SELECT count(*)::int AS v FROM settlement_manual_closures'), 0)
    assert.equal((await lastEvent(D1, R6)).details.cierre_manual.reason, 'Cliente confirmó la recepción por correo')
    await db.query("INSERT INTO dispatch_document_references(dispatch_id,request_id,doc_type,document_number,created_by) VALUES($1,$2,'NOTA_DESPACHO','ND01-2',$3)", [D1, R6, USER])
    assert.deepEqual([(await row(D1, R6)).status, (await row(D1, R6)).source], ['COMPLETO', 'AUTOMATICO'])

    // 5. Historial en la pantalla y solo de inserción
    const history = await scalar('SELECT get_documentary_closure_history($1,$2) AS v', [D1, R6])
    assert.deepEqual(history.map(e => e.action), ['AUTOMATICO', 'REAPERTURA', 'CIERRE_MANUAL', 'DESHACER_MANUAL', 'CIERRE_MANUAL', 'INICIAL'])
    assert.equal(history[1].actor, 'Ana Torres')
    await assert.rejects(db.query('UPDATE documentary_closure_events SET reason=NULL WHERE true'), /no se modifica/)
    await assert.rejects(db.query('DELETE FROM documentary_closure_events WHERE true'), /no se modifica/)
    await set('read', 'false'); await set('manual', 'false')
    await assert.rejects(scalar('SELECT get_documentary_closure_history($1,$2) AS v', [D1, R6]), /Sin permiso/)
    await assert.rejects(scalar('SELECT get_settlement_checklists($1) AS v', [[D1]]), /Sin permiso/)
    await set('read', 'true'); await set('manual', 'true')

    // 6. Un error al sincronizar no bloquea la operación (la consulta lo corrige después)
    await db.exec("ALTER TABLE documentary_closures ADD CONSTRAINT test_block CHECK (status<>'EN_VALIDACION')")
    await db.query("INSERT INTO delivery_conformities(dispatch_id,request_id,state) VALUES($1,$2,'RECIBIDA')", [D4, R9])
    assert.equal(await status(D4, R9), 'PENDIENTE')
    await db.exec('ALTER TABLE documentary_closures DROP CONSTRAINT test_block')
    await scalar('SELECT get_settlement_checklists($1) AS v', [[D4]])
    assert.equal(await status(D4, R9), 'EN_VALIDACION')
    assert.equal((await lastEvent(D4, R9)).actor_id, null, 'la sincronización al consultar no se atribuye al usuario')
    await scalar('SELECT get_settlement_checklists($1) AS v', [[D5, D4]])
    assert.equal(await status(D5, R10), 'COMPLETO', 'la ruta antigua se registra al consultarla')
    const again = await counts()
    await scalar('SELECT get_settlement_checklists($1) AS v', [[D1, D4, D5]])
    assert.deepEqual(await counts(), again, 'consultar de nuevo no agrega filas ni historial')

    // 7. Privilegios
    for (const t of ['documentary_closures', 'documentary_closure_events'])
      assert.equal(await scalar(`SELECT has_table_privilege('authenticated','${t}','SELECT') OR has_table_privilege('anon','${t}','SELECT') AS v`), false, t)
    for (const f of ['documentary_closure_sync(uuid,uuid,text,text,jsonb)', 'documentary_closure_backfill()', 'settlement_checklist_evidence(uuid,uuid)', 'documentary_closure_evidence_trigger()'])
      assert.equal(await scalar(`SELECT has_function_privilege('authenticated','${f}','EXECUTE') AS v`), false, f)
    for (const f of ['documentary_reopen(uuid,uuid,text)', 'settlement_undo_manual(uuid,uuid,text)', 'get_documentary_closure_history(uuid,uuid)', 'get_settlement_checklists(uuid[])']) {
      assert.equal(await scalar(`SELECT has_function_privilege('authenticated','${f}','EXECUTE') AS v`), true, f)
      assert.equal(await scalar(`SELECT has_function_privilege('anon','${f}','EXECUTE') AS v`), false, f)
    }
    assert.equal(await scalar("SELECT count(*)::int AS v FROM pg_policies WHERE policyname='security_active_account' AND tablename LIKE 'documentary_closure%' AND permissive='RESTRICTIVE'"), 2)
    console.log('PASS cierre documentario: estado automático por tipo (entrega, recojo, recojo del cliente, punto a punto, rechazo), cierre manual y deshacer con historial, reapertura con y sin permiso, carga inicial idempotente, historial solo de inserción, triggers no bloqueantes y privilegios')
  } finally { await db.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
