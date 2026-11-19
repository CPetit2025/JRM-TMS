// Fase 2.4: programado desde el contrato ERP por OT, stock separado (disponible, preparado, otras tareas, ERP con falla)
// y cumplimiento de carga (asignado a unidad vs cargado). Corre sobre las migraciones reales de wms-db en PGlite.
const {PGlite}=require('@electric-sql/pglite');
const fs=require('fs');const path=require('node:path');const assert=require('node:assert/strict');
const U={op:'00000000-0000-0000-0000-0000000000b1',pack:'00000000-0000-0000-0000-0000000000b2',sup:'00000000-0000-0000-0000-0000000000b3',lect:'00000000-0000-0000-0000-0000000000b4',nada:'00000000-0000-0000-0000-0000000000b5',op2:'00000000-0000-0000-0000-0000000000b6',baja:'00000000-0000-0000-0000-0000000000b7'};
const OT='00000000-0000-0000-0000-00000000c001',CL='00000000-0000-0000-0000-00000000c100',REQ='00000000-0000-0000-0000-00000000d001';
const REQ2='00000000-0000-0000-0000-00000000d002',REQ3='00000000-0000-0000-0000-00000000d003';
const feed0={id:REQ,request_number:'RT-000901',request_type:'DESPACHO',status:'APROBADA',site_code:'PRINCIPAL',delivery_address:'Lima',client:{id:CL,business_name:'Fargoline SAC',ruc:'20111111111'},contract:{id:OT,code:'16544',type:'CONTRATO',client_id:CL},components:[]};
const feed=[feed0,{...feed0,id:REQ2,request_number:'RT-000902'},{...feed0,id:REQ3,request_number:'RT-000903'}];
(async()=>{
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE TABLE auth.users(id uuid primary key); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE SQL STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role; GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC; CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$;`);
 const dir=path.join(__dirname,'../wms-db/supabase/migrations');
 for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir,f),'utf8'));
 const roles={op:['almacen-picking'],pack:['almacen-packing'],sup:['almacen-supervisor'],lect:['almacen-lectura'],nada:[],op2:['almacen-picking'],baja:['almacen-picking']};
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

 const tid=async r=>(await sys(`SELECT id FROM public.wh_tasks WHERE transport_request_id='${r}'`))[0].id;
 const t2=await tid(REQ2),t3=await tid(REQ3);
 await sys(`UPDATE public.wh_tasks SET status='PICKING' WHERE id IN ('${task}','${t2}'); UPDATE public.wh_tasks SET status='CANCELLED' WHERE id='${t3}'`);
 // Contratos y stock ERP vigentes (OT 16544)
 await sys(`INSERT INTO public.erp_imports(id,kind,status,file_name,expected,applied_at) VALUES
   ('00000000-0000-0000-0000-0000000e0001','CONTRATOS','ACTIVA','c.xlsx',3,now()),('00000000-0000-0000-0000-0000000e0002','STOCK','ACTIVA','s.xlsx',1,now());
  INSERT INTO public.erp_contract_lines(import_id,nro_documento,secuencia,ot,cod_producto,producto,unidad,cant_contrato,cant_despachada,cant_pendiente,tipo_producto) VALUES
   ('00000000-0000-0000-0000-0000000e0001','16544-S001',1,'16544','PRD-A','Estante A','UND',100,30,70,'PRODUCTO'),
   ('00000000-0000-0000-0000-0000000e0001','16544-S001',2,'16544','PRD-B','Estante B','UND',10,10,0,'PRODUCTO'),
   ('00000000-0000-0000-0000-0000000e0001','16544-S001',3,'16544','SRV-1','Flete','UND',1,0,1,'SERVICIO A TERCEROS');
  INSERT INTO public.erp_stock_lots(import_id,linea,bodega,cod_producto,lote,ot,stock,stock_falla,stock_comprometido) VALUES
   ('00000000-0000-0000-0000-0000000e0002',1,'647-04 ALM PT','PRD-A','16544-S001','16544',80,5,20);`);
 const pkg=(code,qty,st,tk)=>`INSERT INTO public.wh_packages(package_code,source_document_no,source_contract_code,source_lot,source_product_code,source_warehouse,source_date,source_movement_key,source_key,site_id,description,quantity,unit,task_id,status) SELECT '${code}','IPT-1','16544-S001-001','16544-S001','PRD-A','APT','2026-11-07','mk-${code}','sk-${code}',id,'Paquete',${qty},'UN',${tk?`'${tk}'`:'NULL'},'${st}' FROM public.sites;`;
 await sys(pkg('P1',20,'AVAILABLE')+pkg('P2',15,'PICKED',task)+pkg('P3',5,'LOADED',task)+pkg('P4',10,'PACKED',t2)+pkg('P5',50,'PICKED',t3)+pkg('P6',3,'VOID',task));
 // LPN de la tarea: dos asignados a unidad (uno cargado) y uno sin unidad
 const u=(await sys(`INSERT INTO public.wh_load_units(task_id,site_id,seq) SELECT '${task}',id,1 FROM public.sites RETURNING id`))[0].id;
 await sys(`INSERT INTO public.wh_lpns(lpn_code,site_id,task_id,status,load_unit_id) SELECT c,s.id,'${task}',st,un FROM public.sites s,
   (VALUES ('L1','LOADED','${u}'::uuid),('L2','CLOSED','${u}'::uuid),('L3','CLOSED',NULL::uuid),('L4','VOID','${u}'::uuid)) v(c,st,un)`);

 await as('lect');
 const c=await one(`SELECT public.wh_prepicking_checklist('${task}')`);
 assert.equal(c.ot,'16544');
 assert.deepEqual(c.items.map(i=>i.product_code),['PRD-A'],'sin pendiente ni stock y servicios quedan fuera');
 const i=c.items[0];
 assert.deepEqual([i.pending_qty,i.avance_pct,i.stock_wms,i.prepared_qty,i.loaded_qty,i.prepared_other_qty].map(Number),[70,30,20,20,5,10]);
 assert.deepEqual([i.stock_erp,i.stock_erp_falla,i.stock_erp_comprometido].map(Number),[80,5,20]);
 assert.equal(Number(i.faltante_qty),20,'faltante = 70 − 20 preparado − 10 en otra tarea abierta − 20 disponible');
 console.log('PASS: programado = saldo del contrato ERP de la OT; preparado propio, en otras tareas abiertas (no canceladas) y disponible por separado; faltante contra la OT.');
 assert.deepEqual([c.carga.lpn_asignados,c.carga.lpn_cargados,c.carga.lpn_sin_unidad,c.carga.lpn_total,Number(c.carga.cumplimiento_pct)],[2,1,1,3,50]);
 console.log('PASS: cumplimiento de carga = LPN cargados / LPN asignados a unidad (anulados fuera); LPN sin unidad se informan.');
 // L2 cargado paquete a paquete (el LPN queda CLOSED) cuenta como cargado solo cuando todos sus paquetes están cargados
 const L2=(await sys(`SELECT id FROM public.wh_lpns WHERE lpn_code='L2'`))[0].id;
 await sys(pkg('Q1',1,'LOADED',task)+pkg('Q2',1,'PICKED',task)+`UPDATE public.wh_packages SET lpn_id='${L2}' WHERE package_code IN ('Q1','Q2');`);
 await as('lect'); assert.equal((await one(`SELECT public.wh_prepicking_checklist('${task}')`)).carga.lpn_cargados,1,'un paquete pendiente: aún no cargado');
 await sys(`UPDATE public.wh_packages SET status='LOADED' WHERE package_code='Q2'`);
 await as('lect'); assert.equal(Number((await one(`SELECT public.wh_prepicking_checklist('${task}')`)).carga.cumplimiento_pct),100);
 console.log('PASS: un LPN cargado paquete a paquete cuenta como cargado al completar todos sus paquetes.');
 // Sin unidades asignadas el cumplimiento no se calcula
 await sys(`UPDATE public.wh_lpns SET load_unit_id=NULL WHERE task_id='${task}'`);
 await as('lect'); assert.equal((await one(`SELECT public.wh_prepicking_checklist('${task}')`)).carga.cumplimiento_pct,null);
 await as('nada'); await fails(`SELECT public.wh_prepicking_checklist('${task}')`,[],/no disponible/);
 console.log('PASS: sin asignaciones el cumplimiento es «no calculable»; sin permiso WMS no se consulta.');
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1)});
