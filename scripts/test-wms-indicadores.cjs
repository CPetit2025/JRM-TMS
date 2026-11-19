// Fase 5: modelo analítico de Despacho y Auditoría. Reproduce el ejemplo de la especificación (25 t auditadas,
// 1,2 t afectadas, 4,8 %), sin doble conteo, peso desconocido ≠ 0 y denominador 0 = no calculable. PGlite, sin credenciales.
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
 const pkg=(code,qty,kg,cc='16544-S001-001')=>`INSERT INTO public.wh_packages(package_code,source_document_no,source_contract_code,source_lot,source_product_code,source_warehouse,source_date,source_movement_key,source_key,site_id,description,quantity,unit,weight_kg,task_id,status) SELECT '${code}','IPT-1','${cc}','16544-S001','PRD-A','APT','2026-11-07','mk-${code}','sk-${code}',id,'Paquete',${qty},'UN',${kg===null?'NULL':kg},'${task}','PACKED' FROM public.sites;`;
 let s=''; for(let i=1;i<=25;i++) s+=pkg('P'+i,10,1000); s+=pkg('P26',10,null); s+=pkg('Z1',5,null,'99999-S001-001');
 await sys(s);
 const L=(await sys(`INSERT INTO public.wh_lpns(lpn_code,site_id,task_id,status,created_by,closed_by,closed_at) SELECT 'LPN-K1',id,'${task}','CLOSED','${U.op}','${U.op}',now() FROM public.sites RETURNING id`))[0].id;
 const L2=(await sys(`INSERT INTO public.wh_lpns(lpn_code,site_id,task_id,status,created_by,closed_by,closed_at) SELECT 'LPN-K2',id,'${task}','CLOSED','${U.op}','${U.op}',now() FROM public.sites RETURNING id`))[0].id;
 await sys(`UPDATE public.wh_packages SET lpn_id='${L}' WHERE task_id='${task}' AND package_code<>'Z1'; UPDATE public.wh_packages SET lpn_id='${L2}' WHERE package_code='Z1'`);
 const J=x=>JSON.stringify(x);
 const today=(await sys(`SELECT (now() AT TIME ZONE 'America/Lima')::date::text d`))[0].d;
 const kpis=async(f={})=>Object.fromEntries((await one(`SELECT public.wh_dispatch_kpis($1::date,$1::date,$2::jsonb)`,[today,J(f)])).kpis.map(k=>[k.code,k]));

 // Auditoría y hallazgos: 25 t auditadas; 1,2 t afectadas únicas (P1 con dos hallazgos y tres categorías cuenta una vez)
 await as('aud');
 await one(`SELECT public.wh_finding_create('${L}',ARRAY['CALIDAD','ROTULADO'],'MENOR','Golpe y etiqueta',$1::jsonb)`,[J([{package_code:'P1',quantity:10}])]);
 await one(`SELECT public.wh_finding_create('${L}',ARRAY['EMBALAJE'],'MENOR','Film roto',$1::jsonb)`,[J([{package_code:'P1',quantity:10},{package_code:'P2',quantity:2}])]);
 await q(`SELECT public.wh_audit_lpn('${L2}','OBSERVADO','Sin peso de recepción')`);
 await as('lect');
 let k=await kpis();
 assert.equal(Number(k.A1.value),25); assert.equal(k.A1.sin_peso,2,'P26 y Z1 sin peso: no suman 0, se informan');
 assert.equal(Number(k.A3.value),1.2,'P1 cuenta una vez aunque tenga dos hallazgos y tres categorías');
 assert.equal(Number(k.A4.value),4.8); assert.equal(Number(k.A4.num),1200); assert.equal(Number(k.A4.den),25000); assert.equal(k.A4.state,'CALCULADO');
 console.log('PASS: ejemplo de la especificación: 25 t auditadas, 1,2 t afectadas únicas, incidencia 4,8 % (sin doble conteo).');

 // Denominador 0 = no calculable; sin registros ≠ 0
 k=await kpis({ot:'99999'});
 assert.equal(k.A4.state,'NO_CALCULABLE'); assert.equal(k.A4.value,null,'solo paquetes sin peso: no se divide por 0');
 k=await kpis({ot:'00000'});
 assert.equal(k.A4.state,'SIN_REGISTROS'); assert.equal(k.D4.state,'SIN_REGISTROS');
 console.log('PASS: denominador 0 = no calculable; sin registros se informa como tal, nunca como 0 %.');

 // Masa pendiente al corte baja solo al verificar; filtros por severidad y categoría
 k=await kpis(); assert.equal(Number(k.A5.value),1.2,'masa pendiente sin doble conteo: P1 (1000 kg, en dos hallazgos) + P2 (200 kg)');
 k=await kpis({category:'EMBALAJE'}); assert.equal(Number(k.A3.value),1.2); assert.equal(Number(k.A4.value),4.8);
 k=await kpis({category:'CALIDAD'}); assert.equal(Number(k.A3.value),1); assert.equal(Number(k.A4.value),4);
 k=await kpis({category:'CALIDAD'}); assert.equal(Number(k.A5.value),1,'la masa pendiente respeta la categoría (solo P1 del hallazgo de calidad)');
 // El detalle de A1 usa la fecha de auditoría: un LPN cerrado ayer y auditado hoy aparece hoy
 await sys(`UPDATE public.wh_lpns SET closed_at=now()-interval '2 days' WHERE id='${L}'`);
 await as('lect'); const dA1=await one(`SELECT public.wh_dispatch_kpi_detail('A1',$1::date,$1::date,'{}'::jsonb)`,[today]);
 assert.ok(dA1.some(x=>x.lpn_code==='LPN-K1'),'el detalle de A1 sigue la fecha de auditoría');
 assert.equal(Number((await kpis()).A1.value),25,'el total de A1 tampoco depende del cierre del LPN');
 console.log('PASS: filtros por categoría recalculan el mismo universo; la masa pendiente se mide al corte.');

 // Detalle concilia con el total y cobertura de control: sin liberaciones no hay desvíos
 const det=await one(`SELECT public.wh_dispatch_kpi_detail('A3',$1::date,$1::date,'{}'::jsonb)`,[today]);
 assert.equal(det.length,2,'el detalle muestra los dos hallazgos que componen el total');
 assert.equal((await kpis()).A2.state,'SIN_REGISTROS');
 await as('nada'); await fails(`SELECT public.wh_dispatch_kpis($1::date,$1::date)`,[today],/Sin permiso/);
 await as('lect'); await fails(`SELECT public.wh_dispatch_kpis('2026-01-01','2027-12-31')`,[],/Período no válido/);
 console.log('PASS: el detalle muestra los registros del total; permisos y período validados.');
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1)});
