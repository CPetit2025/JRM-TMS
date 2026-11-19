// Fase 3: hallazgos sobre el LPN con alcance y masa, corrección, verificación, reapertura y separación de funciones por
// persona. Corre sobre las migraciones reales de wms-db en PGlite, sin credenciales.
const {PGlite}=require('@electric-sql/pglite');
const fs=require('fs');const path=require('node:path');const assert=require('node:assert/strict');
const U={op:'00000000-0000-0000-0000-0000000000b1',pack:'00000000-0000-0000-0000-0000000000b2',sup:'00000000-0000-0000-0000-0000000000b3',lect:'00000000-0000-0000-0000-0000000000b4',nada:'00000000-0000-0000-0000-0000000000b5',op2:'00000000-0000-0000-0000-0000000000b6',baja:'00000000-0000-0000-0000-0000000000b7',aud:'00000000-0000-0000-0000-0000000000b8',aud2:'00000000-0000-0000-0000-0000000000b9'};
const OT='00000000-0000-0000-0000-00000000c001',CL='00000000-0000-0000-0000-00000000c100',REQ='00000000-0000-0000-0000-00000000d001';
const feed=[{id:REQ,request_number:'RT-000901',request_type:'DESPACHO',status:'APROBADA',site_code:'PRINCIPAL',delivery_address:'Lima',client:{id:CL,business_name:'Fargoline SAC',ruc:'20111111111'},contract:{id:OT,code:'16544',type:'CONTRATO',client_id:CL},components:[]}];
(async()=>{
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE TABLE auth.users(id uuid primary key); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE SQL STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role; GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC; CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$;`);
 const dir=path.join(__dirname,'../wms-db/supabase/migrations');
 for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir,f),'utf8'));
 const roles={op:['almacen-picking'],pack:['almacen-packing'],sup:['almacen-supervisor'],lect:['almacen-lectura'],nada:[],op2:['almacen-picking'],baja:['almacen-picking'],aud:['almacen-auditoria'],aud2:['almacen-auditoria']};
 let sql="DELETE FROM public.roles; DELETE FROM public.sites; INSERT INTO public.sites(code,name) VALUES('PRINCIPAL','Local');";
 for(const [k,p] of Object.entries(roles)) sql+=`INSERT INTO public.roles(name,permissions) VALUES('${k}','${JSON.stringify(p)}');`;
 for(const [u,id] of Object.entries(U)) sql+=`INSERT INTO auth.users VALUES('${id}'); INSERT INTO public.profiles(id,email,first_name,role_id,is_active) SELECT '${id}','${u}@x.pe','${u}',id,true FROM public.roles WHERE name='${u}'; INSERT INTO public.user_site_access SELECT '${id}',id FROM public.sites ON CONFLICT DO NOTHING;`;
 await db.exec(sql);
 const KEY='k'.repeat(40);
 await db.exec(`UPDATE public.wh_tms_sync_state SET key_hash=encode(sha256(convert_to('${KEY}','UTF8')),'hex')`);
 const as=async u=>db.exec(`RESET ROLE; SET request.jwt.claim.sub='${U[u]}'; SET ROLE authenticated;`);
 const q=async(s,p=[])=>(await db.query(s,p)).rows;
 const one=async(s,p=[])=>Object.values((await q(s,p))[0]||{})[0];
 const fails=async(s,p,re)=>{try{await db.query(s,p)}catch(e){if(re&&!re.test(e.message))throw Error(`Mensaje inesperado: ${e.message}`);return e.message}throw Error(`Debía fallar: ${s}`)};
 const sys=async s=>{await db.exec('RESET ROLE');const r=await db.exec(s);return r[r.length-1].rows};

 // Tarea desde el feed del TMS y paquetes recibidos (ERP) con distintos casos de peso
 await as('op');
 await q('SELECT public.wh_tms_sync_apply($1,$2::jsonb)',[KEY,JSON.stringify(feed)]);
 const task=(await sys(`SELECT id FROM public.wh_tasks WHERE transport_request_id='${REQ}'`))[0].id;
 await sys(`UPDATE public.wh_tasks SET status='PACKING', assigned_picker='${U.op}' WHERE id='${task}'`);
 const pkg=(code,qty,kg)=>`INSERT INTO public.wh_packages(package_code,source_document_no,source_contract_code,source_lot,source_product_code,source_warehouse,source_date,source_movement_key,source_key,site_id,description,quantity,unit,weight_kg,task_id,status) SELECT '${code}','IPT-1','16544-S001-001','16544-S001','PRD-A','APT','2026-11-07','mk-${code}','sk-${code}',id,'Paquete',${qty},'UN',${kg===null?'NULL':kg},'${task}','PACKED' FROM public.sites;`;
 await sys(pkg('P1',10,400)+pkg('P2',10,800)+pkg('P3',4,null));
 const L=(await sys(`INSERT INTO public.wh_lpns(lpn_code,site_id,task_id,status,created_by,closed_by) SELECT 'LPN-H1',id,'${task}','CLOSED','${U.op}','${U.op}' FROM public.sites RETURNING id`))[0].id;
 await sys(`UPDATE public.wh_packages SET lpn_id='${L}' WHERE task_id='${task}'`);
 const get=async id=>(await one(`SELECT public.wh_findings_list('${task}')`)).find(f=>f.id===id);
 const lpnStatus=async()=>(await sys(`SELECT audit_status FROM public.wh_lpns WHERE id='${L}'`))[0].audit_status;
 const J=x=>JSON.stringify(x);

 // 1. Solo auditoría registra; quien preparó no audita ni aprueba (sin excepción de supervisión)
 await as('op'); await fails(`SELECT public.wh_finding_create('${L}',ARRAY['CALIDAD'],'MENOR','Golpe en esquina')`,[],/Solo auditoría/);
 await sys(`UPDATE public.roles SET permissions='["almacen-picking","almacen-supervisor"]' WHERE name='op'`);
 await as('op'); await fails(`SELECT public.wh_audit_lpn('${L}','APROBADO',NULL,NULL,'{}','Lo reviso yo mismo')`,[],/Nadie aprueba un LPN que preparó/);
 await fails(`SELECT public.wh_finding_create('${L}',ARRAY['CALIDAD'],'MENOR','Golpe en esquina')`,[],/usted preparó/);
 await sys(`UPDATE public.roles SET permissions='["almacen-picking"]' WHERE name='op'`);
 console.log('PASS: solo auditoría registra hallazgos; quien preparó no audita ni aprueba, ni con supervisión.');

 // 2. Alcance por paquete y masa: calidad + rotulado sobre los mismos 400 kg = 400 kg; faltante parcial; sin peso = pendiente
 await as('aud');
 await fails(`SELECT public.wh_finding_create('${L}',ARRAY['CALIDAD'],'MENOR','Golpe',$1::jsonb)`,[J([{package_code:'NO-EXISTE',quantity:1}])],/no pertenece|al menos un paquete/);
 await fails(`SELECT public.wh_finding_create('${L}',ARRAY['CALIDAD'],'MENOR','Golpe',$1::jsonb,'DESPACHO','${U.aud}')`,[J([{package_code:'P1',quantity:10}])],/no puede ser responsable/);
 const f1=(await one(`SELECT public.wh_finding_create('${L}',ARRAY['CALIDAD','ROTULADO','calidad'],'MENOR','Golpe y etiqueta ilegible',$1::jsonb,'DESPACHO','${U.op}')`,[J([{package_code:'P1',quantity:10}])])).id;
 let h=await get(f1);
 assert.deepEqual(h.categories.slice().sort(),['CALIDAD','ROTULADO']);assert.equal(h.exceptionable,true);assert.equal(Number(h.kg),400);assert.equal(h.lines.length,1);
 assert.equal(await lpnStatus(),'OBSERVADO');
 const f2=(await one(`SELECT public.wh_finding_create('${L}',ARRAY['FALTANTE'],'MAYOR','Faltan unidades',$1::jsonb)`,[J([{package_code:'P2',quantity:5},{package_code:'P3',quantity:4}])])).id;
 h=await get(f2); assert.equal(Number(h.kg),400);assert.equal(h.kg_sin_peso,1);assert.equal(h.exceptionable,false);
 console.log('PASS: alcance por paquete con masa proporcional; categorías sobre el mismo alcance no duplican masa; sin peso = pendiente.');

 // 3. Aprobar con hallazgos abiertos está prohibido
 await as('aud2'); await fails(`SELECT public.wh_audit_lpn('${L}','APROBADO')`,[],/hallazgos sin cerrar/);

 // 4. Corrección y verificación con separación por persona; verificación parcial
 await as('aud'); await fails(`SELECT public.wh_finding_action('${f1}','START')`,[],/Solo el responsable|no puede corregirlo/);
 await as('op2'); await fails(`SELECT public.wh_finding_action('${f1}','START')`,[],/Solo el responsable/);
 await as('op'); await q(`SELECT public.wh_finding_action('${f1}','START')`);
 await fails(`SELECT public.wh_finding_action('${f1}','CORRECTED')`,[],/Describa la corrección/);
 let hf=await get(f1); const line=hf.lines[0].id;
 await q(`SELECT public.wh_finding_action('${f1}','CORRECTED','Reetiquetado y cambio de caja',$1::jsonb)`,[J([{line_id:line,corrected_qty:10}])]);
 await fails(`SELECT public.wh_finding_action('${f1}','VERIFY_OK')`,[],/Solo auditoría verifica/);
 await sys(`UPDATE public.roles SET permissions='["almacen-picking","almacen-auditoria"]' WHERE name='op'`);
 await as('op'); await fails(`SELECT public.wh_finding_action('${f1}','VERIFY_OK')`,[],/propia corrección/);
 await sys(`UPDATE public.roles SET permissions='["almacen-picking"]' WHERE name='op'`);
 await as('aud2'); await q(`SELECT public.wh_finding_action('${f1}','VERIFY_OK',NULL,$1::jsonb)`,[J([{line_id:line,verified_qty:7}])]);
 hf=await get(f1); assert.equal(hf.status,'EN_CORRECCION','verificación parcial deja pendiente');assert.equal(Number(hf.kg_pendiente),120);
 await as('op'); await q(`SELECT public.wh_finding_action('${f1}','CORRECTED','Completado')`);
 await as('aud2'); await q(`SELECT public.wh_finding_action('${f1}','VERIFY_OK')`);
 hf=await get(f1); assert.equal(hf.status,'CERRADO');assert.equal(Number(hf.kg_pendiente),0);
 console.log('PASS: corrige el responsable, verifica otro auditor; el pendiente baja solo al verificar (parcial = pendiente).');

 // 5. Cerrar un hallazgo no aprueba el LPN; aprobar exige todo cerrado; reabrir vuelve a observar
 assert.equal(await lpnStatus(),'OBSERVADO');
 await as('aud2'); await fails(`SELECT public.wh_audit_lpn('${L}','APROBADO')`,[],/hallazgos sin cerrar/);
 await as('op'); await q(`SELECT public.wh_finding_action('${f2}','CORRECTED','Se completaron unidades')`);
 await as('aud'); await q(`SELECT public.wh_finding_action('${f2}','VERIFY_OK')`);
 await as('aud2'); await q(`SELECT public.wh_audit_lpn('${L}','APROBADO')`);
 assert.equal(await lpnStatus(),'APROBADO');
 await fails(`SELECT public.wh_finding_action('${f1}','REOPEN')`,[],/motivo de la reapertura/);
 await q(`SELECT public.wh_finding_action('${f1}','REOPEN','La etiqueta se volvió a despegar')`);
 assert.equal(await lpnStatus(),'OBSERVADO');
 hf=await get(f1); assert.equal(hf.status,'ABIERTO');assert.equal(hf.reopen_count,1);
 assert.deepEqual(hf.events.map(e=>e.action),['REGISTRAR','START','CORRECTED','VERIFY_OK','CORRECTED','VERIFY_OK','REOPEN']);
 console.log('PASS: cerrar no aprueba; aprobar exige todo cerrado; reabrir vuelve a observar el LPN; historial completo.');

 // 6. Historial inmutable y acceso
 await fails(`UPDATE public.wh_finding_events SET comment='x'`,[],/permission denied|inmutable|no se puede|historial/i);
 await as('nada'); await fails(`SELECT public.wh_findings_list('${task}')`,[],/Sin permiso/);
 await db.exec("RESET ROLE; SET request.jwt.claim.sub=''; SET ROLE anon;");
 await fails(`SELECT public.wh_finding_action('${f1}','COMMENT','x')`,[],/permission denied/i);
 await fails(`SELECT count(*) FROM public.wh_findings`,[],/permission denied/i);
 console.log('PASS: historial inmutable; anónimos y usuarios sin permiso bloqueados.');
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1)});
