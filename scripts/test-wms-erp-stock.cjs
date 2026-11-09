// Fase 1: stock de referencia del ERP en la base WMS (migraciones de wms-db en PGlite).
const {PGlite}=require('@electric-sql/pglite');
const fs=require('fs');const path=require('node:path');const assert=require('node:assert/strict');
const U={carga:'00000000-0000-0000-0000-0000000000b1',op:'00000000-0000-0000-0000-0000000000b2',sup:'00000000-0000-0000-0000-0000000000b3'};
(async()=>{
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE TABLE auth.users(id uuid primary key); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE SQL STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role; GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC; CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$;`);
 const dir=path.join(__dirname,'../wms-db/supabase/migrations');
 for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir,f),'utf8'));
 const roles={carga:['almacen-carga'],op:['almacen-picking'],sup:['almacen-supervisor']};
 let sql="DELETE FROM public.roles; DELETE FROM public.sites; INSERT INTO public.sites(code,name) VALUES('PRINCIPAL','Local');";
 for(const [k,p] of Object.entries(roles)) sql+=`INSERT INTO public.roles(name,permissions) VALUES('${k}','${JSON.stringify(p)}');`;
 const userRole={carga:'carga',op:'op',sup:'sup'};
 for(const [u,id] of Object.entries(U)){ if(u==='admin')continue; sql+=`INSERT INTO auth.users VALUES('${id}'); INSERT INTO public.profiles(id,email,first_name,role_id,is_active) SELECT '${id}','${u}@x.pe','${u}',id,true FROM public.roles WHERE name='${userRole[u]}'; INSERT INTO public.user_site_access SELECT '${id}',id FROM public.sites;`; }
 await db.exec(sql);
 const as=async u=>db.exec(`RESET ROLE; SET request.jwt.claim.sub='${U[u]}'; SET ROLE authenticated;`);
 const q=async(s,p=[])=>(await db.query(s,p)).rows;
 const one=async(s,p=[])=>Object.values((await q(s,p))[0]||{})[0];
 const sys=async s=>{await db.exec('RESET ROLE');return (await db.query(s)).rows};
 const load=async(kind,rows,cut)=>{
  const b=await one('SELECT public.erp_upload_begin($1,$2,$3,$4)',[kind,kind+'.xlsx',cut,rows.length]); assert.equal(b.success,true,b.error);
  const r=await one('SELECT public.erp_upload_rows($1,$2::jsonb)',[b.upload_id,JSON.stringify(rows)]); assert.equal(r.success,true,r.error);
  const a=await one('SELECT public.erp_upload_apply($1)',[b.upload_id]); assert.equal(a.success,true,a.error);
  return b.upload_id;
 };
 const stock=(n,lote,qty)=>({linea:n,bodega:'647-04 ALM PT',cod_producto:'PT-1001',producto:'Bobina film',unidad:'UND',lote,stock:qty,peso_unitario:2});

 // 1. Carga STOCK y CONTRATOS
 await as('carga');
 const s1=await load('STOCK',[stock(1,'0000016544',100),stock(2,'16497-S001',40),{...stock(3,'16000',5),bodega:'540-04 APT LB'}],'2026-11-08T12:00:00Z');
 const lots=await sys(`SELECT lote,ot,kg::float kg FROM public.erp_stock_lots WHERE import_id='${s1}' ORDER BY linea`);
 assert.deepEqual(lots.map(l=>[l.lote,l.ot]),[['16544','16544'],['16497-S001','16497'],['16000','16000']],'lote sin ceros y OT raíz');
 assert.equal(lots[0].kg,200,'kg = stock x peso unitario');
 const c1=await load('CONTRATOS',[{nro_documento:'16544-001',secuencia:1,cliente:'ACME SAC',cod_producto:'PT-1001',cant_contrato:100,cant_despachada:10,cant_pendiente:90,nro_guias:1,fecha_contrato:'2026-11-01',fecha_ult_despacho:'2026-11-05',guias:[{g:'T001-000123',c:10,p:1}]}],'2026-11-08T12:00:00Z');
 assert.equal((await sys(`SELECT count(*)::int n FROM public.erp_contract_lines WHERE import_id='${c1}'`))[0].n,1);
 const gf=(await sys(`SELECT guia_key,fecha::text,fuente FROM public.erp_guia_fechas WHERE import_id='${c1}'`))[0];
 assert.deepEqual(gf,{guia_key:'T001-123',fecha:'2026-11-05',fuente:'ACTUALIZABLE'},'fecha por guía');
 console.log('PASS: carga de Stock Bodega Despacho y Actualizable Despacho con las reglas del TMS.');

 // 2. Reemplazo y retención
 await load('STOCK',[stock(1,'16544',90)],'2026-11-08T15:00:00Z');
 assert.equal((await sys(`SELECT count(*)::int n FROM public.erp_stock_lots WHERE import_id='${s1}'`))[0].n,0,'la foto reemplazada pierde sus filas');
 assert.equal((await sys(`SELECT status FROM public.erp_imports WHERE id='${s1}'`))[0].status,'REEMPLAZADA');
 await sys(`UPDATE public.erp_imports SET retained=true WHERE kind='STOCK' AND status='ACTIVA'`); await as('carga');
 const kept=(await sys(`SELECT id FROM public.erp_imports WHERE kind='STOCK' AND status='ACTIVA'`))[0].id; await as('carga');
 await load('STOCK',[stock(1,'16544',80),stock(2,'16497-S001',40)],'2026-11-08T18:00:00Z');
 assert.equal((await sys(`SELECT count(*)::int n FROM public.erp_stock_lots WHERE import_id='${kept}'`))[0].n,1,'una importación retenida conserva sus filas');
 console.log('PASS: cada carga reemplaza a la anterior; la importación retenida por un inventario conserva sus filas.');

 // 3. Consulta
 await as('op');
 const res=await one("SELECT public.erp_stock_query('647-04 ALM PT','16497')");
 assert.equal(new Date(res.cut_at).toISOString(),'2026-11-08T18:00:00.000Z'); assert.equal(res.rows.length,1); assert.equal(res.rows[0].lote,'16497-S001');
 assert.equal((await one('SELECT public.erp_stock_query()')).rows.length,2,'solo el stock activo');
 const porCliente=await one("SELECT public.erp_stock_query(NULL,'acme')");
 assert.equal(porCliente.rows.length,1,'busca por cliente'); assert.equal(porCliente.rows[0].cliente,'ACME SAC','cliente del Actualizable por OT');
 assert.ok((await one('SELECT public.erp_imports_recent()')).length>=3);
 console.log('PASS: consulta del stock activo por bodega y búsqueda, con fecha de corte.');

 // 4. Permisos
 const r=await one("SELECT public.erp_upload_begin('STOCK','x.xlsx',now(),1)"); assert.equal(r.success,false,'operario sin permiso de carga');
 await assert.rejects(q('SELECT count(*) FROM public.erp_stock_lots'),/permission/,'la tabla no se lee directo');
 await as('sup'); assert.equal((await one("SELECT public.erp_estado()")).can_load,true,'supervisión carga');
 await db.exec('RESET ROLE; SET ROLE anon');
 for(const fn of ["public.erp_stock_query()","public.erp_upload_begin('STOCK','x',now(),1)","public.erp_upload_apply_core(gen_random_uuid())"]){
  let denied=false;try{await db.query(`SELECT ${fn}`)}catch(e){denied=/permission denied/.test(e.message)}
  assert.ok(denied,`anon no debe ejecutar ${fn}`);
 }
 console.log('PASS: solo carga y supervisión cargan; tablas solo por funciones; anónimo bloqueado.');
 await db.close();
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1)});
