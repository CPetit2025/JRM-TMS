// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Auditoría 5 a 8: un gasto de un anticipo liquidado no se revisa; revisión y registro de gastos toman un bloqueo
// compartido del viaje o anticipo (la espera entre dos sesiones no se simula en PGlite: se verifica que el bloqueo
// quede antes de la verificación); la etiqueta de vencidos no se ejecuta directo; cuota de 5 autorizaciones.
const assert = require('node:assert/strict')
const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const read = p => readFileSync(p, 'utf8')
const fn = (file, name) => { const s = read(file), a = s.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`) >= 0 ? s.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`) : s.indexOf(`CREATE FUNCTION public.${name}(`)
 assert(a >= 0, name); return s.slice(a, s.indexOf('END $$;', a) + 7) }
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
;(async () => {
 const db = new PGlite()
 try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT '${id(9)}'::uuid$$;
   CREATE FUNCTION is_tms_admin() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
   CREATE FUNCTION has_tms_permission(text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
   CREATE FUNCTION can_access_site(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
   CREATE TABLE trip_advances(id uuid PRIMARY KEY, settled boolean DEFAULT false);
   CREATE FUNCTION caja_advance_is_settled(p uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE((SELECT settled FROM trip_advances WHERE id = p), false)$$;
   CREATE FUNCTION caja_trip_is_settled(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
   CREATE TABLE dispatches(id uuid PRIMARY KEY, vehicle_plate text, site_id uuid, driver_id uuid);
   CREATE TABLE drivers(id uuid PRIMARY KEY, profile_id uuid);
   CREATE TABLE caja_settings(id boolean PRIMARY KEY DEFAULT true, double_approval_threshold numeric);
   CREATE TABLE dispatch_expenses(id uuid PRIMARY KEY, dispatch_id uuid, advance_id uuid, driver_id uuid, site_id uuid, created_by uuid,
    status text DEFAULT 'APROBADO', amount numeric, approved_amount numeric, alerts jsonb DEFAULT '[]');
   ${fn('supabase/migrations/20260929090000_caja_c1_aprobacion_gastos.sql', 'review_dispatch_expense')}
   ${fn('supabase/migrations/20260929160000_caja_c5_anticipos_por_motivo.sql', 'caja_expense_normalize')}
   CREATE FUNCTION caja_driver_overdue_label(uuid, uuid DEFAULT NULL) RETURNS text LANGUAGE sql STABLE AS $$SELECT NULL::text$$;  -- misma firma
   GRANT EXECUTE ON FUNCTION caja_driver_overdue_label(uuid, uuid) TO authenticated;`)
  const sec = read('supabase/migrations/20261008020000_production_security_boundaries.sql')
  const t = sec.indexOf('CREATE TABLE public.registration_request_limits(')
  await db.exec(sec.slice(t, sec.indexOf('GRANT EXECUTE ON FUNCTION public.reserve_registration_attempt', t)))
  const migration = read('supabase/migrations/20261203090000_caja_auditoria_5_9.sql')
  await db.exec(migration); await db.exec(migration)

  // 5) Gasto de un anticipo ya liquidado: no se revierte ni se reaprueba
  await db.exec(`INSERT INTO trip_advances VALUES ('${id(30)}', true); INSERT INTO dispatch_expenses(id, advance_id, amount) VALUES ('${id(40)}','${id(30)}',400)`)
  const r = (await db.query(`SELECT review_dispatch_expense($1,'REVERTIR','corrección') v`, [id(40)])).rows[0].v
  assert.deepEqual([r.success, r.error], [false, 'El anticipo ya fue liquidado: reabra la liquidación para revisar el gasto'])
  // 6) El bloqueo compartido queda antes de cada verificación de liquidación (revisión y registro)
  const def = async s => (await db.query(`SELECT pg_get_functiondef($1::regprocedure) d`, [s])).rows[0].d
  const rv = await def('review_dispatch_expense(uuid,text,text,numeric,boolean)'), nz = await def('caja_expense_normalize()')
  assert(rv.indexOf('FOR SHARE') < rv.indexOf('caja_trip_is_settled(e.dispatch_id)') && rv.split('El anticipo ya fue liquidado: reabra').length === 2)
  assert(nz.indexOf('NEW.advance_id FOR SHARE') < nz.indexOf('caja_advance_is_settled(NEW.advance_id)') && nz.includes('NEW.dispatch_id FOR SHARE'))
  // 7) Nadie ejecuta directo la etiqueta de vencidos
  assert.equal((await db.query(`SELECT has_function_privilege('authenticated','caja_driver_overdue_label(uuid,uuid)','EXECUTE') v`)).rows[0].v, false)
  // 8) Cuota de autorizaciones: 5 por usuario y ventana; los otros ámbitos siguen igual
  const fp = 'a'.repeat(64), quota = async s => (await db.query(`SELECT reserve_registration_attempt($1,$2) v`, [s, fp])).rows[0].v
  const got = []; for (let i = 0; i < 6; i++) got.push(await quota('authorizer'))
  assert.deepEqual(got, [true, true, true, true, true, false])
  assert.equal(await quota('staff'), true)
  await assert.rejects(quota('otro'), /Solicitud inválida/)

  await assert.rejects(db.exec(read('supabase/tests/caja_c205_auditoria_5_9.test.sql')), /CAJA C205 PASS/)
  console.log('PASS auditoría 5 a 8: anticipo liquidado cerrado a revisión, bloqueos de liquidación, vencidos protegidos y cuota de autorizaciones')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
