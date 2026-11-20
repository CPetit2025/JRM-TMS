// Inventario y Logística Inversa · fase 2: firma estable de las líneas del ERP, carga versionada (altas y bajas sin perder
// historia) y fuente de devoluciones de 540-04 APT LB. Corre sobre las migraciones reales de wms-db en PGlite.
const {PGlite}=require('@electric-sql/pglite');
const fs=require('fs');const path=require('node:path');const assert=require('node:assert/strict');
const U={op:'00000000-0000-0000-0000-0000000000b1',pack:'00000000-0000-0000-0000-0000000000b2',sup:'00000000-0000-0000-0000-0000000000b3',lect:'00000000-0000-0000-0000-0000000000b4',nada:'00000000-0000-0000-0000-0000000000b5',op2:'00000000-0000-0000-0000-0000000000b6',baja:'00000000-0000-0000-0000-0000000000b7'};
const OT='00000000-0000-0000-0000-00000000c001',CL='00000000-0000-0000-0000-00000000c100',REQ='00000000-0000-0000-0000-00000000d001';
const feed=[{id:REQ,request_number:'RT-000901',request_type:'DESPACHO',status:'APROBADA',site_code:'PRINCIPAL',delivery_address:'Lima',client:{id:CL,business_name:'Fargoline SAC',ruc:'20111111111'},contract:{id:OT,code:'16544',type:'CONTRATO',client_id:CL},components:[]}];
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
 // La carga de movimientos exige apt_can_load(); aquí se habilita para el usuario de prueba (el permiso no es lo que se prueba)
 await sys(`CREATE OR REPLACE FUNCTION public.apt_can_load() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$; INSERT INTO public.erp_sku_medidas(cod_producto,producto,peso_unit) VALUES ('PRD-A','Poste',2.5)`);
 const row=(n,num,prd,lote,cant,extra={})=>({__row:n,BODEGA:'540-04 APT LB',TIPODOCTO:'GUIA DE RECOJO',Numero:num,Fecha:'2026-10-21',Producto:prd,GLOSA:'Material '+prd,Cantidad:String(cant),UNIDAD:'UNID',Lote:lote,CodLegal:'20600467124',RazonSocial:'CLIENTE SAC',...extra});
 const other=n=>({__row:n,BODEGA:'647-04 ALM PT',TIPODOCTO:'P/E PRODUCCION ACT.',Numero:'PROD-9',Fecha:'2026-10-21',Producto:'PRD-Z',GLOSA:'Otro',Cantidad:'5',UNIDAD:'UND',Lote:'16000-S001'});
 const load=async rows=>{const u=(await sys(`SELECT (public.inv_upload_begin('E','prueba.xlsx')->>'upload_id') AS id`))[0].id;
   const r=(await db.query(`SELECT public.inv_upload_rows($1,$2::jsonb) AS r`,[u,JSON.stringify(rows)])).rows[0].r; assert.equal(r.success,true,JSON.stringify(r));
   const a=(await db.query(`SELECT public.inv_upload_apply_core($1,true) AS r`,[u])).rows[0].r; assert.equal(a.success,true,JSON.stringify(a)); return u};
 const keys=async()=>(await sys(`SELECT mkey FROM public.inv_movements WHERE active ORDER BY mkey`)).map(r=>r.mkey);
 const changes=async u=>Object.fromEntries((await sys(`SELECT change, count(*)::int n FROM public.inv_movement_changes WHERE upload_id='${u}' GROUP BY change`)).map(r=>[r.change,r.n]));
 await db.exec('RESET ROLE'); await db.exec(`SET request.jwt.claim.sub='${U.sup}'`);

 // 1. Primera carga: dos líneas idénticas del mismo documento + una distinta + un movimiento de otra bodega
 const base=[row(10,'T001-1','PRD-A','16339-S019',7),row(11,'T001-1','PRD-A','16339-S019',7),row(12,'T001-1','PRD-B','16339-S019',1),other(13)];
 const u1=await load(base); const k1=await keys();
 assert.equal(k1.length,4); assert.equal(new Set(k1).size,4,'las líneas idénticas tienen firmas distintas por su ocurrencia');
 assert.deepEqual(await changes(u1),{ALTA:4});
 console.log('PASS: cada línea recibe una firma estable; líneas idénticas se distinguen por su ocurrencia.');

 // 2. Recarga del mismo día con otro orden de filas: misma identidad, sin altas ni bajas
 const u2=await load([other(1),row(2,'T001-1','PRD-B','16339-S019',1),row(3,'T001-1','PRD-A','16339-S019',7),row(4,'T001-1','PRD-A','16339-S019',7)]);
 assert.deepEqual(await keys(),k1,'el número de fila del archivo no cambia la identidad');
 assert.deepEqual(await changes(u2),{});
 console.log('PASS: recargar el mismo rango (otro orden de filas) no duplica ni cambia identidades.');

 // 3. El ERP anula una línea: queda registrada como BAJA y archivada, no se pierde sin rastro
 const u3=await load([other(1),row(2,'T001-1','PRD-A','16339-S019',7),row(3,'T001-1','PRD-A','16339-S019',7)]);
 assert.deepEqual(await changes(u3),{BAJA:1});
 assert.equal((await sys(`SELECT count(*)::int n FROM public.inv_movement_removals WHERE removed_by_upload='${u3}' AND movement->>'producto'='PRD-B'`))[0].n,1);
 console.log('PASS: una línea que desaparece del ERP queda como BAJA y archivada con su contenido.');

 // 4. Fuente de devoluciones: solo la bodega en alcance, unidad normalizada, OT del lote, peso con origen (nunca 0)
 await as('lect');
 const r=(await one(`SELECT public.wh_return_lines('2026-10-01','2026-10-31')`)).lines;
 const vig=r.filter(x=>x.estado_erp==='VIGENTE'), baja=r.filter(x=>x.estado_erp==='BAJA_ERP');
 assert.equal(vig.length,2,'la producción de otra bodega queda fuera del alcance'); assert.equal(baja.length,1); assert.equal(baja[0].producto,'PRD-B');
 assert.deepEqual([...new Set(vig.map(x=>x.unidad))],['UND']); assert.equal(vig[0].unidad_original,'UNID');
 assert.equal(vig[0].ot,'16339'); assert.ok(['ERP','LOTE'].includes(vig[0].ot_origen));
 assert.equal(Number(vig[0].kg),17.5); assert.equal(vig[0].peso_origen,'MAESTRO');
 assert.ok(vig.every(x=>x.mkey && x.alta),'cada línea vigente tiene firma y fecha de alta');
 console.log('PASS: devoluciones de 540-04 APT LB con firma, unidad normalizada, OT del lote y peso con su origen; las bajas del ERP se ven para conciliar.');

 // 5. Permisos
 await as('nada'); await fails(`SELECT public.wh_return_lines('2026-10-01','2026-10-31')`,[],/Sin permiso/);
 await db.exec("RESET ROLE; SET request.jwt.claim.sub=''; SET ROLE anon;");
 await fails(`SELECT public.wh_return_lines('2026-10-01','2026-10-31')`,[],/permission denied/i);
 await fails(`SELECT count(*) FROM public.inv_movement_removals`,[],/permission denied/i);
 console.log('PASS: devoluciones e historial de cambios protegidos para anónimos y usuarios sin permiso.');
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1)});
