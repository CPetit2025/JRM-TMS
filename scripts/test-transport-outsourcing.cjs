// PostgreSQL real aislado: flujo, permisos, concurrencia, evidencias y conciliación sin tocar producción.
const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
;(async () => {
 const db = new PGlite()
 try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth; CREATE SCHEMA storage; GRANT USAGE ON SCHEMA auth TO authenticated;
   CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE TABLE profiles(id uuid,full_name text);
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.user',true),'')::uuid $$;
   CREATE FUNCTION is_active_tms_user() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT auth.uid() IS NOT NULL$$;
   CREATE FUNCTION can_access_site(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT coalesce(current_setting('test.site',true),'yes')<>'no'$$;
   CREATE FUNCTION has_tms_permission(p text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.permission',true) IN ('admin',p)$$;
   CREATE FUNCTION has_tms_read_permission(p text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.permission',true) IN ('reader','admin',p)$$;
   CREATE TABLE clients(id uuid PRIMARY KEY,business_name text); CREATE TABLE contracts(id uuid PRIMARY KEY,code text,client_id uuid); CREATE TABLE transport_requests(id uuid PRIMARY KEY,site_id uuid,contract_id uuid,request_number text);
   CREATE TABLE suppliers(id uuid PRIMARY KEY,is_active boolean,category text,business_name text);
   CREATE TABLE carriers(id uuid PRIMARY KEY,supplier_id uuid);
   CREATE TABLE dispatches(id uuid PRIMARY KEY,site_id uuid,status text,carrier_id uuid,freight_cost numeric,dispatch_number text);
   CREATE TABLE dispatch_requests(dispatch_id uuid,transport_request_id uuid);
   CREATE TABLE dispatch_request_freight(dispatch_id uuid,request_id uuid,status text,amount_pen numeric);
   CREATE TABLE transport_unloading_costs(dispatch_id uuid,transport_request_id uuid,supplier_id uuid,concept text,status text,planned_pen numeric);
   CREATE FUNCTION economic_closure_status(uuid) RETURNS text LANGUAGE sql STABLE AS $$SELECT current_setting('test.closure',true)$$;
   CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
   CREATE TABLE storage.objects(bucket_id text,name text); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
   INSERT INTO auth.users VALUES('${id(1)}'); INSERT INTO profiles VALUES('${id(1)}','Responsable prueba');
   INSERT INTO clients VALUES('${id(10)}','Cliente QA'); INSERT INTO contracts VALUES('${id(9)}','OT-QA','${id(10)}');
   INSERT INTO transport_requests VALUES('${id(2)}','${id(3)}','${id(9)}','RT-1');
   INSERT INTO suppliers VALUES('${id(4)}',true,'TRANSPORTE','Transportista'),('${id(8)}',true,'GRUA','Gruista');
   INSERT INTO carriers VALUES('${id(5)}','${id(4)}');
   INSERT INTO dispatches VALUES('${id(6)}','${id(3)}','PROGRAMADO','${id(5)}',500,'D-1');
   INSERT INTO dispatch_requests VALUES('${id(6)}','${id(2)}');
   SELECT set_config('test.user','${id(1)}',false),set_config('test.permission','admin',false);`)
  await db.exec(readFileSync('supabase/migrations/20261227090000_transport_outsourcing.sql','utf8'))
  const spec = {required_at:'2026-11-09T08:00:00-05:00',pickup:'Chilca',delivery:'Piura',responsible:'Transporte',priority:'ALTA',unit_type:'Plataforma',cargo:'Estructuras 3 x 2 x 1 m',packaging:'Pallet',special_conditions:'Eslingas',loading_window:'08:00 a 10:00',unloading_window:'14:00 a 16:00',entry_requirements:'Inducción',documents:'SOAT, SCTR, licencia, habilitación',safety:'EPP completo',access:'Altura 5 m',intermediate_points:'No aplica',length_m:6,width_m:2.5,height_m:3,capacity_t:8,volume_m3:45,cargo_weight_kg:7000,cargo_quantity:5,duration_hours:4,services:[{kind:'GRUA',requirements:'10 t, alcance 8 m, suelo nivelado',details:{capacity:'10',reach:'8',maneuver:'Suelo nivelado'}}]}
  const save = (s,v=null) => db.query('SELECT outsourcing_save($1,$2,$3) AS id',[id(2),s,v])
  const o=(await save(spec)).rows[0].id
  assert.equal((await db.query('SELECT outsourcing_queue() AS row')).rows[0].row.client,'Cliente QA','queue exposes linked client');
  assert.equal((await db.query('SELECT outsourcing_options($1) AS row',[o])).rows[0].row.dispatches.length,1,'options scoped to request');
  const version=async()=>(await db.query('SELECT version FROM transport_outsourcing WHERE id=$1',[o])).rows[0].version
  const transition=(next,evidence=null,quotes=[],v=null)=>db.query('SELECT outsourcing_transition($1,$2,$3,$4,$5,$6,$7)',[o,v,next,'Sustento registrado',evidence,quotes,id(6)])
  const move=async(next,evidence=null,quotes=[])=>transition(next,evidence,quotes,await version())
  await assert.rejects(save(spec),/cambió/,'concurrent create does not duplicate')
  assert.equal((await db.query('SELECT count(*)::int AS n FROM transport_outsourcing')).rows[0].n,1)
  await assert.rejects(transition(1,null,[],null),/cambió/,'version cannot be omitted')
  await assert.rejects(transition(1,null,[],99),/cambió/,'optimistic locking')
  await assert.rejects(move(2),/Transición/,'cannot skip states')
  await save({...spec,capacity_t:0},await version())
  await assert.rejects(move(1),/positivo/,'technical dimensions validated on server')
  await save({...spec,services:[{kind:'GRUA',requirements:'Solo descripción'}]},await version());
  await assert.rejects(move(1),/Complete capacity/,'complementary technical fields required');
  await save(spec,await version()); await move(1)
  await assert.rejects(db.exec(`UPDATE transport_requests SET contract_id=NULL WHERE id='${id(2)}'`),/vinculada/,'sent OT cannot be changed')
  await assert.rejects(save(spec,await version()),/cambió/,'submitted specification immutable')
  await assert.rejects(move(2),/evidencia/,'evidence required')
  const evidence=`${o}/evidence.pdf`
  await db.query('INSERT INTO storage.objects VALUES($1,$2)',['outsourcing',evidence])
  await db.exec("SELECT set_config('test.permission','despacho',false)")
  await assert.rejects(move(2,evidence),/Sin permiso/,'dispatch cannot manage procurement')
  await db.exec("SELECT set_config('test.permission','compras-tercerizaciones',false)")
  await move(2,evidence)
  const add=async(service,supplier,amount)=>(await db.query('SELECT outsourcing_add_quote($1,$2,$3,$4,$5,$6) AS id',[o,service,supplier,amount,'Vigente 15 días, incluye IGV',evidence])).rows[0].id
  const freight=await add('FLETE',id(4),500), crane=await add('GRUA',id(8),200)
  await assert.rejects(move(3,evidence,[freight]),/cada servicio/,'all requested services must be quoted')
  await move(3,evidence,[freight,crane])
  await assert.rejects(move(4,evidence),/Sin permiso/,'purchasing cannot approve awards')
  await db.exec("SELECT set_config('test.permission','compras-aprobar',false)")
  await move(4,evidence)
  await db.exec("SELECT set_config('test.permission','compras-tercerizaciones',false)")
  await assert.rejects(move(5,evidence),/costo programado/,'auxiliary cost missing blocks confirmation')
  await db.exec(`INSERT INTO transport_unloading_costs VALUES('${id(6)}','${id(2)}','${id(8)}','GRUA','PLANIFICADO',200)`)
  await move(5,evidence)
  await db.exec("SELECT set_config('test.permission','despacho',false)")
  await assert.rejects(move(6,evidence),/Torre de Control/,'route must be executed')
  await db.exec(`UPDATE dispatches SET status='CIERRE_OPERATIVO'`); await move(6,evidence)
  await db.exec("SELECT set_config('test.permission','cierre-economico',false)")
  await assert.rejects(move(7,evidence),/cierre económico/,'cannot close before economic closure')
  await db.exec("SELECT set_config('test.closure','CERRADO',false)"); await move(7,evidence)
  assert.equal((await db.query('SELECT stage FROM transport_outsourcing')).rows[0].stage,7)
  await db.exec("SELECT set_config('test.permission','reader',false); SET ROLE authenticated")
  assert.equal((await db.query('SELECT count(*)::int AS n FROM transport_outsourcing')).rows[0].n,1)
  await assert.rejects(db.exec('UPDATE transport_outsourcing SET stage=0'),/permission denied/,'direct state mutation blocked')
  await assert.rejects(db.exec('DELETE FROM transport_outsourcing_events'),/permission denied/,'audit immutable')
  await db.exec("SELECT set_config('test.site','no',false)")
  assert.equal((await db.query('SELECT count(*)::int AS n FROM transport_outsourcing')).rows[0].n,0,'other site hidden')
  assert.equal((await db.query('SELECT count(*)::int AS n FROM transport_outsourcing_quotes')).rows[0].n,0,'quotes inherit scope')
  assert.equal((await db.query('SELECT count(*)::int AS n FROM outsourcing_queue()')).rows[0].n,0,'queue enforces site')
  await assert.rejects(db.query('SELECT outsourcing_options($1)',[o]),/Sin acceso/,'options enforce site')
  await db.exec('RESET ROLE; SET ROLE anon');
  await assert.rejects(db.exec('SELECT outsourcing_queue()'),/permission denied/,'anonymous RPC blocked')
  console.log('PASS tercerización: ocho etapas, cotizaciones, evidencias, permisos, sede, concurrencia y conciliación económica')
 } finally { await db.close() }
})().catch(e=>{console.error(e);process.exit(1)})
