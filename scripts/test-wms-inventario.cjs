// Fases 2 y 3: inventario por barrido con etiquetado, cuadre y cierre (migraciones de wms-db en PGlite).
const {PGlite}=require('@electric-sql/pglite');
const fs=require('fs');const path=require('node:path');const assert=require('node:assert/strict');
const U={sup:'00000000-0000-0000-0000-0000000000c1',cnt:'00000000-0000-0000-0000-0000000000c2',cnt2:'00000000-0000-0000-0000-0000000000c3',op:'00000000-0000-0000-0000-0000000000c4',ext:'00000000-0000-0000-0000-0000000000c5',ana:'00000000-0000-0000-0000-0000000000c6',rec:'00000000-0000-0000-0000-0000000000c7'};
(async()=>{
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE TABLE auth.users(id uuid primary key); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE SQL STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role; GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC; CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$;`);
 const dir=path.join(__dirname,'../wms-db/supabase/migrations');
 for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir,f),'utf8'));
 // Roles del almacén que crea la migración
 const creados=Object.fromEntries((await db.query("SELECT name,permissions FROM public.roles")).rows.map(r=>[r.name,r.permissions]));
 assert.deepEqual(creados['Analista de Inventario'],['almacen-lectura','almacen-etiquetado','almacen-inventario']);
 assert.deepEqual(creados['Auditor de Despacho'],['almacen-lectura','almacen-auditoria']);
 assert.deepEqual(creados['Asistente de Recepción'],['almacen-lectura','almacen-etiquetado']);
 const roles={sup:['almacen-supervisor'],cnt:['almacen-etiquetado'],op:['almacen-picking'],inv:creados['Analista de Inventario'],rec:creados['Asistente de Recepción']};
 let sql="DELETE FROM public.roles; DELETE FROM public.sites; INSERT INTO public.sites(code,name) VALUES('PRINCIPAL','Local');";
 for(const [k,p] of Object.entries(roles)) sql+=`INSERT INTO public.roles(name,permissions) VALUES('${k}','${JSON.stringify(p)}');`;
 const userRole={sup:'sup',cnt:'cnt',cnt2:'cnt',op:'op',ext:'cnt',ana:'inv',rec:'rec'};
 for(const [u,id] of Object.entries(U)){ sql+=`INSERT INTO auth.users VALUES('${id}'); INSERT INTO public.profiles(id,email,first_name,role_id,is_active) SELECT '${id}','${u}@x.pe','${u}',id,true FROM public.roles WHERE name='${userRole[u]}'; ${u==='ext'?'':`INSERT INTO public.user_site_access SELECT '${id}',id FROM public.sites;`}`; }
 // Un bulto ya etiquetado por IPT (bodega 647, bulto 1 de 3) y uno de otra bodega
 sql+=`INSERT INTO public.wh_packages(package_code,source_document_no,source_contract_code,source_lot,source_product_code,source_warehouse,source_date,source_movement_key,source_key,site_id,description,quantity,unit,sequence_no,sequence_total) SELECT 'PKG-IPT-1','IPT-77','16544','0000016544','PT-1','647-04 ALM PT','2026-11-01','mk1','sk1',id,'Bobina',10,'UND',1,3 FROM public.sites;`;
 sql+=`INSERT INTO public.wh_packages(package_code,source_document_no,source_contract_code,source_lot,source_product_code,source_warehouse,source_date,source_movement_key,source_key,site_id,description,quantity,unit) SELECT 'PKG-OTRA','IPT-90','16000','16000','PT-9','ST-VENTAS-IMD','2026-11-01','mk2','sk2',id,'Otro',4,'UND' FROM public.sites;`;
 // Un bulto ya empacado antes del inventario
 sql+=`INSERT INTO public.wh_packages(package_code,source_document_no,source_contract_code,source_lot,source_product_code,source_warehouse,source_date,source_movement_key,source_key,site_id,description,quantity,unit,status) SELECT 'PKG-EMP','IPT-55','16544','16544','PT-1','647-04 ALM PT','2026-11-01','mk3','sk3',id,'Empacado',1,'UND','PACKED' FROM public.sites;`;
 await db.exec(sql);
 const as=async u=>db.exec(`RESET ROLE; SET request.jwt.claim.sub='${U[u]}'; SET ROLE authenticated;`);
 const q=async(s,p=[])=>(await db.query(s,p)).rows;
 const one=async(s,p=[])=>Object.values((await q(s,p))[0]||{})[0];
 const sys=async s=>{await db.exec('RESET ROLE');return (await db.query(s)).rows};
 const fails=async(s,p,re)=>{try{await db.query(s,p)}catch(e){if(re&&!re.test(e.message))throw Error(`Mensaje inesperado: ${e.message}`);return e.message}throw Error(`Debía fallar: ${s}`)};
 const load=async rows=>{
  const b=await one("SELECT public.erp_upload_begin('STOCK','s.xlsx',now(),$1)",[rows.length]);
  await one('SELECT public.erp_upload_rows($1,$2::jsonb)',[b.upload_id,JSON.stringify(rows)]);
  assert.equal((await one('SELECT public.erp_upload_apply($1)',[b.upload_id])).success,true);
 };
 const st=(n,lote,prod,qty)=>({linea:n,bodega:'647-04 ALM PT',cod_producto:prod,producto:'Prod '+prod,unidad:'UND',lote,stock:qty});

 // 1. Apertura: copia inmutable y retención de la carga
 await as('sup');
 await load([st(1,'0000016544','PT-1',30),st(2,'16544','PT-2',5),st(3,'16497-S001','PT-3',8)]);
 await as('cnt'); await fails("SELECT public.wh_count_open('647-04 ALM PT')",[],/supervisión/);
 await as('sup');
 const camp=await one("SELECT public.wh_count_open('647-04 ALM PT',ARRAY['A','B'],NULL,NULL,'GENERAL')");
 assert.equal(camp.expected_lines,3);
 await fails("SELECT public.wh_count_open('647-04 ALM PT')",[],/Ya hay un inventario/);
 await load([st(1,'16544','PT-1',99)]);
 assert.equal((await sys(`SELECT count(*)::int n FROM public.wh_count_expected WHERE campaign_id='${camp.id}' AND stock=30`))[0].n,1,'la copia no cambia con cargas nuevas');
 assert.equal((await sys(`SELECT count(*)::int n FROM public.erp_stock_lots s JOIN public.erp_imports i ON i.id=s.import_id WHERE i.retained`))[0].n,3,'la carga usada se retiene');
 console.log('PASS: apertura por supervisión con copia inmutable del stock y carga del ERP retenida.');

 // 2. Barrido: etiqueta existente y rótulo con identidad
 await as('cnt');
 const s1=await one("SELECT public.wh_count_scan($1,'pkg-ipt-1','A')",[camp.id]);
 assert.equal(s1.package_code,'PKG-IPT-1');
 await fails("SELECT public.wh_count_scan($1,'PKG-IPT-1','B')",[camp.id],/ya fue contado/);
 const other=await one("SELECT public.wh_count_scan($1,'PKG-OTRA','A')",[camp.id]); assert.equal(other.other_bodega,true,'bulto de otra bodega se marca');
 const exp=await one("SELECT public.wh_count_expected_search($1,'16544')",[camp.id]);
 const l1=exp.find(e=>e.cod_producto==='PT-1').linea;
 // El rótulo dice IPT-77 bulto 1/3: ya tiene etiqueta → se rechaza
 await fails("SELECT public.wh_count_label($1,$2,10,NULL,'A','IPT-77',1,3)",[camp.id,l1],/ya tiene etiqueta PKG-IPT-1/);
 const lab=await one("SELECT public.wh_count_label($1,$2,10,12.5,'A','IPT-77',2,3)",[camp.id,l1]);
 assert.match(lab.package_code,/^PKG-/); assert.equal(lab.sequence_no,2);
 await fails("SELECT public.wh_count_label($1,$2,10,NULL,'B','ipt-77',2,3)",[camp.id,l1],/ya tiene etiqueta/);
 const retry=await one("SELECT public.wh_count_label($1,$2,10,NULL,'A','IPT-77',3,3,false,'00000000-0000-0000-0000-00000000e001')",[camp.id,l1]);
 const again=await one("SELECT public.wh_count_label($1,$2,10,NULL,'A','IPT-77',3,3,false,'00000000-0000-0000-0000-00000000e001')",[camp.id,l1]);
 assert.equal(again.duplicate_retry,true); assert.equal(again.package_code,retry.package_code,'reintento idempotente');
 // Sin IPT: secuencia por lote; superar el stock exige supervisión
 const l2=exp.find(e=>e.cod_producto==='PT-2').linea;
 const a=await one("SELECT public.wh_count_label($1,$2,3,NULL,'B')",[camp.id,l2]); const b2=await one("SELECT public.wh_count_label($1,$2,2,NULL,'B')",[camp.id,l2]);
 assert.deepEqual([a.sequence_no,b2.sequence_no],[1,2]);
 await fails("SELECT public.wh_count_label($1,$2,1,NULL,'B')",[camp.id,l2],/SUPERA_STOCK/);
 await fails("SELECT public.wh_count_label($1,$2,1,NULL,'B',NULL,NULL,NULL,true)",[camp.id,l2],/Solo supervisión confirma/);
 await one("SELECT public.wh_count_unidentified($1,'Caja sin rótulo legible','B')",[camp.id]);
 console.log('PASS: barrido cuenta etiquetas una vez por campaña, etiqueta rótulos con identidad única e idempotente, y alarma de saldo con supervisión.');

 // 3. Congelamiento y retención
 await db.exec('RESET ROLE');
 await fails("UPDATE public.wh_packages SET status='PICKED' WHERE package_code='PKG-IPT-1'",[],/está en inventario/);
 await fails(`INSERT INTO public.wh_packages(package_code,source_document_no,source_lot,source_product_code,source_warehouse,source_date,source_movement_key,source_key,site_id,description,quantity) SELECT 'PKG-NEW','IPT-88','x','PT-1','647-04 ALM PT','2026-11-08','mk9','sk9',id,'x',1 FROM public.sites`,[],/recepción por IPT se reanuda/);
 await fails(`UPDATE public.wh_packages SET status='PICKED' WHERE package_code='${lab.package_code}'`,[],/retenido|está en inventario/);
 await fails("UPDATE public.wh_packages SET status='LOADED' WHERE package_code='PKG-EMP'",[],/está en inventario/);
 await db.exec("UPDATE public.wh_packages SET status='PICKED' WHERE package_code='PKG-EMP'"); // deshacer un empaque no se bloquea
 await db.exec("UPDATE public.wh_packages SET status='PICKED' WHERE package_code='PKG-OTRA'"); // otra bodega opera normal
 await as('ext'); await fails("SELECT public.wh_count_expected_search($1,'16544')",[camp.id],/no disponible/);
 console.log('PASS: la bodega en inventario no despacha ni etiqueta por IPT; los paquetes nuevos quedan retenidos.');

 // 4. Cuadre, reconteo por otro operario y cierre
 await as('sup');
 let sum=await one('SELECT public.wh_count_summary($1)',[camp.id]);
 const byP=Object.fromEntries(sum.map(r=>[r.cod_producto,r]));
 assert.equal(byP['PT-1'].counted,30); assert.equal(byP['PT-1'].result,'CUADRA');
 assert.equal(byP['PT-2'].result,'CUADRA'); assert.equal(byP['PT-3'].result,'FALTANTE');
 assert.equal(byP['PT-9'].result,'NO_EN_ERP');
 await fails("SELECT public.wh_count_close($1,'{}'::jsonb)",[camp.id],/no identificados/);
 const un=(await one('SELECT public.wh_count_lines_list($1)',[camp.id])).find(l=>l.origin==='NO_IDENTIFICADO');
 await one("SELECT public.wh_count_void_line($1,'Era un bulto de PT-2 ya contado')",[un.id]);
 await one('SELECT public.wh_count_to_review($1)',[camp.id]);
 await one(`SELECT public.wh_count_recount($1,'[{"cod_producto":"PT-1","lote_key":"16544"}]'::jsonb)`,[camp.id]);
 await as('cnt'); await fails("SELECT public.wh_count_scan($1,'PKG-IPT-1')",[camp.id],/operario distinto/);
 await as('cnt2'); await one("SELECT public.wh_count_scan($1,'PKG-IPT-1')",[camp.id]); await one("SELECT public.wh_count_scan($1,$2)",[camp.id,lab.package_code]);
 await as('sup');
 const rot=(await one('SELECT public.wh_count_lines_list($1)',[camp.id])).find(l=>l.origin==='ROTULO'&&l.package_code===lab.package_code);
 await one("SELECT public.wh_count_void_line($1,'Etiqueta duplicada')",[rot.id]);
 assert.equal((await sys(`SELECT count(*)::int n FROM public.wh_count_lines l JOIN public.wh_packages p ON p.id=l.package_id WHERE p.package_code='${lab.package_code}' AND l.voided_at IS NULL`))[0].n,0,'anular el paquete anula también su reconteo');
 await as('cnt2');
 await fails("SELECT public.wh_count_unidentified($1,'x')",[camp.id],/no está en conteo/);
 await as('sup');
 sum=await one('SELECT public.wh_count_summary($1)',[camp.id]);
 assert.equal(sum.find(r=>r.cod_producto==='PT-1').counted,10,'el reconteo reemplaza la ronda anterior');
 await fails("SELECT public.wh_count_close($1,'{}'::jsonb)",[camp.id],/motivo de las 3 diferencias/);
 const reasons={'PT-1|16544':'Dos bultos en otra zona','PT-3|16497-S001':'Pendiente de ubicar','PT-9|16000':'Bulto de ST-VENTAS en zona equivocada'};
 const closed=await one('SELECT public.wh_count_close($1,$2::jsonb)',[camp.id,JSON.stringify(reasons)]);
 assert.equal(closed.released_packages,3,'se liberan los paquetes retenidos (el anulado no)');
 assert.equal((await sys(`SELECT count(*)::int n FROM public.wh_count_results WHERE campaign_id='${camp.id}' AND result<>'CUADRA' AND reason IS NOT NULL`))[0].n,3);
 assert.equal((await sys('SELECT count(*)::int n FROM public.erp_imports WHERE retained'))[0].n,0,'la carga retenida se libera');
 await db.exec('RESET ROLE'); await db.exec(`UPDATE public.wh_packages SET status='PICKED' WHERE package_code='${retry.package_code}'`);
 console.log('PASS: cuadre por lote (cuadra, faltante, sobrante, no en ERP), reconteo por otro operario y cierre con motivos que libera paquetes.');

 // 5. Permisos
 await as('op'); await fails("SELECT public.wh_count_scan($1,'PKG-IPT-1')",[camp.id],/permiso/);
 await fails('SELECT count(*) FROM public.wh_count_lines',[],/permission/);
 await db.exec('RESET ROLE; SET ROLE anon');
 for(const fn of ["public.wh_count_board()","public.wh_count_open('x')","public.wh_count_close(gen_random_uuid())"]){
  let denied=false;try{await db.query(`SELECT ${fn}`)}catch(e){denied=/permission denied/.test(e.message)}
  assert.ok(denied,`anon no debe ejecutar ${fn}`);
 }
 console.log('PASS: inventario solo para etiquetado, carga y supervisión; tablas solo por funciones; anónimo bloqueado.');

 // 6. Tipos: al barrer y cíclico no congelan la bodega
 const ipt=(code,prod)=>`INSERT INTO public.wh_packages(package_code,source_document_no,source_lot,source_product_code,source_warehouse,source_date,source_movement_key,source_key,site_id,description,quantity) SELECT '${code}','IPT-${code}','x','${prod}','647-04 ALM PT','2026-11-09','mk-${code}','sk-${code}',id,'x',1 FROM public.sites`;
 await as('sup');
 const bar=await one("SELECT public.wh_count_open('647-04 ALM PT',ARRAY['A'],NULL,NULL,'BARRIDO')"); assert.equal(bar.tipo,'BARRIDO');
 await db.exec('RESET ROLE'); await db.exec(ipt('PKG-B1','PT-1')); // recepción por IPT libre
 await as('cnt'); await one("SELECT public.wh_count_scan($1,'PKG-B1','A')",[bar.id]);
 await db.exec('RESET ROLE');
 await fails("UPDATE public.wh_packages SET status='PICKED' WHERE package_code='PKG-B1'",[],/ya se contó en el inventario de su zona/);
 await db.exec(ipt('PKG-B2','PT-1')); await db.exec("UPDATE public.wh_packages SET status='PICKED' WHERE package_code='PKG-B2'"); // no contado: opera
 await as('sup'); await one('SELECT public.wh_count_close($1,$2::jsonb)',[bar.id,JSON.stringify(Object.fromEntries((await one('SELECT public.wh_count_summary($1)',[bar.id])).filter(r=>r.result!=='CUADRA').map(r=>[r.cod_producto+'|'+r.lote_key,'barrido de prueba'])))]);
 await fails("SELECT public.wh_count_open('647-04 ALM PT','{}',NULL,NULL,'CICLICO')",[],/Indique los SKU/);
 const cic=await one("SELECT public.wh_count_open('647-04 ALM PT','{}',NULL,NULL,'CICLICO',ARRAY['pt-1'])");
 assert.equal((await sys(`SELECT count(*)::int n FROM public.wh_count_expected WHERE campaign_id='${cic.id}'`))[0].n,1,'el cíclico solo copia sus SKU');
 await db.exec('RESET ROLE');
 await fails(ipt('PKG-C1','PT-1'),[],/inventario cíclico/);
 await db.exec(ipt('PKG-C2','PT-3')); // otro SKU se recibe normal
 await as('cnt'); await fails("SELECT public.wh_count_scan($1,'PKG-C2')",[cic.id],/no está en este inventario cíclico/);
 // 7. Anular y volver a conteo
 await as('sup');
 await fails('SELECT public.wh_count_to_review($1)',[cic.id],/No hay bultos contados/);
 await as('cnt'); await fails("SELECT public.wh_count_cancel($1,'x')",[cic.id],/Solo supervisión/);
 await as('sup'); await fails("SELECT public.wh_count_cancel($1,' ')",[cic.id],/motivo/);
 const an=await one("SELECT public.wh_count_cancel($1,'Abierta sin conteo')",[cic.id]); assert.equal(an.success,true);
 const anu=(await sys(`SELECT status, close_note FROM public.wh_count_campaigns WHERE id='${cic.id}'`))[0];
 assert.deepEqual([anu.status,anu.close_note],['ANULADA','Anulada: Abierta sin conteo']);
 assert.equal((await sys(`SELECT count(*)::int n FROM public.wh_count_results WHERE campaign_id='${cic.id}'`))[0].n,0,'anular no genera cuadre');
 assert.equal((await sys('SELECT count(*)::int n FROM public.erp_imports WHERE retained'))[0].n,0,'libera la carga del ERP');
 await db.exec('RESET ROLE'); await db.exec(ipt('PKG-C3','PT-1')); // el SKU vuelve a recibirse
 await as('sup'); const re=await one("SELECT public.wh_count_open('647-04 ALM PT','{}',NULL,NULL,'BARRIDO')");
 await as('cnt'); await one("SELECT public.wh_count_scan($1,'PKG-C3')",[re.id]);
 await as('sup'); await one('SELECT public.wh_count_to_review($1)',[re.id]); await one('SELECT public.wh_count_reopen($1)',[re.id]);
 assert.equal((await sys(`SELECT status FROM public.wh_count_campaigns WHERE id='${re.id}'`))[0].status,'EN_CONTEO','vuelve a conteo');
 // Analista de Inventario gestiona la campaña sin supervisión; Asistente de Recepción solo cuenta
 await as('rec'); await fails("SELECT public.wh_count_cancel($1,'x')",[re.id],/Solo supervisión/);
 await as('ana'); await one('SELECT public.wh_count_to_review($1)',[re.id]); await one('SELECT public.wh_count_reopen($1)',[re.id]); await one("SELECT public.wh_count_cancel($1,'prueba analista')",[re.id]);
 const an2=await one("SELECT public.wh_count_open('647-04 ALM PT','{}',NULL,NULL,'BARRIDO')"); await one("SELECT public.wh_count_cancel($1,'prueba analista')",[an2.id]);
 assert.equal((await sys(`SELECT status FROM public.wh_count_campaigns WHERE id='${re.id}'`))[0].status,'ANULADA','el analista anula');
 console.log('PASS: roles del almacén; el analista abre, revisa, reabre y anula inventarios; recepción no.');
 console.log('PASS: anular con motivo sin cuadre y liberando carga y SKU; volver a conteo; no se termina un conteo vacío.');
 console.log('PASS: tipos de inventario: general congela la bodega; al barrer solo bloquea lo contado; cíclico solo sus SKU; la recepción sigue.');
 await db.close();
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1)});
