// Independent PostgreSQL harness: actual FIFO function and 64,000 synthetic movements.
// Requires Docker. Never connects to Supabase or production.
const {readFileSync} = require('node:fs')
const {spawnSync} = require('node:child_process')
const path = require('node:path')
const root=path.resolve(__dirname,'..')
const name=`jrm-apt-fifo-${process.pid}`
function run(args,input){const r=spawnSync('docker',args,{input,encoding:'utf8'}); if(r.status!==0)throw Error(r.stderr||r.stdout); return r.stdout}
function sql(input){return run(['exec','-i',name,'psql','-U','postgres','-v','ON_ERROR_STOP=1'],input)}
try {
 run(['run','-d','--name',name,'-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:16-alpine'])
 let ready=false
 // The entrypoint's temporary Unix-socket server shuts down after initialization.
 // TCP accepts connections only once the final PostgreSQL process is ready.
 for(let n=0;n<30;n++){if(spawnSync('docker',['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres']).status===0){ready=true;break} Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200)}
 if(!ready)throw Error('Scratch PostgreSQL did not become ready')
 const base=readFileSync(path.join(root,'supabase/migrations/20261002100000_apt_estadia_inventario.sql'),'utf8')
 const latest=readFileSync(path.join(root,'supabase/migrations/20261002110000_apt_cliente_ot_lote.sql'),'utf8')
 sql(base.slice(base.indexOf('CREATE TABLE IF NOT EXISTS public.apt_uploads'),base.indexOf('-- Lectura directa'))+`
 CREATE TABLE clients(id uuid PRIMARY KEY,business_name text);
 CREATE TABLE contracts(id uuid PRIMARY KEY,code text,client_id uuid);
 ALTER TABLE apt_layers ADD COLUMN cliente text;
 ALTER TABLE apt_layers ADD COLUMN cliente_fuente text;
 `+latest.slice(latest.indexOf('CREATE OR REPLACE FUNCTION public.apt_rebuild()'),latest.indexOf('CREATE OR REPLACE FUNCTION public.apt_filtered'))+`
 INSERT INTO apt_uploads(id,file_name) VALUES('11111111-1111-1111-1111-111111111111','fixture');
 INSERT INTO apt_movements(upload_id,kind,row_no,raw,active,valid,fecha,lote,producto,peso_kg)
 SELECT '11111111-1111-1111-1111-111111111111',CASE WHEN i%2=0 THEN 'ENTRADA' ELSE 'SALIDA' END,i,'{}',true,true,
 '2026-01-01'::date+(i%250),'L'||((i-1)/32),'P'||(((i-1)/32)%40),100 FROM generate_series(1,64000)i;
 CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 REVOKE ALL ON FUNCTION apt_rebuild() FROM PUBLIC, anon, authenticated;
 GRANT EXECUTE ON FUNCTION apt_rebuild() TO service_role;
 CREATE TABLE expected_acl AS SELECT proacl FROM pg_proc WHERE oid='apt_rebuild()'::regprocedure;
 SELECT apt_rebuild();
 CREATE TABLE expected_layers AS TABLE apt_layers;
 CREATE TABLE expected_allocations AS TABLE apt_allocations;
 CREATE TABLE expected_exits AS TABLE apt_exit_class;
 `)
 const migration=readFileSync(path.join(root,'supabase/migrations/20261007100000_apt_fifo_estadisticas_temporales.sql'),'utf8')
 sql(migration)
 sql(migration) // Must be repeatable, preserving the installed body and grants.
 sql(`SET statement_timeout='8s'; SELECT apt_rebuild();
 DO $$ BEGIN
 IF (SELECT proacl FROM pg_proc WHERE oid='apt_rebuild()'::regprocedure) IS DISTINCT FROM (SELECT proacl FROM expected_acl) THEN RAISE EXCEPTION 'Function permissions changed'; END IF;
 IF EXISTS((TABLE apt_layers EXCEPT TABLE expected_layers) UNION ALL (TABLE expected_layers EXCEPT TABLE apt_layers)) THEN RAISE EXCEPTION 'FIFO layers changed'; END IF;
 IF EXISTS((TABLE apt_allocations EXCEPT TABLE expected_allocations) UNION ALL (TABLE expected_allocations EXCEPT TABLE apt_allocations)) THEN RAISE EXCEPTION 'FIFO allocations changed'; END IF;
 IF EXISTS((TABLE apt_exit_class EXCEPT TABLE expected_exits) UNION ALL (TABLE expected_exits EXCEPT TABLE apt_exit_class)) THEN RAISE EXCEPTION 'FIFO exit classification changed'; END IF;
 END $$;`)
 console.log('PASS: 64,000 movements; identical layers, allocations and exit classes; rebuild under 8s; repeatable migration.')
} catch (error) {
 // Expose the failure in check annotations when downloadable Actions logs are unavailable.
 const message=String(error.stack||error).slice(0,6000).replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A')
 console.error(`::error title=APT FIFO regression::${message}`)
 throw error
} finally {spawnSync('docker',['rm','-f',name],{stdio:'ignore'})}
