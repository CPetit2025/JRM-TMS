const {readFileSync}=require('node:fs'),{spawnSync}=require('node:child_process'),path=require('node:path'),assert=require('node:assert/strict')
const root=path.resolve(__dirname,'..'), name=`jrm-apt-family-${process.pid}`,read=file=>readFileSync(path.join(root,file),'utf8')
function run(args,input){const r=spawnSync('docker',args,{input,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr||r.stdout);return r.stdout}
const sql=input=>run(['exec','-i',name,'psql','-U','postgres','-v','ON_ERROR_STOP=1'],input)
const json=input=>JSON.parse(run(['exec','-i',name,'psql','-U','postgres','-qtA','-v','ON_ERROR_STOP=1'],input).trim())
const fn=(source,name)=>{const i=source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);assert.ok(i>=0,name);return source.slice(i,source.indexOf('$$;',i)+3)}
try{
 run(['run','-d','--name',name,'-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:16-alpine'])
 let ready=false;for(let n=0;n<40;n++){if(spawnSync('docker',['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres']).status===0){ready=true;break}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200)}assert.ok(ready)
 const base=read('supabase/migrations/20261002100000_apt_estadia_inventario.sql'),flow=read('supabase/migrations/20261003100000_apt_flujo_multialmacen.sql'),family=read('supabase/migrations/20261003160000_apt_familia_ot.sql')
 sql(base.slice(base.indexOf('CREATE TABLE IF NOT EXISTS public.apt_uploads'),base.indexOf('-- Lectura directa'))+
 `ALTER TABLE public.apt_movements ADD COLUMN contrato text;CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE FUNCTION apt_can_view() RETURNS boolean LANGUAGE sql AS $$SELECT true$$;`+
 flow.slice(flow.indexOf('CREATE TABLE IF NOT EXISTS public.apt_flow_layers'),flow.indexOf('DO $$',flow.indexOf('CREATE TABLE IF NOT EXISTS public.apt_flow_layers')))+fn(flow,'apt_flow_tn')+family+
 `INSERT INTO apt_uploads(id,file_name) VALUES('11111111-1111-1111-1111-111111111111','family-fixture');
 INSERT INTO apt_movements(upload_id,kind,row_no,raw,active,valid,fecha,lote,producto,peso_kg)
 SELECT '11111111-1111-1111-1111-111111111111','ENTRADA',i,'{}',true,true,'2026-01-01'::date+(i%90),(10000+(i-1)/32)::text||'-S'||lpad((i%4+1)::text,3,'0'),'P',100 FROM generate_series(1,64000)i;
 INSERT INTO apt_flow_layers(id,almacen,lote,producto,tipo,fecha,kg_in,kg_out,kg_saldo,cliente)
 SELECT id,'647',lote,producto,'PRODUCCION',fecha,100,40,60,'Synthetic' FROM apt_movements;
 INSERT INTO apt_flow_exits(id,almacen,lote,producto,tipo,fecha,kg,documento,cliente)
 SELECT id,'647',lote,producto,'DESPACHO',fecha+1,40,'G-'||id,'Synthetic' FROM apt_movements;
 UPDATE apt_flow_state SET cutoff='2026-06-01',data_min='2026-01-01';
 ANALYZE apt_movements;ANALYZE apt_flow_layers;ANALYZE apt_flow_exits;
 CREATE TABLE expected_acl AS SELECT proacl FROM pg_proc WHERE oid='apt_ot_familia(text)'::regprocedure;`)
 const before=json("SELECT apt_ot_familia('10000-S001')")
 const migration=read('supabase/migrations/20261007230000_apt_family_query_plan.sql');sql(migration);sql(migration)
 const after=json("SET statement_timeout='8s'; SELECT apt_ot_familia('10000-S001')")
 assert.deepEqual(after,before)
 sql(`DO $$ BEGIN IF (SELECT proacl FROM pg_proc WHERE oid='apt_ot_familia(text)'::regprocedure) IS DISTINCT FROM (SELECT proacl FROM expected_acl) THEN RAISE EXCEPTION 'ACL changed';END IF;END $$;`)
 assert.equal(after.miembros.length,4);assert.equal(after.resumen.saldo_tn,1.92)
 console.log('PASS: real OT family function over 64,000 movements/layers/exits; unchanged complete JSON and ACL, indexed/analyzed family keys, under 8s, repeatable migration.')
}catch(error){console.error('::error title=APT family validation::'+error.message.replaceAll('%','%25').replaceAll('\n','%0A'));process.exitCode=1}finally{spawnSync('docker',['rm','-f',name],{stdio:'ignore'})}
