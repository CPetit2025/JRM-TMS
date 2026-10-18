// Isolated PostgreSQL integration + representative 201,573-row workload. Never touches production.
const { spawnSync } = require('node:child_process')
const { readFileSync, appendFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const name = `jrm-inventory-${process.pid}`
function docker(args, input) {
 const r = spawnSync('docker', args, {input, encoding:'utf8', maxBuffer:20*1024*1024})
 if (r.status) throw Error(r.stderr || r.stdout)
 return r.stdout
}
function query(input) { return spawnSync('docker',['exec','-i',name,'psql','-h','127.0.0.1','-U','postgres','-At','-v','ON_ERROR_STOP=1'],{input,encoding:'utf8',maxBuffer:20*1024*1024}) }
function sql(input) { const r=query(input); if(r.status) throw Error(r.stderr||r.stdout); if(process.env.INVENTORY_PLAN_LOG) appendFileSync(process.env.INVENTORY_PLAN_LOG,r.stderr); return r.stdout.trim() }
try {
 docker(['run','-d','--name',name,'-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:16-alpine'])
 for(let i=0;i<60;i++){if(spawnSync('docker',['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres'],{stdio:'ignore'}).status===0)break;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200)}
 sql(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
 CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 CREATE TABLE roles(id uuid PRIMARY KEY,name text); CREATE TABLE profiles(id uuid PRIMARY KEY,role_id uuid,is_active boolean);
 INSERT INTO roles VALUES('00000000-0000-4000-8000-000000000001','Administrador');
 INSERT INTO profiles VALUES('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001',true);
 CREATE FUNCTION apt_can_load() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT auth.uid()='00000000-0000-4000-8000-000000000002'::uuid $$;
 CREATE FUNCTION apt_can_view() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(apt_can_load(),false) $$;
 CREATE FUNCTION is_active_tms_user() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(apt_can_load(),false) $$;
 CREATE FUNCTION apt_id(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT regexp_replace($1,'\\.0+$','') $$;`)
 for(const file of ['20261020100000_inventario_multialmacen.sql','20261020110000_inventory_upload_performance.sql','20261020120000_inventory_rebuild_plans.sql']) sql(readFileSync('supabase/migrations/'+file,'utf8'))
 for(const file of ['caja_c115_inventario_multialmacen.test.sql','caja_c116_inventory_upload_retry.test.sql']) {
  const r=query(readFileSync('supabase/tests/'+file,'utf8')); assert.match(r.stderr,/CAJA C\d+ PASS/); assert.doesNotMatch(r.stderr,/FAIL/); console.log(r.stderr.split('\n').find(s=>s.includes('PASS')))
 }
 // Fresh read statements follow the same timeout as authenticated requests. No upward timeout override for chunks.
 const started=Date.now()
 const out=sql(`SET request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
 SET statement_timeout='8s';
 CREATE TEMP TABLE bench_uploads(id uuid);
 DO $$ DECLARE u uuid; BEGIN
 FOR side_number IN 1..2 LOOP
 u := (inv_upload_begin(CASE WHEN side_number=1 THEN 'S' ELSE 'E' END,'synthetic.xlsx')->>'upload_id')::uuid;
 INSERT INTO bench_uploads VALUES(u);
 END LOOP; END $$;
 SELECT id FROM bench_uploads;`)
 const ids=out.split('\n').filter(x=>/^[a-f0-9-]{36}$/.test(x)); assert.equal(ids.length,2)
 let worst=0
 for (let side=0;side<2;side++) {
  const count=side===0?130116:71457
  for(let offset=0;offset<count;offset+=500){
   const t=Date.now()
   const result=sql(`SET request.jwt.claim.sub='00000000-0000-4000-8000-000000000002'; SET statement_timeout='8s';
   SELECT inv_upload_rows('${ids[side]}',jsonb_agg(jsonb_build_object('__row',n,'BODEGA','WAREHOUSE '||(n%40),'TIPODOCTO',CASE WHEN n%5=0 THEN 'TRASPASO DE ALMACEN' ELSE 'P/E PRODUCCION ACT.' END,
   'Numero',n,'Fecha',(DATE '2026-01-02'+(n%284))::text,'Producto','PRODUCT '||(n%300),'Lote',(16000+n%100)::text,'Cantidad',${side===0?-2:3},'PesoUnitario',2))) FROM generate_series(${offset+1},${Math.min(offset+500,count)}) n;`)
   assert.match(result, /"success": true/);worst=Math.max(worst,Date.now()-t)
  }
  assert.match(sql(`SELECT inv_upload_apply_core('${ids[side]}');`),/"success": true/)
 }
 assert.equal(Number(sql('SELECT count(*) FROM inv_movements WHERE active;')),201573)
 assert.equal(Number(sql('SELECT count(*) FROM inv_movements m JOIN inv_doc_types d ON d.tipodocto=m.tipodocto WHERE m.clase IS DISTINCT FROM d.clase;')),0,'movements are classified before the rebuild');
 const profile = process.env.INVENTORY_PLAN_LOG ? "LOAD 'auto_explain'; SET client_min_messages=log; SET auto_explain.log_min_duration='500ms'; SET auto_explain.log_nested_statements=on; SET auto_explain.log_analyze=on; SET auto_explain.log_timing=off;" : ''
 const t=Date.now(); const model=JSON.parse(sql(profile + "SET statement_timeout='120s'; SELECT inv_rebuild();").split('\n').at(-1));assert.equal(model.success,true)
 assert.equal(Number(sql('SELECT count(*) FROM inv_layers l LEFT JOIN (SELECT layer_id,sum(qty) qty FROM inv_allocations GROUP BY layer_id) a ON a.layer_id=l.id WHERE l.consumed IS DISTINCT FROM coalesce(a.qty,0);')),0,'every layer balance equals the detailed FIFO consumptions');
 const catTime=Date.now(); assert.match(sql(`SET request.jwt.claim.sub='00000000-0000-4000-8000-000000000002'; SET statement_timeout='8s'; SELECT inv_catalogs()->>'success';`),/true/)
 const catalogMilliseconds=Date.now()-catTime;
 const regression = query("SET statement_timeout='120s';\n" + readFileSync('supabase/tests/caja_c115_inventario_multialmacen.test.sql','utf8')); assert.match(regression.stderr,/CAJA C115 PASS/); assert.doesNotMatch(regression.stderr,/FAIL/); assert.equal(Number(sql('SELECT count(*) FROM inv_movements WHERE active;')),201573); console.log('PASS: C115 also passes with the full history already present, within the production timeout, and rolls back.');
 console.log(JSON.stringify({rows:201573,largestChunkMilliseconds:worst,rebuildMilliseconds:catTime-t,catalogMilliseconds,totalMilliseconds:Date.now()-started,model}))
} finally { docker(['rm','-f',name]) }
