// PostgreSQL WASM aislado: jamás usa credenciales ni la base del TMS.
const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const read = p => readFileSync(path.join(root, p), 'utf8')
const migration = 'supabase/migrations/20261029090000_gestion_personal.sql'
function fn(file, name) {
 const s = read(file), match = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(`).exec(s)
 if (!match) throw Error('No se encuentra '+name)
 const start = match.index, body = s.indexOf('$$', start), end = s.indexOf('$$;', body + 2)
 return s.slice(start, end + 3)
}
async function main() {
 const db = new PGlite()
 try {
  await db.exec(read('scripts/fixtures/hhee-schema.sql'))
  for (const f of ['20261020210000_hhee_control.sql','20261020220000_hhee_production_scope.sql','20261021040000_hhee_distribucion_estimaciones.sql','20261021050000_hhee_flujo_simple.sql']) await db.exec(read('supabase/migrations/'+f))
  await db.exec(`ALTER TABLE hhee_people ADD COLUMN driver_id uuid;
   ALTER TABLE hhee_requests ADD COLUMN auto_dispatch_id uuid;
   ALTER TABLE hhee_lines ADD COLUMN compensation boolean DEFAULT false NOT NULL, ADD COLUMN dispatch_number text,
    ADD COLUMN rest_day boolean DEFAULT false NOT NULL, ADD COLUMN driver_dispatch_id uuid, ADD COLUMN vehicle_plate text, ADD COLUMN plate_source text,
    ADD COLUMN plate_reason text, ADD COLUMN exec_minutes_25 int, ADD COLUMN exec_minutes_35 int, ADD COLUMN exec_minutes_100 int, ADD COLUMN exec_cost numeric;
   CREATE TABLE hhee_comp_rests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),person_id uuid,rest_date date,minutes int,note text,created_by uuid,created_at timestamptz DEFAULT now(),cancelled_at timestamptz,cancelled_by uuid);
   CREATE TABLE dispatches(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),driver_id uuid,vehicle_plate text,status text,started_at timestamptz,created_by uuid);
   CREATE TABLE route_auxiliaries(dispatch_id uuid,person_id uuid);
   CREATE TABLE dispatch_crew(dispatch_id uuid,profile_id uuid,removed_at timestamptz,crew_role text);
   CREATE FUNCTION hhee_person_for(d uuid,p uuid,a uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM hhee_people WHERE driver_id=d OR profile_id=p LIMIT 1 $$;
  `)
  await db.exec(fn('supabase/migrations/20261021070000_hhee_calculo_legal_consolidado.sql','hhee_pe_holiday'))
  await db.exec(fn('supabase/migrations/20261021070000_hhee_calculo_legal_consolidado.sql','hhee_flow_split'))
  await db.exec(fn('supabase/migrations/20261022150000_hhee_solicitudes_trabajadores_unicos.sql','hhee_person_day_conflict'))
  await db.exec(fn('supabase/migrations/20261022150000_hhee_solicitudes_trabajadores_unicos.sql','hhee_route_request_for'))
  await db.exec(fn('supabase/migrations/20261021110000_hhee_cierre_ruta_compensacion.sql','hhee_line_set_compensation'))
  await db.exec(read(migration))
  await db.exec(`SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false)`)
  const scalar = async (sql, params=[]) => (await db.query(sql, params)).rows[0].v
  const rpc = async (name, p) => scalar(`SELECT ${name}($1::jsonb) AS v`, [JSON.stringify(p)])
  const area = await scalar(`SELECT id AS v FROM hhee_areas WHERE name='Distribución'`)
  const person = await scalar(`INSERT INTO hhee_people(code,name,area_id) VALUES('GP01','Persona sintética',$1) RETURNING id AS v`,[area])
  const other = await scalar(`INSERT INTO hhee_people(code,name,area_id) VALUES('GP02','Persona rotativa',$1) RETURNING id AS v`,[area])
  const date = await scalar(`SELECT ((now() AT TIME ZONE 'America/Lima')::date-1)::text AS v`)
  const tomorrow = await scalar(`SELECT ((now() AT TIME ZONE 'America/Lima')::date+1)::text AS v`)
  const day = async () => scalar('SELECT gp_day($1::uuid,$2::date) AS v',[area,date])
  const balance = async () => scalar('SELECT hhee_comp_balance_of($1::uuid) AS v',[person])
  const week = Array.from({length:7},()=>({kind:'TRABAJO',start:'08:00',end:'17:00',break_minutes:60}))
  await rpc('gp_schedule_save',{person_id:person,from:date,mode:'FIJO',week})
  await rpc('gp_schedule_save',{person_id:other,from:date,mode:'ROTATIVO',week})
  assert.equal((await day()).day,null)
  assert.equal((await day()).rows.find(x=>x.person_id===other).shift.kind,'SIN_HORARIO')
  await assert.rejects(rpc('gp_day_confirm',{area_id:area,date,revision:0,absences:[]}),/Falta programar/)
  assert.equal((await day()).day,null,'la confirmación fallida es atómica')
  await rpc('gp_shift_day_save',{person_id:other,date,reason:'Descanso programado',shift:{kind:'DESCANSO'}})
  let d = await rpc('gp_day_confirm',{area_id:area,date,revision:0,absences:[{person_id:person,note:'Ausencia por justificar'}]})
  assert.equal(d.rows.find(x=>x.person_id===person).status,'AUSENTE')
  assert.equal(d.rows.find(x=>x.person_id===other).status,'DESCANSO')
  await assert.rejects(rpc('gp_day_confirm',{area_id:area,date,revision:0,absences:[]}),/cambió/)
  await assert.rejects(rpc('gp_day_confirm',{area_id:area,date:tomorrow,revision:0,absences:[]}),/Solo se confirma/)
  await assert.rejects(rpc('gp_day_confirm',{area_id:area,date,revision:1,absences:[]}),/corrección/)
  d = await rpc('gp_day_confirm',{area_id:area,date,revision:1,reason:'Corrección verificada',absences:[]})
  assert.equal(d.rows.find(x=>x.person_id===person).status,'ASISTENCIA_DECLARADA')
  assert.equal(d.day.revision,2)
  await assert.rejects(rpc('gp_shift_day_save',{person_id:person,date,reason:'Cambiar histórico',shift:week[0]}),/confirmada/)
  console.log('PASS asistencia: programación, rotación, descansos, confirmación atómica y corrección versionada')

  const cause = await scalar('SELECT id AS v FROM hhee_causes LIMIT 1')
  const request = await scalar(`INSERT INTO hhee_requests(area_id,cause_id,work_date,activity,justification,alternatives,expected_result,created_by,approval,state)
   VALUES($1,$2,$3,'Prueba de HHEE','Sustento sintético','Alternativa evaluada','Resultado esperado','00000000-0000-4000-8000-000000000001','APROBADA','SOLICITADA') RETURNING id AS v`,[area,cause,date])
  const line = await scalar(`INSERT INTO hhee_lines(request_id,person_id,person_name,person_code,planned_start,planned_end,planned_minutes,actual_start,actual_end,actual_minutes,compensation)
   VALUES($1,$2,'Persona sintética','GP01',now()-interval '5 hours',now()-interval '1 hour',240,now()-interval '5 hours',now()-interval '1 hour',240,true) RETURNING id AS v`,[request,person])
  assert.equal((await balance()).earned,0,'cerrar no acredita saldo')
  assert.equal((await balance()).legacy_unvalidated,240)
  await rpc('gp_overtime_validate',{id:request,version:1,reason:'Ejecución revisada'})
  assert.equal((await balance()).earned,240)
  await assert.rejects(rpc('gp_overtime_validate',{id:request,version:2,reason:'Validación repetida'}),/ya están/)
  await assert.rejects(db.query('UPDATE hhee_lines SET compensation=false WHERE id=$1',[line]),/inmutables/)
  await assert.rejects(db.query(`UPDATE hhee_requests SET state='CANCELADA' WHERE id=$1`,[request]),/No se anulan/)
  console.log('PASS HHEE: crédito solo al validar, sin doble acreditación ni cambio a pago posterior')

  const create = min => rpc('gp_permit',{action:'CREATE',person_id:person,date,minutes:min,kind:'REGULARIZACION',compensation:true,reason:'Regularización solicitada'})
  let p = (await create(180)).permit
  const decide = (action,permit) => rpc('gp_permit',{id:permit.id,revision:permit.revision,action,reason:'Decisión registrada'})
  assert.equal((await balance()).reserved,0,'una solicitud no aprobada no reserva')
  p = (await decide('APPROVE',p)).permit
  assert.equal((await balance()).reserved,180);assert.equal((await balance()).balance,60)
  const second = (await create(100)).permit
  await assert.rejects(decide('APPROVE',second),/Saldo insuficiente/)
  await assert.rejects(decide('APPROVE',{...p,revision:1}),/cambió/)
  p = (await decide('APPLY',p)).permit
  assert.equal((await balance()).taken,180);assert.equal((await balance()).reserved,0);assert.equal((await balance()).balance,60)
  await assert.rejects(decide('APPLY',p),/Transición/)
  await assert.rejects(scalar('SELECT hhee_comp_rest_cancel($1::uuid) AS v',[p.rest_id]),/permiso asociado/)
  p = (await decide('CANCEL',p)).permit
  assert.equal((await balance()).taken,0);assert.equal((await balance()).balance,240)
  await assert.rejects(decide('CANCEL',p),/Transición/)
  await decide('REJECT',second)
  let full = (await rpc('gp_permit',{action:'CREATE',person_id:person,date,minutes:480,kind:'REGULARIZACION',compensation:false,reason:'Regularización de jornada completa'})).permit
  full = (await decide('APPROVE',full)).permit
  assert.equal((await day()).rows.find(x=>x.person_id===person).status,'PERMISO')
  assert.equal((await day()).rows.find(x=>x.person_id===person).recorded_status,'ASISTENCIA_DECLARADA')
  full = (await decide('CANCEL',full)).permit
  assert.equal((await day()).rows.find(x=>x.person_id===person).status,'ASISTENCIA_DECLARADA')
  console.log('PASS permisos: reserva, aplicación, saldo insuficiente, repetición y reversión trazable')

  const driver = '00000000-0000-4000-8000-000000000003'
  const routePerson = await scalar(`INSERT INTO hhee_people(code,name,area_id,driver_id) VALUES('GP03','Ruta sintética',$1,$2) RETURNING id AS v`,[area,driver])
  await rpc('gp_schedule_save',{person_id:routePerson,from:'2025-03-01',mode:'FIJO',week})
  await db.exec(`INSERT INTO hhee_causes(name) SELECT 'Ruta extendida fuera del horario' WHERE NOT EXISTS(SELECT 1 FROM hhee_causes WHERE name='Ruta extendida fuera del horario')`)
  const dispatch = await scalar(`INSERT INTO dispatches(driver_id,vehicle_plate,started_at,created_by) VALUES($1,'TEST-01','2025-03-03 08:00:00-05','00000000-0000-4000-8000-000000000001') RETURNING id AS v`,[driver])
  assert.equal(await scalar(`SELECT (gp_overtime_start($1,'2025-03-03',$2) AT TIME ZONE 'America/Lima')::time::text AS v`,[routePerson,dispatch]),'17:00:00')
  assert.equal((await scalar(`SELECT hhee_route_request_for($1,'2025-03-03 16:30:00-05') AS v`,[dispatch])).created,false)
  const generated = await scalar(`SELECT hhee_route_request_for($1,'2025-03-03 18:15:00-05') AS v`,[dispatch])
  assert.equal(generated.created,true)
  assert.equal((await scalar(`SELECT hhee_route_request_for($1,'2025-03-03 18:20:00-05') AS v`,[dispatch])).created,false)
  assert.equal(await scalar('SELECT count(*)::int AS v FROM hhee_lines WHERE request_id=$1',[generated.id]),1)
  assert.equal(await scalar('SELECT planned_minutes AS v FROM hhee_lines WHERE request_id=$1',[generated.id]),120)
  const late = await scalar(`INSERT INTO hhee_people(code,name,area_id) VALUES('GP04','Turno tardío',$1) RETURNING id AS v`,[area])
  await rpc('gp_schedule_save',{person_id:late,from:'2025-03-01',mode:'FIJO',week:Array.from({length:7},()=>({kind:'TRABAJO',start:'10:00',end:'19:00',break_minutes:60}))})
  await db.query('INSERT INTO route_auxiliaries(dispatch_id,person_id) VALUES($1,$2)',[dispatch,late])
  assert.equal((await scalar(`SELECT hhee_route_request_for($1,'2025-03-03 18:30:00-05') AS v`,[dispatch])).created,false)
  const appended = await scalar(`SELECT hhee_route_request_for($1,'2025-03-03 19:15:00-05') AS v`,[dispatch])
  assert.equal(appended.updated,true)
  assert.equal(await scalar('SELECT count(*)::int AS v FROM hhee_lines WHERE request_id=$1',[generated.id]),2)
  assert.equal(await scalar('SELECT planned_minutes AS v FROM hhee_lines WHERE request_id=$1 AND person_id=$2',[generated.id,late]),60)
  await rpc('gp_shift_day_save',{person_id:late,date:'2025-03-04',reason:'Turno nocturno programado',shift:{kind:'TRABAJO',start:'22:00',end:'06:00',break_minutes:0}})
  assert.equal(await scalar(`SELECT (gp_shift($1,'2025-03-04')->>'minutes')::int AS v`,[late]),480)

  console.log('PASS rutas: fin del turno individual, generación automática y ausencia de duplicados')

  const restricted = await scalar(`INSERT INTO roles(name,permissions) VALUES('Supervisor de prueba','["hhee:read","hhee-solicitar:write","hhee-aprobar:write"]') RETURNING id AS v`)
  await db.query(`UPDATE profiles SET role_id=$1 WHERE id='00000000-0000-4000-8000-000000000002'`,[restricted])
  await db.query(`INSERT INTO hhee_memberships(user_id,area_id) VALUES('00000000-0000-4000-8000-000000000002',$1) ON CONFLICT DO NOTHING`,[area])
  await db.exec(`INSERT INTO user_site_access SELECT '00000000-0000-4000-8000-000000000002',id FROM sites; SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false)`)
  await assert.rejects(decide('APPROVE',second),/Solo Administrador/)
  await db.exec(`SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false)`)
  console.log('PASS roles: el permiso técnico de aprobar no sustituye el rol comercial autorizado')

  const report = await rpc('gp_overview',{from:date,to:tomorrow})
  assert.equal(Number(report.overtime[0].validated_minutes),240)
  assert.equal(report.balances.find(x=>x.person_id===person).balance.balance,240)
  assert.ok(report.events.length>0)
  const priv = await scalar(`SELECT has_table_privilege('authenticated','gp_permits','SELECT') AS v`)
  assert.equal(priv,false)
  await db.exec(`SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000009999',false)`)
  await assert.rejects(rpc('gp_permit',{action:'CREATE',person_id:person,date,minutes:10,kind:'PERMISO',reason:'Sin permisos'}),/Sin permiso/)
  await assert.rejects(day(),/Sin acceso/)
  console.log('PASS reportes reconciliados, trazabilidad y permisos de acceso')
 } finally { await db.close() }
}
main().catch(e=>{console.error(e.message, e.detail || '', e.where || '');process.exitCode=1})

