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
 for(const [u,id] of Object.entries(U)){ if(u==='admin')continue; sql+=`INSERT INTO auth.users VALUES('${id}'); INSERT INTO public.profiles(id,email,first_name,role_id,is_active) SELECT '${id}','${u}@x.pe','${u}',id,true FROM public.roles WHERE name='${userRole[u]}'; INSERT INTO public.user_site_access SELECT '${id}',id FROM public.sites;`; }
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
 assert.ok(lpn1.lpn_code.startsWith('LPN-')&&!lpn1.own_label,'varios paquetes: LPN nuevo con etiqueta');
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
 assert.ok(mixed.lpn_code.startsWith('LPN-')&&!mixed.own_label,'varios paquetes generan LPN nuevo');
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
 await as('sup'); await fails("SELECT public.wh_task_action($1,'LOAD')",[task.id],/Packing List no está liberado/);
 console.log('PASS: no se libera con observaciones o pendientes; corrección y nueva revisión solo del LPN cambiado; carga bloqueada sin Packing List.');

 // 8. Liberación, impresión y versión
 await as('aud');
 const pl=await one('SELECT public.wh_release_packing_list($1)',[task.id]);
 assert.match(pl.packing_list_number,/^PL-\d{4}-\d{6}$/); assert.equal(pl.version,1);
 const snap=await one('SELECT public.wh_print_packing_list($1)',[pl.id]);
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
 assert.equal((await sys(`SELECT count(*)::int n FROM public.wh_packing_lists WHERE task_id='${task.id}'`))[0].n,2,'historial de versiones conservado');
 await as('sup'); await fails("SELECT public.wh_record_scan($1,$2,'LOAD',gen_random_uuid())",[task.id,lpn3.lpn_code],/despacho|Packing List/);
 await as('aud'); await q("SELECT public.wh_audit_lpn($1,'RECHAZADO','Rechazo tardío')",[lpn3.id]);
 assert.equal((await sys(`SELECT status FROM public.wh_packing_lists WHERE id='${pl2.id}'`))[0].status,'REEMPLAZADO','rechazar tras liberar invalida el Packing List');
 console.log('PASS: un cambio posterior reemplaza la versión liberada, re-audita solo el LPN afectado y emite la versión 2.');

 // 10. Acceso anónimo bloqueado
 await db.exec('RESET ROLE; SET ROLE anon');
 for(const fn of ["public.wh_task_board('tareas')","public.wh_tms_sync_apply('x','[]')","public.wh_release_packing_list(gen_random_uuid())"]){
  let denied=false;try{await db.query(`SELECT ${fn}`)}catch(e){denied=/permission denied/.test(e.message)}
  assert.ok(denied,`anon no debe ejecutar ${fn}`);
 }
 console.log('PASS: funciones del flujo bloqueadas para anónimos.');
 await db.close();
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1)});
