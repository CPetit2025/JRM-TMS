// LPN de recepción sobre la base WMS real (migraciones de wms-db en PGlite): consolidar líneas validadas del mismo
// cliente y OT, numeración por lote, sin etiquetas individuales, picking del LPN entero y deshacer con motivo.
const {PGlite}=require('@electric-sql/pglite');
const fs=require('fs');const path=require('node:path');const assert=require('node:assert/strict');
const U={etq:'00000000-0000-0000-0000-0000000000b1',op:'00000000-0000-0000-0000-0000000000b2',sup:'00000000-0000-0000-0000-0000000000b3'};
const OT='00000000-0000-0000-0000-00000000c573',CL='00000000-0000-0000-0000-00000000c100',REQ='00000000-0000-0000-0000-00000000d573';
(async()=>{
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE TABLE auth.users(id uuid primary key); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE SQL STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role; GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC; CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$;`);
 const dir=path.join(__dirname,'../wms-db/supabase/migrations');
 for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir,f),'utf8'));
 const roles={etq:['almacen-etiquetado'],op:['almacen-picking'],sup:['almacen-supervisor']};
 let sql="DELETE FROM public.roles; DELETE FROM public.sites; INSERT INTO public.sites(code,name) VALUES('PRINCIPAL','Local');";
 for(const [k,p] of Object.entries(roles)) sql+=`INSERT INTO public.roles(name,permissions) VALUES('${k}','${JSON.stringify(p)}');`;
 for(const [u,id] of Object.entries(U)) sql+=`INSERT INTO auth.users VALUES('${id}'); INSERT INTO public.profiles(id,email,first_name,role_id,is_active) SELECT '${id}','${u}@x.pe','${u}',id,true FROM public.roles WHERE name='${u}'; INSERT INTO public.user_site_access SELECT '${id}',id FROM public.sites ON CONFLICT DO NOTHING;`;
 // Líneas del IPT-9 (OT 16573) y otra OT; R6 ya tiene etiqueta individual del lote 16573 (B-0001). R8 y R9 son ítems distintos del contrato (sufijos -022/-024) de la misma OT 16573.
 const src=[['R1','P-A','16573','16573',10,100,'Fargoline SAC'],['R2','P-B','16574','16573',5,20,'Fargoline SAC'],['R3','P-C','16573','16573',4,null,'Fargoline SAC'],
  ['R4','P-D','99999','99999',3,null,'Fargoline SAC'],['R5','P-E','16573','16573',2,null,'Otro cliente'],['R6','P-F','16573','16573',1,null,'Fargoline SAC'],
  ['R8','P-H','16573','16573-S002-022',6,null,'Fargoline SAC'],['R9','P-I','16573','16573-S002-024',7,null,'Fargoline SAC']];
 sql+='SET session_replication_role=replica;'; // fuente cargada directa, sin corrida de importación
 for(const [k,p,lot,ot,qty,kg,cust] of src) sql+=`INSERT INTO public.wh_receipt_sources(source_key,site_id,document_no,source_date,warehouse,customer_name,product_code,description,quantity,unit,lot,contract_code,total_weight,source_import_hash) SELECT '${k}',id,'IPT-9','2026-11-11','APT','${cust}','${p}','Producto ${p}',${qty},'UND','${lot}','${ot}',${kg??'NULL'},'h' FROM public.sites;`;
 await db.exec(sql+'SET session_replication_role=origin;');
 const KEY='k'.repeat(40);
 await db.exec(`UPDATE public.wh_tms_sync_state SET key_hash=encode(sha256(convert_to('${KEY}','UTF8')),'hex')`);
 const as=async u=>db.exec(`RESET ROLE; SET request.jwt.claim.sub='${U[u]}'; SET ROLE authenticated;`);
 const q=async(s,p=[])=>(await db.query(s,p)).rows;
 const one=async(s,p=[])=>Object.values((await q(s,p))[0]||{})[0];
 const fails=async(s,p,re)=>{try{await db.query(s,p)}catch(e){if(re&&!re.test(e.message))throw Error(`Mensaje inesperado: ${e.message}`);return e.message}throw Error(`Debía fallar: ${s}`)};
 const sys=async s=>{await db.exec('RESET ROLE');return (await db.query(s)).rows};
 const consolidate=(keys,ev=null)=>one('SELECT public.wh_receipt_consolidate_lpn($1::text[],$2::uuid)',[keys,ev]);

 await as('etq');
 for(const [k,,,,qty] of src) if(k!=='R3') await q('SELECT public.wh_validate_receipt($1,$2,null,null)',[k,qty]);
 assert.deepEqual((await one('SELECT public.wh_label_package($1,1)',['R6'])).package_codes,['16573-B-0001']);

 // 1. Reglas del servidor: solo validadas sin etiquetar, mismo cliente y OT, 2+ líneas, permiso
 await fails('SELECT public.wh_receipt_consolidate_lpn($1::text[])',[['R1']],/entre 2 y 100/);
 await fails('SELECT public.wh_receipt_consolidate_lpn($1::text[])',[['R1','R1']],/entre 2 y 100/);
 await fails('SELECT public.wh_receipt_consolidate_lpn($1::text[])',[['R3','R1']],/no está validada/);
 await fails('SELECT public.wh_receipt_consolidate_lpn($1::text[])',[['R8','R6']],/ya tiene etiquetas/);
 await fails('SELECT public.wh_receipt_consolidate_lpn($1::text[])',[['R8','R4']],/misma OT/);
 await fails('SELECT public.wh_receipt_consolidate_lpn($1::text[])',[['R8','R5']],/mismo cliente/);
 await as('op'); await fails('SELECT public.wh_receipt_consolidate_lpn($1::text[])',[['R1','R2']],/Sin permiso/);
 assert.equal((await sys("SELECT count(*)::int n FROM public.wh_lpns"))[0].n,0,'los intentos rechazados no dejan LPN');
 console.log('PASS: solo líneas validadas, sin etiquetar, del mismo cliente y OT; 2 o más; con permiso de etiquetado.');

 // 2. Crear: LPN con el siguiente número del lote de la primera línea; cada línea con su paquete
 await as('etq');
 const ev='22222222-2222-2222-2222-222222222222';
 const lpn=await consolidate(['R1','R2'],ev);
 assert.equal(lpn.lpn_code,'16573-B-0002','el LPN toma el siguiente número del lote de la primera línea (los rechazos no consumieron números)');
 assert.equal(lpn.origin,'RECEPCION'); assert.equal(lpn.status,'CLOSED'); assert.equal(lpn.task_id,null);
 assert.equal(lpn.package_count,2); assert.equal(Number(lpn.quantity),15); assert.equal(Number(lpn.weight_kg),120);
 assert.deepEqual(lpn.packages.map(p=>[p.package_code,p.receipt_key,Number(p.quantity)]),[['16573-B-0003','R1',10],['16574-B-0001','R2',5]]);
 assert.equal((await consolidate(['R1','R2'],ev)).id,lpn.id,'reintento devuelve el mismo LPN');
 await fails('SELECT public.wh_receipt_consolidate_lpn($1::text[])',[['R1','R8']],/ya tiene etiquetas o LPN/);
 const pk=await sys(`SELECT package_code,status,label_print_count,lpn_id FROM public.wh_packages WHERE lpn_id='${lpn.id}' ORDER BY 1`);
 assert.ok(pk.every(p=>p.status==='AVAILABLE'&&p.label_print_count===0));
 assert.equal((await sys(`SELECT count(*)::int n FROM public.wh_scan_events WHERE lpn_id='${lpn.id}' AND event_type='RECEIPT_LPN_CONSOLIDATE'`))[0].n,1,'auditoría de la consolidación');
 console.log('PASS: LPN 16573-B-0002 (lote de la primera línea), paquetes por línea 16573-B-0003 / 16574-B-0001, totales, idempotente y auditado.');

 // 3. Sin etiquetas individuales: solo la del LPN; la bandeja lo pide como LPN
 await fails('SELECT public.wh_print_labels($1::text[])',[['16573-B-0003']],/consolidado en el LPN 16573-B-0002/);
 await fails("SELECT public.wh_reprint_label($1,'x')",['16574-B-0001'],/LPN 16573-B-0002/);
 await fails('SELECT public.wh_label_package($1,1)',['R1'],/consolidada en el LPN/);
 let tray=await one("SELECT public.wh_receipt_candidates('IPT-9')");
 const r1=tray.find(r=>r.receipt_key==='R1');
 assert.equal(r1.label_status,'PENDING_PRINT'); assert.equal(r1.pending_labels[0].lpn_code,'16573-B-0002');
 assert.equal(await one('SELECT public.wh_lpn_detail($1)',['16574-B-0001']).then(d=>d.lpn_code),'16573-B-0002','detalle por código de paquete');
 await q('SELECT public.wh_print_lpn_label($1)',[lpn.id]);
 await fails("SELECT public.wh_reprint_lpn_label($1,'')",[lpn.lpn_code],/motivo/);
 assert.equal((await one("SELECT public.wh_reprint_lpn_label($1,'Etiqueta dañada')",[lpn.lpn_code])).print_count,2);
 tray=await one("SELECT public.wh_receipt_candidates('IPT-9')");
 assert.ok(!tray.some(r=>['R1','R2'].includes(r.receipt_key)),'impreso el LPN, sus líneas salen de la bandeja');
 assert.equal((await one("SELECT public.wh_receipt_candidates_all('IPT-9')")).find(r=>r.receipt_key==='R1').label_status,'MATCH');
 console.log('PASS: líneas no imprimibles sueltas; etiqueta y reimpresión del LPN con etiquetado; la bandeja las cierra al imprimir el LPN.');

 // 4. Picking: el LPN se recoge entero; un paquete suyo no se toma suelto
 await as('op');
 await q('SELECT public.wh_tms_sync_apply($1,$2::jsonb)',[KEY,JSON.stringify([{id:REQ,request_number:'RT-000573',request_type:'DESPACHO',status:'APROBADA',site_code:'PRINCIPAL',delivery_address:'Lima',client:{id:CL,business_name:'Fargoline SAC',ruc:'20111111111'},contract:{id:OT,code:'16573',type:'CONTRATO',client_id:CL},components:[]}])]);
 const task=(await sys(`SELECT id FROM public.wh_tasks WHERE transport_request_id='${REQ}'`))[0].id;
 await sys(`UPDATE public.wh_packages SET contract_id='${OT}' WHERE source_contract_code='16573'`);
 await as('op'); await q('SELECT public.wh_assign_task($1)',[task]); await q("SELECT public.wh_task_action($1,'START_PICKING')",[task]);
 await fails("SELECT public.wh_record_scan($1,'16573-B-0003','PICK',gen_random_uuid())",[task],/forma parte del LPN de recepción 16573-B-0002/);
 await fails('SELECT public.wh_lpn_remove_package($1,$2,true,$3)',[lpn.id,'16573-B-0003','x'],/no está en una tarea/);
 await fails("SELECT public.wh_lpn_undo($1,'x')",[lpn.id],/permiso/);
 const pev='33333333-3333-3333-3333-333333333333';
 const picked=await one("SELECT public.wh_record_scan($1,$2,'PICK',$3)",[task,lpn.lpn_code,pev]);
 assert.equal(picked.packages_picked,2);
 assert.equal((await one("SELECT public.wh_record_scan($1,$2,'PICK',$3)",[task,lpn.lpn_code,pev])).duplicate_retry,true);
 await fails("SELECT public.wh_record_scan($1,$2,'PICK',gen_random_uuid())",[task,lpn.lpn_code],/no está disponible para picking/);
 const tl=await one('SELECT public.wh_task_lpns($1)',[task]);
 assert.equal(tl.lpns.length,1); assert.equal(tl.lpns[0].lpn_code,'16573-B-0002'); assert.equal(tl.loose.length,0,'nada queda suelto por consolidar');
 assert.ok((await sys(`SELECT status FROM public.wh_packages WHERE lpn_id='${lpn.id}'`)).every(p=>p.status==='PACKED'));
 await fails('SELECT public.wh_consolidate_lpn($1,$2::text[])',[task,['16573-B-0003']],/ya está en el LPN/);
 console.log('PASS: picking del LPN entero por su etiqueta (idempotente); paquete suelto rechazado; no se re-consolida en otro LPN.');

 // 5. Deshacer: en la tarea vuelve a paquetes recogidos; las líneas vuelven a la bandeja para su etiqueta individual
 await fails("SELECT public.wh_lpn_undo($1,' ')",[lpn.id],/motivo/);
 await q("SELECT public.wh_lpn_undo($1,'Separar por destino')",[lpn.id]);
 assert.equal((await sys(`SELECT status FROM public.wh_lpns WHERE id='${lpn.id}'`))[0].status,'VOID');
 assert.equal((await one('SELECT public.wh_task_lpns($1)',[task])).loose.length,2);
 await as('etq');
 tray=await one("SELECT public.wh_receipt_candidates('IPT-9')");
 assert.equal(tray.find(r=>r.receipt_key==='R1').pending_labels[0].lpn_code,null,'la línea separada pide su etiqueta individual');
 await q('SELECT public.wh_print_labels($1::text[])',[['16573-B-0003','16574-B-0001']]);
 // En recepción (sin tarea): etiquetado deshace con motivo y las líneas quedan en stock sin LPN
 const lpn2=await consolidate(['R8','R9']);
 assert.equal(lpn2.lpn_code,'16573-B-0004'); assert.deepEqual(lpn2.packages.map(p=>p.package_code),['16573-B-0005','16573-B-0006']);
 await q("SELECT public.wh_lpn_undo($1,'Se arma en dos pallets')",[lpn2.id]);
 assert.deepEqual(await sys(`SELECT status,lpn_id FROM public.wh_packages WHERE source_movement_key IN ('R8','R9') ORDER BY 1`),[{status:'AVAILABLE',lpn_id:null},{status:'AVAILABLE',lpn_id:null}]);
 assert.equal((await sys(`SELECT status,void_reason FROM public.wh_lpns WHERE id='${lpn2.id}'`))[0].void_reason,'Se arma en dos pallets');
 await q('SELECT public.wh_print_labels($1::text[])',[['16573-B-0005']]);
 console.log('PASS: deshacer con motivo libera las líneas (en la tarea quedan recogidas; en recepción, en stock) y habilita sus etiquetas individuales.');
})().catch(e=>{console.error('FAIL:',e.message);process.exitCode=1});
