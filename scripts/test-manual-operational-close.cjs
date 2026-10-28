const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const shape = readFileSync('scripts/security/production-shape.sql', 'utf8')
const table = name => { const start = shape.indexOf(`CREATE TABLE public."${name}" (`); assert.ok(start >= 0); return shape.slice(start,shape.indexOf(';',start)+1) }
const fn = (path,name) => {
 const source=readFileSync(path,'utf8'), start=source.search(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(`))
 assert.ok(start>=0,name); const body=source.indexOf('$$',start); return source.slice(start,source.indexOf('$$;',body+2)+3)
}
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
;(async()=>{
 const db=new PGlite()
 try {
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE SCHEMA auth;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('test.user',true),'')::uuid$$;
   CREATE FUNCTION is_active_tms_user() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(current_setting('test.active',true),'true')='true'$$;
   CREATE FUNCTION can_operate_dispatch(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT $1='${id(1)}' AND COALESCE(current_setting('test.write',true),'true')='true'$$;
   CREATE FUNCTION delivery_can_read(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(current_setting('test.read',true),'true')='true' AND COALESCE(current_setting('test.portfolio',true),'true')='true'$$;
   CREATE FUNCTION check_asset_eligibility(text,text) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('status',CASE WHEN COALESCE(current_setting('test.eligible',true),'true')='true' THEN 'APTO' ELSE 'NO_APTO' END,'motives',jsonb_build_array('Verificación técnica'))$$;
   CREATE FUNCTION delivery_required(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
   ${['dispatches','vehicles','dispatch_events','dispatch_requests','vehicle_history_logs','drivers'].map(table).join('\n')}
   CREATE TABLE delivery_conformities(dispatch_id uuid,request_id uuid,state text);
   CREATE TABLE notifications(evento text,categoria text,severidad text,titulo text,cuerpo text,link text,permisos text[],target_user uuid,dedupe_key text);
   CREATE TABLE profiles(id uuid,is_active boolean);
   CREATE TABLE trip_settlements(dispatch_id uuid,status text,total_paid numeric);
   CREATE TABLE transport_requests(id uuid,status text);
   CREATE TABLE contract_budgets(contract_id uuid,reserved_pen numeric,consumed_pen numeric);
   CREATE UNIQUE INDEX dispatch_one_active_driver ON dispatches(driver_id) WHERE driver_id IS NOT NULL AND status IN('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO');
   CREATE UNIQUE INDEX dispatch_one_active_vehicle ON dispatches(vehicle_plate) WHERE vehicle_plate IS NOT NULL AND vehicle_plate<>'EXTERNO' AND status IN('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO');
   SELECT set_config('test.user','${id(50)}',false);`)
  const daily='supabase/migrations/20261011110000_daily_route_cutoff.sql'
  await db.exec(`ALTER TABLE dispatches ADD COLUMN daily_cutoff_at timestamptz,ADD COLUMN operational_closed_at timestamptz,ADD COLUMN operational_previous_status text;`+
   ['dispatch_operating_day','dispatch_cutoff_at','dispatch_daily_clock_guard','dispatch_daily_release_event'].map(name=>fn(daily,name)).join('\n')+
   `CREATE TRIGGER dispatch_daily_clock_guard BEFORE INSERT OR UPDATE ON dispatches FOR EACH ROW EXECUTE FUNCTION dispatch_daily_clock_guard();
    CREATE TRIGGER dispatch_daily_release_event AFTER UPDATE OF status ON dispatches FOR EACH ROW EXECUTE FUNCTION dispatch_daily_release_event();`)
  await db.exec(readFileSync('supabase/migrations/20261103140000_manual_operational_close.sql','utf8'))
  const scalar=async(sql,p=[]) => (await db.query(sql,p)).rows[0].v
  const close=(route,reason='Servicio detenido por una incidencia operativa')=>scalar('SELECT manual_close_dispatch_operations($1,$2) AS v',[route,reason])
  const setup=async(n,status='PROGRAMADO',mode='PROPIA',vehicleStatus='EN_OPERACION',site=id(1)) => {
   const route=id(n),plate=`TEST-${n}`
   await db.query("INSERT INTO vehicles(id,plate,status) VALUES($1,$2,$3)",[id(n+1000),plate,vehicleStatus])
   await db.query("INSERT INTO dispatches(id,dispatch_number,status,site_id,vehicle_plate,driver_id,modalidad,scheduled_departure) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '1 day')",[route,`D-${n}`,status,site,plate,id(n+2000),mode])
   return route
  }
  const route=await setup(100)
  await db.query("INSERT INTO dispatch_requests(dispatch_id,transport_request_id,status) VALUES($1,$2,'PENDIENTE')",[route,id(500)])
  await db.query("INSERT INTO transport_requests VALUES($1,'PROGRAMADA')",[id(500)])
  await db.query("INSERT INTO delivery_conformities VALUES($1,$2,'PENDIENTE')",[route,id(500)])
  await db.query("INSERT INTO trip_settlements VALUES($1,'ABIERTO',0)",[route])
  await db.query("INSERT INTO contract_budgets VALUES($1,100,20)",[id(500)])
  const reason='Incidencia de acceso: falta autorización del cliente.'
  const beforeFinancial=await scalar('SELECT jsonb_agg(to_jsonb(t)) AS v FROM trip_settlements t')
  const beforeBudget=await scalar('SELECT jsonb_agg(to_jsonb(t)) AS v FROM contract_budgets t')
  assert.equal((await close(route,reason)).status,'CIERRE_OPERATIVO')
  assert.equal(await scalar('SELECT status AS v FROM vehicles WHERE plate=$1',['TEST-100']),'DISPONIBLE')
  assert.equal(await scalar('SELECT operational_previous_status AS v FROM dispatches WHERE id=$1',[route]),'PROGRAMADO')
  assert.equal(await scalar("SELECT operational_closed_at<daily_cutoff_at AS v FROM dispatches WHERE id=$1",[route]),true,'manual closure works before midnight')
  const event=await scalar("SELECT to_jsonb(e) AS v FROM dispatch_events e WHERE dispatch_id=$1 AND event_type='CIERRE_OPERATIVO_MANUAL'",[route])
  assert.equal(event.payload.reason,reason);assert.equal(event.payload.source,'MANUAL');assert.equal(event.created_by_user,id(50));assert.equal(event.payload.previous_status,'PROGRAMADO')
  assert.ok(!event.description.includes(reason),'free-text explanation stays private from public tracking descriptions')
  assert.ok(!event.description.includes('00:00'))
  assert.equal(await scalar("SELECT count(*)::int AS v FROM dispatch_events WHERE event_type='CORTE_DIARIO'"),0,'no fake midnight event')
  assert.deepEqual(await scalar('SELECT jsonb_agg(to_jsonb(t)) AS v FROM trip_settlements t'),beforeFinancial)
  assert.deepEqual(await scalar('SELECT jsonb_agg(to_jsonb(t)) AS v FROM contract_budgets t'),beforeBudget)
  assert.equal(await scalar('SELECT status AS v FROM dispatch_requests WHERE dispatch_id=$1',[route]),'PENDIENTE')
  assert.equal(await scalar('SELECT status AS v FROM transport_requests WHERE id=$1',[id(500)]),'PROGRAMADA')
  assert.equal(await scalar('SELECT state AS v FROM delivery_conformities WHERE dispatch_id=$1',[route]),'PENDIENTE')
  assert.equal((await close(route)).already_closed,true)
  assert.equal(await scalar("SELECT count(*)::int AS v FROM dispatch_events WHERE dispatch_id=$1 AND event_type='CIERRE_OPERATIVO_MANUAL'",[route]),1,'retries do not duplicate closure audit')
  await assert.rejects(db.query("UPDATE dispatches SET status='PROGRAMADO' WHERE id=$1",[route]),/tiene cierre operativo/)
  for(const [n,status] of [[101,'EN_CURSO'],[102,'EN RUTA'],[103,'ESPERANDO_AUTORIZACION'],[104,'RETORNO'],[105,'ENTREGADO']]) {
   const current=await setup(n,status,'PROPIA','EN_RUTA');assert.equal((await close(current)).success,true)
   assert.equal(await scalar('SELECT status AS v FROM vehicles WHERE plate=$1',[`TEST-${n}`]),'DISPONIBLE')
  }
  const third=await setup(106,'EN_CURSO','TERCERO')
  await close(third);assert.equal(await scalar('SELECT status AS v FROM vehicles WHERE plate=$1',['TEST-106']),'EN_OPERACION','third-party closure does not modify own assets')
  const observed=await setup(107)
  await db.exec("SELECT set_config('test.eligible','false',false)");await close(observed)
  assert.equal(await scalar('SELECT status AS v FROM vehicles WHERE plate=$1',['TEST-107']),'OBSERVADA')
  await db.exec("SELECT set_config('test.eligible','true',false)")
  const shared=await setup(108,'ENTREGADO')
  await db.query("INSERT INTO dispatches(id,status,site_id,vehicle_plate,scheduled_departure) VALUES($1,'PROGRAMADO',$2,'TEST-108',now()+interval '1 day')",[id(109),id(1)])
  await close(shared);assert.equal(await scalar('SELECT status AS v FROM vehicles WHERE plate=$1',['TEST-108']),'EN_OPERACION','another route owns the unit')
  const pending=await setup(110)
  for(const reason of ['', 'corto','          ','\n\n\n\n\n\n\n\n\n\n','x'.repeat(501)]) await assert.rejects(close(pending,reason),/10 y 500/)
  for(const [setting,value] of [['active','false'],['write','false'],['read','false'],['portfolio','false'],['user','']]) {
   await db.query('SELECT set_config($1,$2,false)',['test.'+setting,value]);await assert.rejects(close(pending),/Sin sesión|Sin permiso/)
   await db.query('SELECT set_config($1,$2,false)',['test.'+setting,setting==='user'?id(50):'true'])
  }
  assert.equal(await scalar('SELECT status AS v FROM dispatches WHERE id=$1',[pending]),'PROGRAMADO')
  await assert.rejects(close(await setup(111,'PROGRAMADO','PROPIA','EN_OPERACION',id(2))),/Sin permiso/)
  await assert.rejects(close(await setup(112,'CANCELADO')),/no permite/)
  assert.equal(await scalar("SELECT has_function_privilege('anon','manual_close_dispatch_operations(uuid,text)','EXECUTE') AS v"),false)
  assert.equal(await scalar("SELECT has_function_privilege('authenticated','manual_close_dispatch_operations(uuid,text)','EXECUTE') AS v"),true)
  assert.notEqual(await scalar("SELECT current_setting('jrm.cierre_operativo_manual',true) AS v"),'on','manual authorization flag does not leak outside the transaction')
  const dailyRoute=await setup(113)
  await assert.rejects(db.query("UPDATE dispatches SET status='CIERRE_OPERATIVO' WHERE id=$1",[dailyRoute]),/00:00/,'automatic cutoff still requires midnight')
  const automatic=await setup(114)
  await db.query("UPDATE dispatches SET scheduled_departure=now()-interval '2 days' WHERE id=$1",[automatic])
  await db.query("UPDATE dispatches SET status='CIERRE_OPERATIVO' WHERE id=$1",[automatic])
  assert.equal(await scalar("SELECT count(*)::int AS v FROM dispatch_events WHERE dispatch_id=$1 AND event_type='CORTE_DIARIO'",[automatic]),1,'automatic midnight closure keeps its existing event')
  await assert.rejects(db.exec(readFileSync('supabase/tests/caja_c161_manual_operational_close.test.sql','utf8')),/CAJA C161 PASS/)
  await db.exec('ROLLBACK')
  console.log('PASS manual operational closure: reason/actor audit, idempotence, resource release and eligibility, third-party, site/portfolio/inactive authorization; financial/documentary state preserved')
 }finally{await db.close()}
})().catch(error=>{console.error(error);process.exitCode=1})
