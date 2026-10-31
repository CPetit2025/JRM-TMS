// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Operaciones, fase 2: la tripulación corregida desde el Expediente mantiene route_auxiliaries (Personal/HHEE) en sintonía
// con dispatch_crew, y «Finalizar ruta» de Monitoreo es una sola operación (sin evento FIN_RUTA si la ruta no avanza).
const { PGlite } = require('@electric-sql/pglite')
const fs = require('node:fs'), assert = require('node:assert/strict')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const shape = fs.readFileSync('scripts/security/production-shape.sql','utf8')
const table = name => { const start = shape.indexOf(`CREATE TABLE public."${name}" (`); assert.ok(start >= 0, name); return shape.slice(start, shape.indexOf(';', start) + 1) }
;(async () => {
 const db = new PGlite()
 try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
   CREATE FUNCTION can_access_site(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
   ${['profiles','dispatches','dispatch_events','dispatch_crew'].map(table).join('\n')}
   CREATE TABLE hhee_people(id uuid PRIMARY KEY, name text, profile_id uuid, active boolean NOT NULL DEFAULT true);
   CREATE TABLE route_auxiliaries(dispatch_id uuid, person_id uuid, assigned_by uuid, assigned_at timestamptz DEFAULT now(), PRIMARY KEY (dispatch_id, person_id));
   -- Máquina de estados simplificada: ENTREGADO solo con todas las paradas entregadas (test.stops_delivered)
   CREATE FUNCTION transition_dispatch_status(p_dispatch_id uuid, p_new_status text, p_reason text DEFAULT NULL, p_user_id uuid DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql AS $$BEGIN
     IF current_setting('test.stops_delivered', true) <> 'true' THEN RETURN jsonb_build_object('success', false, 'error', 'Hay paradas sin entregar'); END IF;
     UPDATE dispatches SET status = p_new_status WHERE id = p_dispatch_id; RETURN jsonb_build_object('success', true); END$$;
   INSERT INTO profiles(id, first_name, is_active) VALUES ('${id(1)}','Aux uno',true), ('${id(2)}','Aux dos',true), ('${id(3)}','Sin ficha',true), ('${id(4)}','Supervisor',true);
   INSERT INTO hhee_people VALUES ('${id(11)}','Aux uno','${id(1)}',true), ('${id(12)}','Aux dos','${id(2)}',true);
   INSERT INTO dispatches(id, status) VALUES ('${id(20)}','PROGRAMADO'), ('${id(21)}','EN RUTA'), ('${id(22)}','PROGRAMADO');
   -- Desalineada antes de la migración: auxiliar retirado en el Expediente que sigue en route_auxiliaries, y otro agregado sin su fila
   INSERT INTO route_auxiliaries(dispatch_id, person_id) VALUES ('${id(22)}','${id(11)}');
   INSERT INTO dispatch_crew(dispatch_id, profile_id, crew_role, removed_at) VALUES ('${id(22)}','${id(1)}','AUXILIAR',now()), ('${id(22)}','${id(2)}','AUXILIAR',NULL);
   SELECT set_config('test.uid','${id(4)}',false);`)
  const migration = fs.readFileSync('supabase/migrations/20261124090000_operaciones_integridad.sql','utf8')
  assert.doesNotMatch(migration, /FUNCTION public\.(set_dispatch_crew|set_route_auxiliaries|transition_dispatch_status)\(/, 'patched or shared functions are not rewritten')
  await db.exec(migration); await db.exec(migration)
  const aux = async d => (await db.query(`SELECT person_id FROM route_auxiliaries WHERE dispatch_id=$1 ORDER BY person_id`,[d])).rows.map(r => r.person_id)
  assert.deepEqual(await aux(id(22)), [id(12)], 'backfill: removed one out, active one in')

  // Tripulación corregida desde el Expediente (lo que hace set_dispatch_crew)
  await db.query(`INSERT INTO dispatch_crew(id, dispatch_id, profile_id, crew_role) VALUES ($1,$2,$3,'AUXILIAR')`,[id(30),id(20),id(1)])
  await db.query(`INSERT INTO dispatch_crew(id, dispatch_id, profile_id, crew_role) VALUES ($1,$2,$3,'AUXILIAR')`,[id(31),id(20),id(3)])
  assert.deepEqual(await aux(id(20)), [id(11)], 'added auxiliary with a Personal record; one without record is skipped')
  await db.query(`UPDATE dispatch_crew SET crew_role='AUXILIAR' WHERE id=$1`,[id(30)])
  assert.deepEqual(await aux(id(20)), [id(11)], 'no duplicate on repeated updates')
  await db.query(`UPDATE dispatch_crew SET crew_role='ESTIBADOR' WHERE id=$1`,[id(30)])
  assert.deepEqual(await aux(id(20)), [], 'role change removes the auxiliary')
  await db.query(`UPDATE dispatch_crew SET crew_role='AUXILIAR' WHERE id=$1`,[id(30)])
  await db.query(`UPDATE dispatch_crew SET removed_at=now() WHERE id=$1`,[id(30)])
  assert.deepEqual(await aux(id(20)), [], 'removal removes the auxiliary')
  await db.query(`INSERT INTO dispatch_crew(dispatch_id, profile_id, crew_role) VALUES ($1,$2,'AUXILIAR')`,[id(21),id(2)])
  assert.deepEqual(await aux(id(21)), [], 'route already out: history untouched')

  // Finalizar ruta desde Monitoreo
  const finish = (d, reason) => db.query(`SELECT finish_route_supervised($1,$2) AS value`,[d,reason]).then(r => r.rows[0].value)
  const events = async d => Number((await db.query(`SELECT count(*) AS n FROM dispatch_events WHERE dispatch_id=$1 AND event_type='FIN_RUTA'`,[d])).rows[0].n)
  assert.match((await finish(id(21), 'ok')).error, /motivo/)
  await db.exec(`SELECT set_config('test.stops_delivered','false',false)`)
  let r = await finish(id(21), 'Conductor sin batería')
  assert.match(r.error, /paradas sin entregar/)
  assert.deepEqual([await events(id(21)), (await db.query(`SELECT status FROM dispatches WHERE id=$1`,[id(21)])).rows[0].status], [0, 'EN RUTA'], 'nothing registered when the route cannot advance')
  await db.exec(`SELECT set_config('test.stops_delivered','true',false)`)
  r = await finish(id(21), 'Conductor sin batería')
  assert.equal(r.success, true, r.error)
  assert.deepEqual([await events(id(21)), (await db.query(`SELECT status FROM dispatches WHERE id=$1`,[id(21)])).rows[0].status], [1, 'ENTREGADO'])
  assert.match((await db.query(`SELECT description FROM dispatch_events WHERE dispatch_id=$1 AND event_type='FIN_RUTA'`,[id(21)])).rows[0].description, /Intervención del supervisor: Conductor sin batería/)

  await assert.rejects(db.exec(fs.readFileSync('supabase/tests/caja_c197_operaciones_integridad.test.sql','utf8')), /CAJA C197 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  console.log('PASS operaciones integridad: auxiliares de la ruta en sintonía con la tripulación (alta, cambio de función, retiro, corrección de datos) y Finalizar ruta de Monitoreo atómico con motivo')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
