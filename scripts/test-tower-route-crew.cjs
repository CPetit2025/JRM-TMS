const { PGlite } = require('@electric-sql/pglite')
const fs = require('node:fs'), assert = require('node:assert/strict')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const shape = fs.readFileSync('scripts/security/production-shape.sql','utf8')
const table = name => {const start=shape.indexOf(`CREATE TABLE public."${name}" (`);assert.ok(start>=0);return shape.slice(start,shape.indexOf(';',start)+1)}
;(async()=>{
 const db = new PGlite()
 try {
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE SCHEMA auth;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
   CREATE FUNCTION is_active_tms_user() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.active',true)='true'$$;
   CREATE FUNCTION has_tms_read_permission(text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.permission',true)='true'$$;
   CREATE FUNCTION delivery_can_read(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.scope',true)='true'$$;
   ${['profiles','drivers','dispatches','dispatch_events'].map(table).join('\n')}
   CREATE TABLE hhee_areas(id uuid PRIMARY KEY,name text);
   CREATE TABLE hhee_people(id uuid PRIMARY KEY,name text,code text,document_number text,position text,area_id uuid,driver_id uuid,profile_id uuid,active boolean,salary numeric,remuneration_concepts jsonb);
   CREATE TABLE route_auxiliaries(dispatch_id uuid,person_id uuid);
   CREATE TABLE dispatch_crew(id uuid PRIMARY KEY,dispatch_id uuid,profile_id uuid,crew_role text,removed_at timestamptz);
   INSERT INTO profiles(id,first_name,last_name,document_number,phone,mock_password,is_active) VALUES
    ('${id(1)}','Persona','Con ficha','22222222','999111222','NEVER_EXPOSE',true),
    ('${id(2)}','Persona','Sin ficha','33333333','999333444','NEVER_EXPOSE',true),
    ('${id(3)}','Persona','Retirada','44444444','999555666','NEVER_EXPOSE',true);
   INSERT INTO hhee_areas VALUES('${id(10)}','Logística');
   INSERT INTO hhee_people VALUES('${id(11)}','Auxiliar sin usuario','T001','11111111','Auxiliar reparto','${id(10)}',NULL,NULL,false,9000,'{"private":"NEVER_EXPOSE"}'),
    ('${id(12)}','Auxiliar con usuario','T002','22222222','Auxiliar almacén','${id(10)}',NULL,'${id(1)}',true,9999,'{"private":"NEVER_EXPOSE"}');
   INSERT INTO dispatches(id,status) VALUES('${id(20)}','PROGRAMADO'),('${id(21)}','PROGRAMADO');
   INSERT INTO route_auxiliaries VALUES('${id(20)}','${id(11)}'),('${id(20)}','${id(12)}');
   INSERT INTO dispatch_events(id,dispatch_id,event_type,description,created_at,created_by_user,payload) VALUES('${id(40)}','${id(20)}','CIERRE_OPERATIVO_MANUAL','Cierre justificado','2026-10-28T12:00:00Z','${id(2)}','{"reason":"Cierre justificado","previous_status":"EN_CURSO","closed_at":"2026-10-28T12:00:00Z"}');
   INSERT INTO dispatch_crew VALUES('${id(30)}','${id(20)}','${id(1)}','AUXILIAR',NULL),('${id(31)}','${id(20)}','${id(2)}','ESTIBADOR',NULL),('${id(32)}','${id(20)}','${id(3)}','AYUDANTE',now());
   SELECT set_config('test.uid','${id(1)}',false),set_config('test.active','true',false),set_config('test.permission','true',false),set_config('test.scope','true',false);`)
  await db.exec(fs.readFileSync('supabase/migrations/20261103130000_tower_route_crew.sql','utf8'))
  const read=async route=>(await db.query('SELECT get_tower_route_crew($1::uuid) AS value',[route])).rows[0].value
  const result = await read(id(20))
  assert.equal(result.manual_closure.reason,'Cierre justificado');assert.equal(result.manual_closure.actor_name,'Persona Sin ficha');assert.equal(result.manual_closure.previous_status,'EN_CURSO')
  assert.equal(result.people.length,3,'auxiliaries without account and extra crew appear; duplicate profile and removed assignment excluded')
  const standalone=result.people.find(person=>person.code==='T001')
  assert.equal(standalone.name,'Auxiliar sin usuario');assert.equal(standalone.active,false,'historic assignments stay visible after personnel deactivation')
  const linked=result.people.find(person=>person.code==='T002')
  assert.equal(linked.phone,'999111222');assert.equal(linked.area,'Logística');assert.equal(linked.document_number,'22222222')
  assert.equal(result.people.find(person=>person.role==='ESTIBADOR').name,'Persona Sin ficha')
  assert.ok(!JSON.stringify(result).includes('NEVER_EXPOSE'))
  for(const key of ['salary','remuneration_concepts','mock_password','profile_id','driver_id'])assert.ok(!JSON.stringify(result).includes(`"${key}"`),key)
  assert.deepEqual((await read(id(21))).people,[])
  await db.exec(`INSERT INTO dispatch_events(id,dispatch_id,event_type,description,created_at,created_by_user,payload)
   VALUES('${id(41)}','${id(21)}','CIERRE_OPERATIVO_MANUAL','Registro operativo manual','2026-10-28T13:00:00Z','${id(2)}','{"reason":"Explicación interna sin auxiliares"}');`)
  const withoutCrew=await read(id(21));assert.deepEqual(withoutCrew.people,[]);assert.equal(withoutCrew.manual_closure.reason,'Explicación interna sin auxiliares')
  await assert.rejects(read(id(99)),/Despacho no disponible/)
  for(const key of ['active','permission','scope']){
   await db.exec(`SELECT set_config('test.${key}','false',false)`)
   await assert.rejects(read(id(20)),key==='scope'?/Despacho no disponible/:/Sin permiso/)
   await db.exec(`SELECT set_config('test.${key}','true',false)`)
  }
  await db.exec("SELECT set_config('test.uid','',false)")
  await assert.rejects(read(id(20)),/Sin permiso/)
  assert.equal((await db.query("SELECT has_function_privilege('anon','get_tower_route_crew(uuid)','EXECUTE') AS allowed")).rows[0].allowed,false)
  assert.equal((await db.query("SELECT has_function_privilege('authenticated','get_tower_route_crew(uuid)','EXECUTE') AS allowed")).rows[0].allowed,true)
  await assert.rejects(db.exec(fs.readFileSync('supabase/tests/caja_c160_tower_route_crew.test.sql','utf8')),/CAJA C160 PASS/)
  await db.exec('ROLLBACK')
  console.log('PASS: scoped operational crew details, accountless auxiliaries, deduplication, historic personnel, hidden private fields and access barriers')
 }finally{await db.close()}
})().catch(error=>{console.error(error);process.exitCode=1})
