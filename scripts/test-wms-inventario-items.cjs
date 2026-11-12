// Inventario: ítem del contrato al buscar por lote/OT, N bultos con peso automático y LPN de inventario (mismo SKU, lote e ítem).
// Migraciones de wms-db en PGlite.
const {PGlite}=require('@electric-sql/pglite');
const fs=require('fs');const path=require('node:path');const assert=require('node:assert/strict');
const U={sup:'00000000-0000-0000-0000-0000000000c1',cnt:'00000000-0000-0000-0000-0000000000c2',op:'00000000-0000-0000-0000-0000000000c4'};
(async()=>{
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE TABLE auth.users(id uuid primary key); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE SQL STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role; GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC; CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$;`);
 const dir=path.join(__dirname,'../wms-db/supabase/migrations');
 for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir,f),'utf8'));
 const roles={sup:['almacen-supervisor'],cnt:['almacen-etiquetado'],op:['almacen-picking']};
 let sql="DELETE FROM public.roles; DELETE FROM public.sites; INSERT INTO public.sites(code,name) VALUES('PRINCIPAL','Local');";
 for(const [k,p] of Object.entries(roles)) sql+=`INSERT INTO public.roles(name,permissions) VALUES('${k}','${JSON.stringify(p)}');`;
 for(const [u,id] of Object.entries(U)) sql+=`INSERT INTO auth.users VALUES('${id}'); INSERT INTO public.profiles(id,email,first_name,role_id,is_active) SELECT '${id}','${u}@x.pe','${u}',id,true FROM public.roles WHERE name='${u}'; INSERT INTO public.user_site_access SELECT '${id}',id FROM public.sites ON CONFLICT DO NOTHING;`;
 sql+="INSERT INTO public.erp_sku_medidas(cod_producto,peso_unit) VALUES('PT-B',2.5),('PT-A',99);";
 await db.exec(sql);
 const as=async u=>db.exec(`RESET ROLE; SET request.jwt.claim.sub='${U[u]}'; SET ROLE authenticated;`);
 const q=async(s,p=[])=>(await db.query(s,p)).rows;
 const one=async(s,p=[])=>Object.values((await q(s,p))[0]||{})[0];
 const sys=async s=>{await db.exec('RESET ROLE');return (await db.query(s)).rows};
 const fails=async(s,p,re)=>{try{await db.query(s,p)}catch(e){if(re&&!re.test(e.message))throw Error(`Mensaje inesperado: ${e.message}`);return e.message}throw Error(`Debía fallar: ${s}`)};
 const load=async(kind,rows)=>{
  const b=await one('SELECT public.erp_upload_begin($1,$2,now(),$3)',[kind,kind+'.xlsx',rows.length]); assert.equal(b.success,true,b.error);
  assert.equal((await one('SELECT public.erp_upload_rows($1,$2::jsonb)',[b.upload_id,JSON.stringify(rows)])).success,true);
  assert.equal((await one('SELECT public.erp_upload_apply($1)',[b.upload_id])).success,true);
 };
 const st=(n,lote,prod,qty,peso)=>({linea:n,bodega:'647-04 ALM PT',cod_producto:prod,producto:'Prod '+prod,unidad:'UND',lote,stock:qty,peso_unitario:peso});
 const cl=(doc,seq,prod,qty,extra={})=>({nro_documento:doc,secuencia:seq,cliente:'ACME SAC',cod_producto:prod,cant_contrato:qty,cant_despachada:0,cant_pendiente:qty,...extra});

 await as('sup');
 // PT-A en el lote 16571-S002 (ítems 022 y 024 del contrato), PT-B en el lote 16571 (OT simple, ítem 069; peso del maestro), PT-C sin contrato
 await load('STOCK',[st(1,'16571-S002','PT-A',100,1.5),st(2,'16571','PT-B',50,0),st(3,'14100D','PT-C',10,null)]);
 await load('CONTRATOS',[cl('16571-S002',22,'PT-A',60),cl('16571-S002',24,'PT-A',40),cl('16571-S002',25,'PT-Z',5),cl('16571',69,'PT-B',50),
  cl('16571-S002',30,'PT-A',9,{tipo_producto:'SERVICIO A TERCEROS'}),cl('16999',1,'PT-A',7)]);
 const camp=await one("SELECT public.wh_count_open('647-04 ALM PT',NULL,NULL,NULL,'GENERAL')");

 // 1. Búsqueda por lote/OT: una fila por ítem del contrato del mismo lote y producto, con peso unitario y su fuente
 await as('cnt');
 const res=await one("SELECT public.wh_count_expected_search($1,'16571')",[camp.id]);
 assert.deepEqual(res.map(r=>[r.cod_producto,r.item_code,r.item,Number(r.contract_qty)]),
  [['PT-B','16571-069','069',50],['PT-A','16571-S002-022','022',60],['PT-A','16571-S002-024','024',40]],'una fila por ítem; servicios y otros documentos no cuentan');
 assert.deepEqual(res.map(r=>[Number(r.unit_weight_kg),r.weight_source]),[[2.5,'MAESTRO_SKU'],[1.5,'STOCK_ERP'],[1.5,'STOCK_ERP']],'peso del stock del corte; sin él, maestro SKU');
 const noItem=(await one("SELECT public.wh_count_expected_search($1,'14100')",[camp.id]))[0];
 assert.equal(noItem.item_code,null,'un lote sin contrato devuelve la línea sin ítem');
 assert.equal((await one("SELECT public.wh_count_expected_search($1,'S002-024')",[camp.id])).length,1,'se busca también por código de ítem');
 console.log('PASS: búsqueda por lote/OT resuelve el ítem por lote (u OT simple) y producto, una fila por ítem con su cantidad de contrato y el peso unitario.');

 // 2. N bultos: cantidad por bulto × bultos, peso calculado, ítem en el paquete, n/N, idempotente
 const lA=res.find(r=>r.item==='022').linea, lB=res.find(r=>r.item==='069').linea;
 await fails("SELECT public.wh_count_label_bultos($1,$2,NULL,10,3)",[camp.id,lA],/Elija el ítem/);
 await fails("SELECT public.wh_count_label_bultos($1,$2,'16571-069',10,3)",[camp.id,lA],/no corresponde al lote/);
 await fails("SELECT public.wh_count_label_bultos($1,$2,'16571-S002-022',10,0)",[camp.id,lA],/número de bultos/);
 const ev='00000000-0000-0000-0000-00000000e101';
 const r1=await one("SELECT public.wh_count_label_bultos($1,$2,'16571-S002-022',10,3,'A',NULL,false,$3)",[camp.id,lA,ev]);
 assert.equal(r1.package_codes.length,3); assert.equal(Number(r1.quantity_total),30); assert.equal(Number(r1.weight_total_kg),45); assert.equal(Number(r1.weight_per_bulto_kg),15);
 const pk=await sys(`SELECT package_code,source_contract_code,quantity::float q,weight_kg::float kg,sequence_no,sequence_total,label_print_count FROM public.wh_packages WHERE package_code IN ('${r1.package_codes.join("','")}') ORDER BY sequence_no`);
 assert.deepEqual(pk.map(p=>[p.source_contract_code,p.q,p.kg,`${p.sequence_no}/${p.sequence_total}`]),[['16571-S002-022',10,15,'1/3'],['16571-S002-022',10,15,'2/3'],['16571-S002-022',10,15,'3/3']]);
 assert.deepEqual(pk.map(p=>p.package_code),['16571-S002-B-0001','16571-S002-B-0002','16571-S002-B-0003']);
 const again=await one("SELECT public.wh_count_label_bultos($1,$2,'16571-S002-022',10,3,'A',NULL,false,$3)",[camp.id,lA,ev]);
 assert.equal(again.duplicate_retry,true); assert.deepEqual(again.package_codes,r1.package_codes,'reintento devuelve los mismos bultos');
 // Sin IPT, una segunda tanda sigue el correlativo del lote (identidad física distinta)
 const r2=await one("SELECT public.wh_count_label_bultos($1,$2,'16571-S002-022',5,2)",[camp.id,lA]);
 assert.equal((await sys(`SELECT count(DISTINCT physical_key)::int n FROM public.wh_packages WHERE source_kind='INVENTARIO' AND status<>'VOID'`))[0].n,5);
 // Con IPT: el mismo bulto n/N no se etiqueta dos veces
 const r3=await one("SELECT public.wh_count_label_bultos($1,$2,'16571-S002-024',4,2,'A','ipt-55')",[camp.id,lA]);
 assert.equal(r3.document,'IPT-55');
 await fails("SELECT public.wh_count_label_bultos($1,$2,'16571-S002-024',4,2,'A','IPT-55')",[camp.id,lA],/ya tiene etiqueta/);
 // Superar el stock del lote exige supervisión (total = cantidad × bultos)
 await fails("SELECT public.wh_count_label_bultos($1,$2,'16571-S002-022',10,10)",[camp.id,lA],/SUPERA_STOCK/);
 const rB=await one("SELECT public.wh_count_label_bultos($1,$2,'16571-069',4,2)",[camp.id,lB]);
 assert.equal(Number(rB.weight_total_kg),20); assert.equal(rB.weight_source,'MAESTRO_SKU');
 const rC=await one("SELECT public.wh_count_label_bultos($1,$2,NULL,1,2)",[camp.id,noItem.linea]);
 assert.equal(rC.weight_total_kg,null,'sin peso en el ERP el peso queda vacío');
 assert.equal((await sys(`SELECT source_contract_code FROM public.wh_packages WHERE package_code='${rC.package_codes[0]}'`))[0].source_contract_code,'14100','sin ítem conserva la OT');
 console.log('PASS: N bultos con cantidad × bultos y peso calculado, ítem en el paquete, n/N, idempotente, anti-duplicado con IPT y alarma de stock.');

 // 3. LPN de inventario: solo bultos con rótulo de la campaña, sin LPN, mismo SKU, lote e ítem
 const [a1,a2,a3]=r1.package_codes, [b1]=r2.package_codes, [i1]=r3.package_codes, [x1]=rB.package_codes;
 const cons=(codes,ev=null)=>one('SELECT public.wh_count_consolidate_lpn($1,$2::text[],$3::uuid)',[camp.id,codes,ev]);
 await fails('SELECT public.wh_count_consolidate_lpn($1,$2::text[])',[camp.id,[a1]],/entre 2 y 100/);
 await fails('SELECT public.wh_count_consolidate_lpn($1,$2::text[])',[camp.id,[a1,i1]],/mismo SKU, lote e ítem/);
 await fails('SELECT public.wh_count_consolidate_lpn($1,$2::text[])',[camp.id,[a1,x1]],/mismo SKU, lote e ítem/);
 await db.exec("RESET ROLE; SET wh.count_op='on'"); await sys(`INSERT INTO public.wh_packages(package_code,source_document_no,source_contract_code,source_lot,source_product_code,source_warehouse,source_date,source_movement_key,source_key,site_id,description,quantity,unit) SELECT 'PKG-IPT','IPT-1','16571-S002-022','16571-S002','PT-A','647-04 ALM PT','2026-11-01','mk','sk',id,'x',1,'UND' FROM public.sites`); await db.exec('RESET wh.count_op');
 await as('cnt');
 await fails('SELECT public.wh_count_consolidate_lpn($1,$2::text[])',[camp.id,[a1,'PKG-IPT']],/no se registró con rótulo en este inventario/);
 await as('op'); await fails('SELECT public.wh_count_consolidate_lpn($1,$2::text[])',[camp.id,[a1,a2]],/Sin permiso/);
 assert.equal((await sys("SELECT count(*)::int n FROM public.wh_lpns"))[0].n,0,'los rechazos no dejan LPN');
 await as('cnt');
 const lev='00000000-0000-0000-0000-00000000e201';
 const lpn=await cons([a2,a1,b1],lev);
 assert.equal(lpn.lpn_code,'16571-S002-B-0008','número = siguiente bulto del lote');
 assert.equal(lpn.origin,'INVENTARIO'); assert.equal(lpn.status,'CLOSED'); assert.equal(lpn.package_count,3);
 assert.equal(Number(lpn.quantity),25); assert.equal(Number(lpn.weight_kg),37.5);
 assert.equal((await cons([a2,a1,b1],lev)).id,lpn.id,'reintento idempotente');
 await fails('SELECT public.wh_count_consolidate_lpn($1,$2::text[])',[camp.id,[a3,a1]],/ya está en el LPN 16571-S002-B-0008/);
 assert.equal((await sys(`SELECT count(*)::int n FROM public.wh_scan_events WHERE lpn_id='${lpn.id}' AND event_type IN ('INVENTORY_LPN_ADD','INVENTORY_LPN_CONSOLIDATE')`))[0].n,4,'auditado por bulto y consolidación');
 const lines=await one('SELECT public.wh_count_lines_list($1)',[camp.id]);
 assert.equal(lines.find(l=>l.package_code===a1).lpn_code,lpn.lpn_code); assert.equal(lines.find(l=>l.package_code===a1).contract_code,'16571-S002-022');
 const lineA1=lines.find(l=>l.package_code===a1).id;
 await fails("SELECT public.wh_count_void_line($1,'x')",[lineA1],/deshaga el LPN/);
 await q('SELECT public.wh_print_lpn_label($1)',[lpn.id]);
 assert.equal((await one("SELECT public.wh_reprint_lpn_label($1,'Etiqueta dañada')",[lpn.lpn_code])).print_count,2);
 console.log('PASS: LPN de inventario solo con bultos con rótulo de la campaña y sin LPN, mismo SKU/lote/ítem; número del lote, totales, idempotente, auditado; impresión y reimpresión.');

 // 4. Deshacer con motivo: los bultos quedan sueltos en la campaña y pueden volver a agruparse
 await fails("SELECT public.wh_lpn_undo($1,' ')",[lpn.id],/motivo/);
 await as('op'); await fails("SELECT public.wh_lpn_undo($1,'x')",[lpn.id],/permiso/);
 await as('cnt');
 assert.equal((await one("SELECT public.wh_lpn_undo($1,'Se arma en dos pallets')",[lpn.id])).packages,3);
 assert.deepEqual((await sys(`SELECT status,void_reason FROM public.wh_lpns WHERE id='${lpn.id}'`))[0],{status:'VOID',void_reason:'Se arma en dos pallets'});
 assert.equal((await sys(`SELECT count(*)::int n FROM public.wh_packages WHERE lpn_id IS NOT NULL`))[0].n,0);
 const lpn2=await cons([a1,a2]);
 assert.equal(lpn2.lpn_code,'16571-S002-B-0009');
 await q("SELECT public.wh_lpn_undo($1,'prueba')",[lpn2.id]);
 await q("SELECT public.wh_count_void_line($1,'Bulto repetido')",[lineA1]);
 console.log('PASS: deshacer con motivo (permiso de etiquetado) libera los bultos; se pueden reagrupar y, sin LPN, anular su línea.');
})().catch(e=>{console.error('FAIL:',e.message);process.exitCode=1});
