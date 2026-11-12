// Flujo picking -> consolidación LPN -> auditoría en paralelo -> Packing List liberado, sobre la base WMS real
// (migraciones de wms-db en PGlite). Cubre los criterios de aceptación verificables en base de datos.
const {PGlite}=require('@electric-sql/pglite');
const fs=require('fs');const path=require('node:path');const assert=require('node:assert/strict');
const U={admin:'00000000-0000-0000-0000-0000000000a0',op1:'00000000-0000-0000-0000-0000000000a1',op2:'00000000-0000-0000-0000-0000000000a2',aud:'00000000-0000-0000-0000-0000000000a3',sup:'00000000-0000-0000-0000-0000000000a4',both:'00000000-0000-0000-0000-0000000000a5'};
const OT='00000000-0000-0000-0000-00000000c001',OT2='00000000-0000-0000-0000-00000000c002',CL='00000000-0000-0000-0000-00000000c100';
const REQ='00000000-0000-0000-0000-00000000d001',REQ_CANCEL='00000000-0000-0000-0000-00000000d002',REQ_PEND='00000000-0000-0000-0000-00000000d003';
const feed=(status={})=>[
 {id:REQ,request_number:'RT-000901',request_type:'DESPACHO',status:status[REQ]||'APROBADA',site_code:'PRINCIPAL',delivery_address:'Lima',client:{id:CL,business_name:'Fargoline SAC',ruc:'20111111111'},contract:{id:OT,code:'16544',type:'CONTRATO',client_id:CL},components:[]},
 {id:REQ_CANCEL,request_number:'RT-000902',request_type:'DESPACHO',status:status[REQ_CANCEL]||'APROBADA',site_code:'PRINCIPAL',client:{id:CL,business_name:'Fargoline SAC',ruc:'20111111111'},contract:{id:OT2,code:'16497',type:'CONTRATO',client_id:CL},components:[]},
 {id:REQ_PEND,request_number:'RT-000903',request_type:'DESPACHO',status:'PENDIENTE',site_code:'PRINCIPAL',client:null,contract:{id:OT2,code:'16497',type:'CONTRATO',client_id:CL},components:[]},
];
(async()=>{
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE TABLE auth.users(id uuid primary key); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE SQL STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role; GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC; CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$;`);
 const dir=path.join(__dirname,'../wms-db/supabase/migrations');
 for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir,f),'utf8'));
 const roles={op:['almacen-picking'],aud:['almacen-auditoria'],sup:['almacen-supervisor'],both:['almacen-picking','almacen-auditoria']};
 let sql="DELETE FROM public.roles; DELETE FROM public.sites; INSERT INTO public.sites(code,name) VALUES('PRINCIPAL','Local');";
 for(const [k,p] of Object.entries(roles)) sql+=`INSERT INTO public.roles(name,permissions) VALUES('${k}','${JSON.stringify(p)}');`;
 const userRole={op1:'op',op2:'op',aud:'aud',sup:'sup',both:'both'};
 for(const [u,id] of Object.entries(U)){ if(u==='admin')continue; sql+=`INSERT INTO auth.users VALUES('${id}'); INSERT INTO public.profiles(id,email,first_name,role_id,is_active) SELECT '${id}','${u}@x.pe','${u}',id,true FROM public.roles WHERE name='${userRole[u]}'; INSERT INTO public.user_site_access SELECT '${id}',id FROM public.sites ON CONFLICT DO NOTHING;`; }
 // Paquetes etiquetados en recepción (OT 16544 x3, OT 16497 x1)
 for(const [i,ot] of [[1,'16544'],[2,'16544'],[3,'16544'],[4,'16497'],[5,'']].entries()) sql+=`INSERT INTO public.wh_packages(package_code,source_document_no,source_contract_code,source_lot,source_product_code,source_warehouse,source_date,source_movement_key,source_key,site_id,description,quantity,unit,weight_kg) SELECT 'PKG-${ot[0]}','IPT-1',nullif('${ot[1]}',''),'16544-S001','PRD-${ot[0]}','APT','2026-11-07','mk${ot[0]}','sk${ot[0]}',id,'Estante ${ot[0]}',10,'UN',25.5 FROM public.sites;`;
 await db.exec(sql);
 const KEY='k'.repeat(40);
 await db.exec(`UPDATE public.wh_tms_sync_state SET key_hash=encode(sha256(convert_to('${KEY}','UTF8')),'hex')`);
 const as=async u=>db.exec(`RESET ROLE; SET request.jwt.claim.sub='${U[u]}'; SET ROLE authenticated;`);
 const q=async(s,p=[])=>(await db.query(s,p)).rows;
 const one=async(s,p=[])=>Object.values((await q(s,p))[0]||{})[0];
 const fails=async(s,p,re)=>{try{await db.query(s,p)}catch(e){if(re&&!re.test(e.message))throw Error(`Mensaje inesperado: ${e.message}`);return e.message}throw Error(`Debía fallar: ${s}`)};
 const sys=async s=>{await db.exec('RESET ROLE');const r=(await db.query(s)).rows;return r};

 // 1. Sincronización idempotente
 await as('op1');
 const known=await one('SELECT public.wh_tms_sync_claim(true) AS k');
 assert.deepEqual(known,[]);
 await q('SELECT public.wh_tms_sync_apply($1,$2::jsonb)',[KEY,JSON.stringify(feed())]);
 await db.exec("RESET ROLE; UPDATE public.wh_tms_sync_state SET last_run_at=now()-interval '1 hour'"); await as('op1');
 const known2=await one('SELECT public.wh_tms_sync_claim(false) AS k');
 assert.equal(known2.length,3,'debe informar las 3 solicitudes conocidas');
 assert.equal(await one('SELECT public.wh_tms_sync_claim(false)'),null,'no debe sincronizar dos veces en un minuto');
 await q('SELECT public.wh_tms_sync_apply($1,$2::jsonb)',[KEY,JSON.stringify(feed({[REQ_CANCEL]:'CANCELADA'}))]);
 await fails('SELECT public.wh_tms_sync_apply($1,$2::jsonb)',['x'.repeat(40),JSON.stringify(feed({[REQ]:'CANCELADA'}))],/Clave/);
 assert.equal((await sys('SELECT count(*)::int n FROM public.wh_tasks'))[0].n,3,'sin tareas duplicadas');
 assert.equal((await sys('SELECT count(*)::int n FROM public.transport_requests'))[0].n,3,'sin solicitudes duplicadas');
 const task=(await sys(`SELECT id,status FROM public.wh_tasks WHERE transport_request_id='${REQ}'`))[0];
 assert.equal(task.status,'PENDING');
 assert.equal((await sys(`SELECT status FROM public.wh_tasks WHERE transport_request_id='${REQ_CANCEL}'`))[0].status,'CANCELLED');
 console.log('PASS: sincronización TMS->WMS idempotente, con estado de solicitudes conocidas y cancelación.');

 // 2. Toma de tarea: no válida / cancelada no se toma; dos operarios no toman la misma
 await as('op1');
 const tCancel=(await sys(`SELECT id FROM public.wh_tasks WHERE transport_request_id='${REQ_CANCEL}'`))[0].id;
 const tPend=(await sys(`SELECT id FROM public.wh_tasks WHERE transport_request_id='${REQ_PEND}'`))[0].id;
 await as('op1');
 await fails('SELECT public.wh_assign_task($1)',[tCancel],/cerrada/);
 await fails('SELECT public.wh_assign_task($1)',[tPend],/aprobada/);
 await q('SELECT public.wh_assign_task($1)',[task.id]);
 await as('op2'); await fails('SELECT public.wh_assign_task($1)',[task.id],/otro operador/);
 const assigned=(await sys(`SELECT assigned_picker,assigned_at FROM public.wh_tasks WHERE id='${task.id}'`))[0];
 assert.equal(assigned.assigned_picker,U.op1); assert.ok(assigned.assigned_at);
 console.log('PASS: solicitud cancelada o no aprobada no se toma; toma con usuario y hora; sin doble asignación.');
 // Tarea abandonada: tras 20 min sin actividad del responsable otro operador la toma con motivo
 await sys(`UPDATE public.wh_tasks SET assigned_at=now()-interval '30 minutes' WHERE id='${task.id}'`); await sys('ALTER TABLE public.wh_scan_events DISABLE TRIGGER USER'); await sys(`UPDATE public.wh_scan_events SET occurred_at=now()-interval '30 minutes' WHERE task_id='${task.id}'`); await sys('ALTER TABLE public.wh_scan_events ENABLE TRIGGER USER');
 await as('op2'); await fails('SELECT public.wh_assign_task($1)',[task.id],/motivo/);
 await q("SELECT public.wh_assign_task($1,'op1 salió de turno')",[task.id]);
 assert.equal((await sys(`SELECT assigned_picker FROM public.wh_tasks WHERE id='${task.id}'`))[0].assigned_picker,U.op2);
 assert.equal((await sys(`SELECT payload->>'reason' r FROM public.wh_scan_events WHERE task_id='${task.id}' AND event_type='TASK_ASSIGNED' ORDER BY recorded_at DESC LIMIT 1`))[0].r,'op1 salió de turno');
 await as('op1'); await fails("SELECT public.wh_assign_task($1,'x')",[task.id],/otro operador/);
 assert.ok((await one("SELECT public.wh_task_board('tareas')")).find(r=>r.id===task.id).last_activity_at,'el tablero informa la última actividad');
 await sys(`UPDATE public.wh_tasks SET assigned_picker='${U.op1}' WHERE id='${task.id}'`);
 console.log('PASS: tarea sin actividad 20 min la toma otro operador con motivo; con actividad reciente no.');

 // 3. Picking por escaneo validado contra la OT
 await as('op1');
 await q("SELECT public.wh_task_action($1,'START_PICKING')",[task.id]);
 await as('aud'); assert.ok((await one("SELECT public.wh_task_board('auditoria')")).some(r=>r.id===task.id&&r.display_state==='EN_PICKING'),'el auditor ve la tarea apenas inicia el picking, sin LPN'); await as('op1');
 for(const c of ['PKG-1','PKG-2','PKG-3']) await q("SELECT public.wh_record_scan($1,$2,'PICK',gen_random_uuid())",[task.id,c]);
 await fails("SELECT public.wh_record_scan($1,'PKG-4','PICK',gen_random_uuid())",[task.id],/OT/);
 await fails("SELECT public.wh_record_scan($1,'PKG-5','PICK',gen_random_uuid())",[task.id],/no tiene OT/);
 await fails("SELECT public.wh_record_scan($1,'PKG-NO','PICK',gen_random_uuid())",[task.id],/no pertenece/);
 console.log('PASS: escaneo reconoce paquetes de la OT y rechaza otra OT, sin OT o código desconocido.');

 // 4. Consolidación en LPN padre, sin duplicar inventario ni paquetes
 const before=(await sys('SELECT count(*)::int n, sum(quantity)::numeric s FROM public.wh_packages'))[0];
 await as('op1');
 const ev='11111111-1111-1111-1111-111111111111';
 const lpn1=await one('SELECT public.wh_consolidate_lpn($1,$2::text[],$3)',[task.id,['PKG-1','PKG-2','PKG-1'],ev]);
 assert.equal(lpn1.package_count,2); assert.equal(Number(lpn1.quantity),20); assert.equal(Number(lpn1.weight_kg),51);
 const retry=await one('SELECT public.wh_consolidate_lpn($1,$2::text[],$3)',[task.id,['PKG-1','PKG-2'],ev]);
 assert.equal(retry.id,lpn1.id,'reintento devuelve el mismo LPN'); assert.equal(retry.duplicate_retry,true);
 await fails('SELECT public.wh_consolidate_lpn($1,$2::text[])',[task.id,['PKG-2']],/ya está en el LPN/);
 await fails('SELECT public.wh_consolidate_lpn($1,$2::text[])',[task.id,['PKG-4']],/no fue recogido/);
 const after=(await sys('SELECT count(*)::int n, sum(quantity)::numeric s FROM public.wh_packages'))[0];
 assert.deepEqual(after,before,'la consolidación no crea ni duplica existencias');
 await q('SELECT public.wh_print_lpn_label($1)',[lpn1.id]);
 await fails('SELECT public.wh_print_lpn_label($1)',[lpn1.id],/reimpresión/);
 console.log('PASS: LPN padre con trazabilidad a paquetes, totales correctos, idempotente, sin duplicar inventario, etiqueta impresa una vez.');

 // 5. Auditoría en paralelo mientras sigue el picking
 await as('aud');
 const board=await one("SELECT public.wh_task_board('auditoria')");
 const row=board.find(r=>r.id===task.id); assert.ok(row,'el auditor ve la tarea en picking'); assert.equal(row.display_state,'EN_PICKING'); assert.equal(row.lpn_pending,1);
 await q("SELECT public.wh_audit_lpn($1,'APROBADO')",[lpn1.id]);
 await as('op1'); await fails("SELECT public.wh_audit_lpn($1,'APROBADO')",[lpn1.id],/permiso/);
 const lpn2=await one('SELECT public.wh_consolidate_lpn($1,$2::text[])',[task.id,['PKG-3']]);
 assert.equal(lpn1.lpn_code,'16544-S001-B-0001','varios paquetes: bulto nuevo con el primer número de la serie de su lote'); assert.equal(lpn1.own_label,false);
 assert.equal(lpn2.lpn_code,'PKG-3','un paquete solo usa el código de su etiqueta'); assert.equal(lpn2.own_label,true);
 assert.equal((await sys(`SELECT print_count FROM public.wh_lpns WHERE id='${lpn2.id}'`))[0].print_count,1,'no pide imprimir otra etiqueta');
 await as('aud');
 await fails("SELECT public.wh_audit_lpn($1,'OBSERVADO')",[lpn2.id],/Describa/);
 await fails("SELECT public.wh_audit_lpn($1,'OBSERVADO','x',null,ARRAY['otro/foto.jpg'])",[lpn2.id],/Evidencia/);
 await q("SELECT public.wh_audit_lpn($1,'OBSERVADO','Embalaje roto','PKG-3',ARRAY[$2])",[lpn2.id,lpn2.id+'/foto1.jpg']);
 const hist=await one('SELECT public.wh_task_lpns($1)',[task.id]);
 const l2=hist.lpns.find(l=>l.id===lpn2.id);
 assert.equal(l2.audit_status,'OBSERVADO'); assert.equal(l2.audits[0].evidence_paths[0],lpn2.id+'/foto1.jpg'); assert.equal(l2.audits[0].actor_name,'aud');
 console.log('PASS: auditoría en paralelo con avance visible; aprobar/observar por LPN con comentario y evidencia; operario no audita.');

 // 6. No autoaprobación salvo supervisión con motivo
 await db.exec(`RESET ROLE; UPDATE public.wh_tasks SET assigned_picker='${U.both}' WHERE id='${task.id}'`);
 await as('both'); await fails("SELECT public.wh_audit_lpn($1,'APROBADO')",[lpn2.id],/preparó/);
 await db.exec(`RESET ROLE; UPDATE public.wh_tasks SET assigned_picker='${U.op1}' WHERE id='${task.id}'`);
 console.log('PASS: quien preparó no aprueba su propia tarea.');
 await as('sup');
 const earlyUnit=await one('SELECT public.wh_load_unit_add($1)',[task.id]);
 await fails('SELECT public.wh_lpns_assign_unit($1,$2::uuid[],$3)',[task.id,[lpn1.id,lpn2.id],earlyUnit.id],/liberados por Auditoría/);
 assert.equal((await sys(`SELECT load_unit_id FROM public.wh_lpns WHERE id='${lpn1.id}'`))[0].load_unit_id,null,'la selección mixta no asigna parcialmente');
 await as('sup');
 const labelsBefore=await sys(`SELECT id,lpn_code,print_count FROM public.wh_lpns WHERE id='${lpn1.id}'`);
 await as('sup');
 await q('SELECT public.wh_lpns_assign_unit($1,$2::uuid[],$3)',[task.id,[lpn1.id],earlyUnit.id]);
 assert.deepEqual(await sys(`SELECT id,lpn_code,print_count FROM public.wh_lpns WHERE id='${lpn1.id}'`),labelsBefore,'asignar conserva LPN y etiquetas');
 await as('op1'); await fails('SELECT public.wh_lpns_assign_unit($1,$2::uuid[],$3)',[task.id,[lpn1.id],earlyUnit.id],/permiso/);
 await as('sup'); await q('SELECT public.wh_load_unit_remove($1)',[earlyUnit.id]);
 await as('op1');
 console.log('PASS: asignación múltiple solo de liberados, atómica, durante Picking, sin crear ni reimprimir etiquetas.');

 // 7. Finalizar, liberar bloqueado con observación; corrección solo re-audita el LPN cambiado
 await as('op1');
 await q("SELECT public.wh_task_action($1,'FINISH_PICKING')",[task.id]);
 await as('aud'); await fails('SELECT public.wh_release_packing_list($1)',[task.id],/observados/);
 let st=(await one("SELECT public.wh_task_board('tareas',$1)",[task.id]))[0]; assert.equal(st.display_state,'OBSERVADO');
 await as('op1');
 await q("SELECT public.wh_lpn_undo($1,'Reembalar paquete')",[lpn2.id]);
 assert.equal((await sys(`SELECT status FROM public.wh_tasks WHERE id='${task.id}'`))[0].status,'PICKING','la corrección reabre el picking');
 assert.equal((await sys(`SELECT status FROM public.wh_lpns WHERE id='${lpn2.id}'`))[0].status,'VOID');
 assert.ok((await sys(`SELECT count(*)::int n FROM public.wh_lpn_audits WHERE lpn_id='${lpn2.id}'`))[0].n>=2,'historial conservado');
 await fails("SELECT public.wh_lpn_remove_package($1,'PKG-1',false,'x')",[lpn1.id],/aprobado/);
 // Reagrupar el paquete del LPN deshecho junto con otro libera su código: la carga no debe encontrar el LPN anulado.
 await db.exec('RESET ROLE; BEGIN'); await as('sup');
 await q("SELECT public.wh_lpn_undo($1,'Reagrupar')",[lpn1.id]); await as('op1');
 const mixed=await one('SELECT public.wh_consolidate_lpn($1,$2::text[])',[task.id,['PKG-1','PKG-3']]);
 assert.equal(mixed.lpn_code,'16544-S001-B-0002','el nuevo agrupamiento sigue el correlativo del lote'); assert.equal(mixed.own_label,false);
 assert.equal((await sys("SELECT public.wh_next_bulto_code(' lote ñ / 7 ') AS c"))[0].c,'LOTE-N-7-B-0001','el código del bulto usa solo caracteres de Code 128');
 assert.equal((await sys("SELECT public.wh_next_bulto_code('') AS c"))[0].c,'SIN-LOTE-B-0001','sin lote: serie propia');
 assert.equal((await sys("SELECT count(*)::int n FROM public.wh_lpns WHERE lpn_code='PKG-3'"))[0].n,0,'el LPN anulado ya no retiene el código del paquete');
 await db.exec('RESET ROLE; ROLLBACK'); await as('op1');
 const lpn3=await one('SELECT public.wh_consolidate_lpn($1,$2::text[])',[task.id,['PKG-3']]);
 assert.equal(lpn3.lpn_code,'PKG-3','al deshacer y volver a consolidar reutiliza el código del paquete');
 assert.match((await sys(`SELECT lpn_code FROM public.wh_lpns WHERE id='${lpn2.id}'`))[0].lpn_code,/^PKG-3-ANULADO-/,'el LPN anulado conserva su historial con otro código');
 console.log('PASS: paquete que sale solo queda como LPN con su propia etiqueta; deshacer y reconsolidar sin choque de código.');
 await q("SELECT public.wh_task_action($1,'FINISH_PICKING')",[task.id]);
 await as('aud');
 await fails('SELECT public.wh_release_packing_list($1)',[task.id],/pendientes/);
 await q("SELECT public.wh_audit_lpn($1,'APROBADO')",[lpn3.id]);
 assert.equal((await sys(`SELECT audit_status FROM public.wh_lpns WHERE id='${lpn1.id}'`))[0].audit_status,'APROBADO','LPN sin cambios conserva su aprobación');
 await as('op1'); await fails("SELECT public.wh_task_action($1,'LOAD')",[task.id],/permiso de carga|Packing List/);
 await as('sup'); await fails("SELECT public.wh_task_action($1,'LOAD')",[task.id],/escanee todos los paquetes cargados/);
 console.log('PASS: no se libera con observaciones o pendientes; corrección y nueva revisión solo del LPN cambiado; carga bloqueada sin Packing List.');

 // 8. Liberación, impresión y versión
 await as('aud');
 assert.ok(await one('SELECT public.wh_refresh_packing_list($1)',[task.id]),'actualización segura materializa el documento sin volver a auditar');
 const autoPl=(await sys(`SELECT id, released_by FROM public.wh_packing_lists WHERE task_id='${task.id}' AND status='LIBERADO'`))[0];
 assert.ok(autoPl,'última liberación de LPN genera el documento automáticamente'); assert.equal(autoPl.released_by,U.aud,'el responsable es auditor, nunca el picker');
 await as('aud');
 const pl=await one('SELECT public.wh_release_packing_list($1)',[task.id]);
 assert.equal(pl.id,autoPl.id,'clientes antiguos obtienen el documento generado sin duplicarlo');
 assert.match(pl.packing_list_number,/^PL-\d{4}-\d{6}$/); assert.equal(pl.version,1);
 const snap=await one('SELECT public.wh_print_packing_list($1)',[pl.id]);
 assert.ok(snap.lpns.every(l=>l.audit_status==='APROBADO'),'el documento automático contiene revisiones liberadas');
 assert.equal(snap.lpn_count,2); assert.equal(snap.package_count,3); assert.equal(Number(snap.total_weight_kg),76.5); assert.equal(snap.auditor_name,'aud'); assert.equal(snap.picker_name,'op1');
 st=(await one("SELECT public.wh_task_board('tareas',$1)",[task.id]))[0]; assert.equal(st.display_state,'LIBERADO');
 await as('op1'); let unrep=await one('SELECT public.wh_packing_lists_unreported()'); assert.equal(unrep.length,1); assert.equal(unrep[0].status,'LIBERADO');
 await fails('SELECT public.wh_packing_list_mark_reported($1,$2,$3)',['x'.repeat(40),pl.id,'LIBERADO'],/Clave/);
 await q('SELECT public.wh_packing_list_mark_reported($1,$2,$3)',[KEY,pl.id,'LIBERADO']);
 assert.equal((await one('SELECT public.wh_packing_lists_unreported()')).length,0);
 console.log('PASS: Packing List liberado con número, versión, totales, responsables; impresión solo de la versión vigente; reporte a TMS pendiente/enviado.');

 // 9. Cambio posterior invalida solo lo afectado y bloquea la versión anterior
 await as('sup');
 await q("SELECT public.wh_lpn_remove_package($1,'PKG-2',false,'Cliente cambió cantidad')",[lpn1.id]);
 assert.equal((await sys(`SELECT status FROM public.wh_packing_lists WHERE id='${pl.id}'`))[0].status,'REEMPLAZADO');
 assert.equal((await sys(`SELECT audit_status FROM public.wh_lpns WHERE id='${lpn1.id}'`))[0].audit_status,'PENDIENTE');
 assert.equal((await sys(`SELECT audit_status FROM public.wh_lpns WHERE id='${lpn3.id}'`))[0].audit_status,'APROBADO');
 await fails('SELECT public.wh_print_packing_list($1)',[pl.id],/reemplazada/);
 await as('op1'); unrep=await one('SELECT public.wh_packing_lists_unreported()'); assert.equal(unrep[0].status,'REEMPLAZADO','el reemplazo se vuelve a informar a TMS');
 await q('SELECT public.wh_consolidate_lpn($1,$2::text[])',[task.id,['PKG-2']]);
 await q("SELECT public.wh_task_action($1,'FINISH_PICKING')",[task.id]);
 await as('aud');
 for(const l of (await one('SELECT public.wh_task_lpns($1)',[task.id])).lpns.filter(l=>l.audit_status==='PENDIENTE')) await q("SELECT public.wh_audit_lpn($1,'APROBADO')",[l.id]);
 const pl2=await one('SELECT public.wh_release_packing_list($1)',[task.id]);
 assert.equal(pl2.packing_list_number,pl.packing_list_number); assert.equal(pl2.version,2);
 await db.exec('RESET ROLE; BEGIN'); await as('op1');
 await q("SELECT public.wh_task_action($1,'REOPEN_PICKING')",[task.id]);
 await q("SELECT public.wh_task_action($1,'FINISH_PICKING')",[task.id]);
 const fromPicker=await one('SELECT public.wh_task_lpns($1)',[task.id]);
 assert.ok(fromPicker.packing_lists.some(p=>p.status==='LIBERADO'),'finalizar Picking genera documento sin permiso de auditoría');
 assert.equal(fromPicker.packing_lists.find(p=>p.status==='LIBERADO').snapshot.auditor_name,'aud','conserva identidad del auditor');
 await db.exec('RESET ROLE; ROLLBACK'); await as('aud');
 assert.equal((await sys(`SELECT count(*)::int n FROM public.wh_packing_lists WHERE task_id='${task.id}'`))[0].n,2,'historial de versiones conservado');
 // Unidades de carga: los bultos del Packing List se reparten en UT1, UT2…; la carga valida la unidad de cada bulto.
 await as('sup');
 const ut1=await one('SELECT public.wh_load_unit_add($1)',[task.id]), ut2=await one("SELECT public.wh_load_unit_add($1,' abc 123 ')",[task.id]);
 assert.equal(ut1.label,'UT1'); assert.equal(ut2.label,'UT2'); assert.equal(ut2.plate,'ABC123','placa normalizada');
 await fails('SELECT public.wh_lpns_assign_unit($1,$2::uuid[],$3)',[task.id,[lpn3.id,REQ_CANCEL],ut1.id],/no pertenecen/);
 assert.equal((await sys(`SELECT load_unit_id FROM public.wh_lpns WHERE id='${lpn3.id}'`))[0].load_unit_id,null);
 await as('sup');
 await fails('SELECT public.wh_lpns_assign_unit($1,$2::uuid[],$3)',[task.id,[],ut1.id],/Seleccione al menos/);
 await q('SELECT public.wh_lpns_assign_unit($1,$2::uuid[],$3)',[task.id,[lpn1.id,lpn3.id],ut1.id]);
 await q('SELECT public.wh_lpns_assign_unit($1,$2::uuid[],$3)',[task.id,[lpn1.id,lpn3.id],null]);
 const load=(unit)=>`SELECT public.wh_record_scan($1,$2,'LOAD',gen_random_uuid(),${unit?`'{"load_unit_id":"${unit}"}'::jsonb`:"'{}'::jsonb"})`;
 await fails(load(ut1.id),[task.id,lpn3.lpn_code],/Asigne el bulto/);
 await q('SELECT public.wh_lpn_assign_unit($1,$2)',[lpn3.id,ut1.id]);
 await fails(load(null),[task.id,lpn3.lpn_code],/Seleccione la unidad/);
 await fails(load(ut2.id),[task.id,lpn3.lpn_code],/corresponde a UT1/);
 await fails(load(ut1.id),[task.id,lpn3.lpn_code],/despacho|Packing List/); // la unidad correcta sigue a las reglas de carga
 await q("SELECT public.wh_load_unit_set_plate($1,'xyz-987')",[ut1.id]);
 let units=await one('SELECT public.wh_task_load_units($1)',[task.id]);
 assert.equal(units[0].plate,'XYZ-987'); assert.equal(units[0].lpn_count,1); assert.deepEqual(units[0].lpn_ids,[lpn3.id]);
 await q('SELECT public.wh_load_unit_remove($1)',[ut2.id]);
 units=await one('SELECT public.wh_task_load_units($1)',[task.id]); assert.equal(units.length,1,'unidad sin carga eliminada');
 // Bulto con un paquete ya cargado (lectura por código de paquete): su unidad queda fija.
 await sys(`UPDATE public.wh_packages SET status='LOADED' WHERE package_code='PKG-3'`); await as('sup');
 await fails('SELECT public.wh_lpn_assign_unit($1,null)',[lpn3.id],/aún no cargados/);
 await fails('SELECT public.wh_load_unit_remove($1)',[ut1.id],/ya tiene bultos cargados/);
 assert.equal((await one('SELECT public.wh_task_load_units($1)',[task.id]))[0].loaded_count,1,'cuenta el bulto parcialmente cargado');
 await sys(`UPDATE public.wh_packages SET status='PACKED' WHERE package_code='PKG-3'`);
 // Sin permiso de carga no se valida ni se revela la unidad del bulto.
 await as('op1'); await fails(load(ut2.id),[task.id,lpn3.lpn_code],/Sin permiso para registrar/);
 await fails('SELECT public.wh_load_unit_add($1)',[task.id],/permiso/);
 await fails('SELECT public.wh_record_scan_core($1,$2,$3,gen_random_uuid())',[task.id,lpn3.lpn_code,'LOAD'],/permission denied|permiso/);
 console.log('PASS: unidades de carga UT1/UT2 con placa opcional; asignar bultos; la carga exige la unidad correcta del bulto.');
 await as('aud'); await q("SELECT public.wh_audit_lpn($1,'RECHAZADO','Rechazo tardío')",[lpn3.id]);
 assert.equal((await sys(`SELECT status FROM public.wh_packing_lists WHERE id='${pl2.id}'`))[0].status,'REEMPLAZADO','rechazar tras liberar invalida el Packing List');
 assert.equal((await sys(`SELECT load_unit_id FROM public.wh_lpns WHERE id='${lpn3.id}'`))[0].load_unit_id,null,'retirar liberación quita su asignación antes de cargar');
 await as('aud'); await q("SELECT public.wh_audit_lpn($1,'APROBADO')",[lpn3.id]);
 const regenerated=(await one('SELECT public.wh_task_lpns($1)',[task.id])).packing_lists.find(p=>p.status==='LIBERADO');
 assert.equal(regenerated.version,3,'volver a liberar el contenido genera una versión nueva automáticamente');
 assert.equal(regenerated.packing_list_number,pl.packing_list_number);
 console.log('PASS: un cambio posterior reemplaza la versión liberada, re-audita solo el LPN afectado y emite la versión 2.');

 // 10. Acceso anónimo bloqueado
 await db.exec('RESET ROLE; SET ROLE anon');
 for(const fn of ["public.wh_task_board('tareas')","public.wh_tms_sync_apply('x','[]')","public.wh_release_packing_list(gen_random_uuid())","public.wh_lpns_assign_unit(gen_random_uuid(),ARRAY[gen_random_uuid()],gen_random_uuid())","wms_private.refresh_packing_list(gen_random_uuid())","public.wh_refresh_packing_list(gen_random_uuid())"]){
  let denied=false;try{await db.query(`SELECT ${fn}`)}catch(e){denied=/permission denied/.test(e.message)}
  assert.ok(denied,`anon no debe ejecutar ${fn}`);
 }
 console.log('PASS: funciones del flujo bloqueadas para anónimos.');
 // 11. Tamaños de etiqueta configurables
 await as('op1');
 const kinds=Object.fromEntries((await q('SELECT s.kind,f.width_mm::float w,f.height_mm::float h FROM public.wh_label_settings s JOIN public.wh_label_formats f ON f.id=s.format_id')).map(r=>[r.kind,[r.w,r.h]]));
 assert.deepEqual(kinds,{PAQUETE:[152.4,101.6],LPN:[100,50]},'se conservan los tamaños actuales y el operario puede leerlos');
 assert.ok((await q("SELECT 1 FROM public.wh_label_formats WHERE name LIKE 'A4%'")).length===1,'incluye A4 y medidas Zebra');
 await fails("SELECT public.wh_label_format_save(NULL,'Rollo 4x1',101.6,25.4,203)",[],/supervisión/);
 await fails("UPDATE public.wh_label_formats SET width_mm=1",[],/permission|permiso/);
 await as('sup');
 await fails("SELECT public.wh_label_format_save(NULL,'Mini',5,5,203)",[],/rango/);
 const rollo=await one("SELECT public.wh_label_format_save(NULL,'Rollo 4x1',101.6,25.4,300)");
 await q("SELECT public.wh_label_setting_set('LPN',$1)",[rollo]);
 await fails("SELECT public.wh_label_format_save($1,'Rollo 4x1',101.6,25.4,300,false)",[rollo],/asigne otro/);
 const a4=(await q("SELECT id FROM public.wh_label_formats WHERE name LIKE 'A4%'"))[0].id;
 await q("SELECT public.wh_label_setting_set('LPN',$1)",[a4]);
 await q("SELECT public.wh_label_format_save($1,'Rollo 4x1',101.6,25.4,300,false)",[rollo]);
 await fails("SELECT public.wh_label_setting_set('LPN',$1)",[rollo],/no disponible/);
 await db.exec('RESET ROLE; SET ROLE anon');
 await fails('SELECT public.wh_label_setting_set($1,$2)',['LPN',a4],/permission|permiso/);
 console.log('PASS: tamaños de etiqueta: A4/A5/Zebra disponibles, solo supervisión configura, rango validado, no se desactiva un formato en uso.');

 // 13. Flujo con el TMS: estado por solicitud para la salida (misma regla del tablero), ruta asignada y corte.
 await db.exec('SET ROLE anon'); await fails('SELECT public.wh_tms_request_states()',[],/permission|permiso/);
 await as('op1');
 const states=Object.fromEntries((await one('SELECT public.wh_tms_request_states()')).map(s=>[s.transport_request_id,s]));
 const toTms={LIBERADO:'LIBERADO',OBSERVADO:'OBSERVADO',EN_AUDITORIA:'EN_AUDITORIA',EN_PICKING:'EN_PICKING',PENDIENTE:'PENDIENTE',PAUSED:'PAUSADO',CANCELLED:'CANCELADO'};
 for(const b of await one("SELECT public.wh_task_board('tareas')")) assert.equal(states[b.transport_request_id]?.status,toTms[b.display_state]||'PENDIENTE',`estado TMS = tablero (${b.request_number})`);
 assert.equal(states[REQ_CANCEL].status,'CANCELADO','la cancelada se informa');
 assert.ok(Object.values(states).every(s=>s.snapshot_at&&s.task_code),'foto con hora y tarea');
 const REQ_NEW='00000000-0000-0000-0000-00000000d009';
 const newRow=(extra)=>({id:REQ_NEW,request_number:'RT-000909',request_type:'DESPACHO',status:'ASIGNADA',site_code:'PRINCIPAL',client:{id:CL,business_name:'Fargoline SAC',ruc:'20111111111'},contract:{id:OT,code:'16544',type:'CONTRATO',client_id:CL},components:[],...extra});
 await q('SELECT public.wh_tms_sync_apply($1,$2::jsonb)',[KEY,JSON.stringify([newRow({dispatch:{number:'R-0909',vehicle_plate:' xyz 789 ',driver_name:'Juan Pérez'},legacy_flow:false})])]);
 let nt=(await sys(`SELECT id,status,tms_dispatch_number,tms_vehicle_plate,tms_driver_name FROM public.wh_tasks WHERE transport_request_id='${REQ_NEW}'`))[0];
 assert.deepEqual([nt.status,nt.tms_dispatch_number,nt.tms_vehicle_plate,nt.tms_driver_name],['PENDING','R-0909','XYZ789','Juan Pérez'],'asignada antes de liberar: la tarea sigue y recibe la ruta');
 await as('op1'); assert.equal((await one("SELECT public.wh_task_board('tareas',$1)",[nt.id]))[0].tms_vehicle_plate,'XYZ789');
 await db.exec(`RESET ROLE; UPDATE public.wh_tasks SET status='PICKING' WHERE id='${nt.id}'`); await as('sup');
 assert.equal((await one('SELECT public.wh_load_unit_add($1)',[nt.id])).plate,'XYZ789','la UT nueva toma la placa del TMS');
 assert.equal((await one("SELECT public.wh_load_unit_add($1,'AAA111')",[nt.id])).plate,'AAA111','una placa escrita manda');
 await db.exec(`RESET ROLE; UPDATE public.wh_tasks SET status='PENDING' WHERE id='${nt.id}'`); await as('op1');
 await q('SELECT public.wh_tms_sync_apply($1,$2::jsonb)',[KEY,JSON.stringify([newRow({legacy_flow:true})])]);
 nt=(await sys(`SELECT status,cancelled_reason,tms_vehicle_plate FROM public.wh_tasks WHERE transport_request_id='${REQ_NEW}'`))[0];
 assert.deepEqual([nt.status,nt.cancelled_reason,nt.tms_vehicle_plate],['CANCELLED','Solicitud asignada antes del flujo con WMS',null],'corte: asignada antes del flujo se cierra');
 await as('op1'); assert.equal((await one('SELECT public.wh_tms_request_states()')).find(s=>s.transport_request_id===REQ_NEW).status,'CANCELADO');
 // Informe sin tope: todas las activas siempre; las cerradas solo hasta que el TMS confirma la foto (no consumen cupo).
 const activeIds=(await sys("SELECT transport_request_id::text id FROM public.wh_tasks WHERE status NOT IN ('LOADED','RECONCILED','CANCELLED')")).map(r=>r.id);
 await db.exec(`RESET ROLE; INSERT INTO public.transport_requests(id,request_number,request_type,status,site_id) SELECT gen_random_uuid(),'RT-X'||g,'DESPACHO','CANCELADA',(SELECT id FROM public.sites LIMIT 1) FROM generate_series(1,2100) g;
   UPDATE public.wh_tasks SET status='CANCELLED' WHERE request_status='CANCELADA' AND status<>'CANCELLED';`); await as('op1');
 let all=await one('SELECT public.wh_tms_request_states()');
 assert.ok(activeIds.length>0 && activeIds.every(id=>all.some(s=>s.transport_request_id===id)),'2.100 cerradas recientes no dejan fuera a las activas');
 await fails('SELECT public.wh_tms_states_mark_sent($1,$2)',['x'.repeat(40),all[0].snapshot_at],/Clave/);
 await q('SELECT public.wh_tms_states_mark_sent($1,$2)',[KEY,all[0].snapshot_at]);
 all=await one('SELECT public.wh_tms_request_states()');
 assert.ok(activeIds.every(id=>all.some(s=>s.transport_request_id===id)),'activas siempre');
 assert.ok(!all.some(s=>s.status==='CANCELADO'),'cerradas ya confirmadas no se reenvían');
 // Cron del servidor (llave de servicio, sin usuario): mismas funciones; anónimo no.
 await db.exec("RESET ROLE; SET request.jwt.claim.sub=''; UPDATE public.wh_tms_sync_state SET last_run_at=now()-interval '1 hour'; SET ROLE service_role");
 assert.ok(Array.isArray(await one('SELECT public.wh_tms_sync_claim(false)')),'el cron toma el turno');
 assert.ok((await one('SELECT public.wh_tms_request_states()')).length>=activeIds.length,'el cron ve todas las sedes');
 await q('SELECT public.wh_tms_sync_apply($1,$2::jsonb)',[KEY,'[]']);
 await db.exec('RESET ROLE; SET ROLE anon');
 await fails('SELECT public.wh_tms_states_mark_sent($1,now())',[KEY],/permission|permiso/);
 await db.exec('RESET ROLE; SET ROLE authenticated');
 await fails('SELECT public.wh_tms_sync_claim(false)',[],/almacén|Sesión/);
 console.log('PASS: estados para la salida en el TMS (= tablero), sin tope y con confirmación, cron con llave de servicio, ruta y placa del TMS, corte.');
 // 14. Historial de Picking: 'historial' suma las cerradas del rango (fecha requerida o, sin ella, de cierre); 'tareas' no cambia.
 await db.exec(`RESET ROLE; UPDATE public.transport_requests SET required_at=NULL, required_date=NULL WHERE id='${REQ_NEW}';
   ALTER TABLE public.wh_tasks DISABLE TRIGGER USER; UPDATE public.wh_tasks SET updated_at=now()-interval '40 days', updated_by='${U.sup}' WHERE transport_request_id='${REQ_NEW}'; ALTER TABLE public.wh_tasks ENABLE TRIGGER USER`);
 await db.exec("SET request.jwt.claim.sub=''"); await as('op1');
 const lima=d=>new Date(Date.now()+d*864e5).toLocaleDateString('en-CA',{timeZone:'America/Lima'});
 const active=await one("SELECT public.wh_task_board('tareas')");
 assert.ok(active.every(b=>!['LOADED','RECONCILED','CANCELLED'].includes(b.status)),'tareas sigue sin cerradas');
 const hoy=await one("SELECT public.wh_task_board('historial',NULL,$1,$1)",[lima(0)]);
 assert.ok(active.every(b=>hoy.some(h=>h.id===b.id)),'el historial incluye todas las activas');
 assert.ok(!hoy.some(h=>h.transport_request_id===REQ_NEW),'cerrada fuera del rango no aparece');
 const mes=await one("SELECT public.wh_task_board('historial',NULL,$1,$2)",[lima(-45),lima(-30)]);
 const closed=mes.find(h=>h.transport_request_id===REQ_NEW);
 assert.equal(closed?.cancelled_reason,'Solicitud asignada antes del flujo con WMS','sin fecha requerida usa la de cierre y trae el motivo');
 assert.ok(closed.closed_at&&closed.closed_by_name,'informa cuándo y quién la cerró');
 assert.ok(mes.findIndex(h=>h.closed_at)>=mes.filter(h=>!h.closed_at).length,'activas primero');
 assert.equal((await one("SELECT public.wh_task_board('historial',NULL,'2000-01-01',$1)",[lima(-60)])).filter(h=>h.closed_at).length,0,'rango acotado');
 await db.exec('RESET ROLE; SET ROLE anon'); await fails("SELECT public.wh_task_board('historial')",[],/permission denied/);
 console.log('PASS: historial de Picking: activas + cerradas del período (fecha requerida o de cierre), con motivo y responsable del cierre.');
 await db.close();
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1)});
