// Fase 4: liberación a nombre del sistema, excepciones (solo menores, autorizadas por Jefatura, vencen y se revocan),
// carga parcial y cierre con saldo real. Corre sobre las migraciones reales de wms-db en PGlite.
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
 await sys(pkg('P1',10,400)+pkg('P2',10,800));
 const L=(await sys(`INSERT INTO public.wh_lpns(lpn_code,site_id,task_id,status,created_by,closed_by,package_count,quantity) SELECT 'LPN-X1',id,'${task}','CLOSED','${U.op}','${U.op}',2,20 FROM public.sites RETURNING id`))[0].id;
 await sys(`UPDATE public.wh_packages SET lpn_id='${L}' WHERE task_id='${task}'`);
 const J=x=>JSON.stringify(x);
 const lpnStatus=async()=>(await sys(`SELECT audit_status FROM public.wh_lpns WHERE id='${L}'`))[0].audit_status;
 const exc=async id=>(await sys(`SELECT * FROM public.wh_finding_exceptions WHERE id=${id}`))[0];
 const plStatus=async()=>(await sys(`SELECT status, released_by, snapshot->>'released_by' AS rb FROM public.wh_packing_lists WHERE task_id='${task}' ORDER BY version DESC LIMIT 1`))[0];
 const future=new Date(Date.now()+86400000).toISOString();

 // 1. Solo hallazgos menores admiten excepción
 await as('aud');
 const fMayor=(await one(`SELECT public.wh_finding_create('${L}',ARRAY['FALTANTE'],'MAYOR','Faltan dos unidades',$1::jsonb)`,[J([{package_code:'P2',quantity:2}])])).id;
 const fMenor=(await one(`SELECT public.wh_finding_create('${L}',ARRAY['ROTULADO'],'MENOR','Etiqueta corrida',$1::jsonb)`,[J([{package_code:'P1',quantity:10}])])).id;
 await as('op'); await fails(`SELECT public.wh_exception_request('${fMayor}','Cliente acepta así el despacho',$1)`,[future],/no admite excepción/);
 await fails(`SELECT public.wh_exception_request('${fMenor}','Cliente acepta así el despacho',now()+interval '40 days')`,[],/hasta 30 días/);
 const e1=(await one(`SELECT public.wh_exception_request('${fMenor}','Cliente acepta la etiqueta corrida',$1)`,[future])).id;
 await fails(`SELECT public.wh_exception_request('${fMenor}','Otra solicitud duplicada',$1)`,[future],/pendiente o vigente/);
 console.log('PASS: solo hallazgos menores admiten excepción, con vigencia de hasta 30 días y una a la vez.');

 // 2. Autoriza Jefatura, nunca quien pidió ni quien preparó
 await sys(`UPDATE public.roles SET permissions='["almacen-picking","almacen-supervisor"]' WHERE name='op'`);
 await as('op'); await fails(`SELECT public.wh_exception_decide(${e1},'APPROVE')`,[],/solicitó|preparó/);
 await sys(`UPDATE public.roles SET permissions='["almacen-picking"]' WHERE name='op'`);
 await as('aud'); await fails(`SELECT public.wh_exception_decide(${e1},'APPROVE')`,[],/Solo Jefatura/);
 await as('sup'); await q(`SELECT public.wh_exception_decide(${e1},'APPROVE','Autorizado por Jefatura')`);
 assert.equal((await exc(e1)).status,'APROBADA');
 console.log('PASS: la excepción la autoriza supervisión; nadie autoriza la suya ni la de un LPN que preparó.');

 // 3. Con el mayor abierto no se aprueba; corregido y verificado, el menor con excepción no bloquea
 await as('aud2'); await fails(`SELECT public.wh_audit_lpn('${L}','APROBADO')`,[],/hallazgos sin cerrar/);
 await as('op'); await q(`SELECT public.wh_finding_action('${fMayor}','CORRECTED','Se completaron las unidades')`);
 await as('aud2'); await q(`SELECT public.wh_finding_action('${fMayor}','VERIFY_OK')`);
 await as('op'); await q(`SELECT public.wh_task_action('${task}','FINISH_PICKING')`);
 await as('aud2'); await q(`SELECT public.wh_audit_lpn('${L}','APROBADO')`);
 assert.equal(await lpnStatus(),'APROBADO');
 let pl=await plStatus(); assert.equal(pl.status,'LIBERADO');assert.equal(pl.released_by,null);assert.equal(pl.rb,'Sistema (liberación automática)');
 console.log('PASS: con excepción vigente el hallazgo menor no bloquea; la liberación automática queda a nombre del sistema.');

 // 4. Revocar deja el LPN observado y sin efecto la liberación; vencer igual
 await as('sup'); await fails(`SELECT public.wh_exception_decide(${e1},'REVOKE')`,[],/motivo de la revocación/);
 await q(`SELECT public.wh_exception_decide(${e1},'REVOKE','El cliente ya no acepta')`);
 assert.equal(await lpnStatus(),'OBSERVADO'); assert.equal((await plStatus()).status,'REEMPLAZADO');
 await as('op'); const e2=(await one(`SELECT public.wh_exception_request('${fMenor}','Cliente vuelve a aceptar la etiqueta',$1)`,[future])).id;
 await as('sup'); await q(`SELECT public.wh_exception_decide(${e2},'APPROVE')`);
 await as('aud2'); await q(`SELECT public.wh_audit_lpn('${L}','APROBADO')`);
 assert.equal((await plStatus()).status,'LIBERADO');
 await sys(`UPDATE public.wh_finding_exceptions SET valid_until=now()-interval '1 minute' WHERE id=${e2}`);
 assert.equal(Number((await sys(`SELECT wms_private.wh_exceptions_expire() AS n`))[0].n),1);
 assert.equal((await exc(e2)).status,'VENCIDA'); assert.equal(await lpnStatus(),'OBSERVADO'); assert.equal((await plStatus()).status,'REEMPLAZADO');
 console.log('PASS: revocada o vencida, la excepción deja el LPN observado y la liberación sin efecto.');

 // 5. Carga parcial con paquetes pendientes y cierre con saldo real
 await as('op'); await q(`SELECT public.wh_finding_action('${fMenor}','CORRECTED','Reetiquetado')`);
 await as('aud2'); await q(`SELECT public.wh_finding_action('${fMenor}','VERIFY_OK')`); await q(`SELECT public.wh_audit_lpn('${L}','APROBADO')`);
 assert.equal((await plStatus()).status,'LIBERADO');
 await sys(`UPDATE public.wh_packages SET status='LOADED' WHERE package_code='P1'`);
 await as('sup'); await fails(`SELECT public.wh_task_action('${task}','LOAD')`,[],/escanee todos/);
 await q(`SELECT public.wh_task_action('${task}','LOAD_PARTIAL','Unidad llena; P2 sale mañana')`);
 const t=(await sys(`SELECT status, close_summary FROM public.wh_tasks WHERE id='${task}'`))[0];
 assert.equal(t.status,'PARTIAL');
 assert.deepEqual([t.close_summary.tipo,t.close_summary.paquetes_cargados,t.close_summary.paquetes_preparados,Number(t.close_summary.kg_cargado),Number(t.close_summary.kg_pendiente)],['PARCIAL',1,2,400,800]);
 console.log('PASS: carga parcial con motivo cuando quedan paquetes; el cierre guarda lo cargado y lo pendiente reales.');
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1)});
