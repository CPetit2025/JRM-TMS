const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..'), name = `jrm-hhee-accumulation-${process.pid}`
function docker(args, input) { const r = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 180000 }); if (r.error) throw r.error; return r }
function sql(input) { const r = docker(['exec', '-i', name, 'psql', '-U', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], input); if (r.status) throw Error(r.stderr); return r.stdout.trim() }
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
async function main() {
 try {
  const start = docker(['run', '-d', '--rm', '--network', 'none', '--name', name, '-e', 'POSTGRES_PASSWORD=isolated-test', 'postgres:16-alpine']); if (start.status) throw Error(start.stderr)
  let ready = false
  for (let i = 0; i < 40; i++) { if (!docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status) { ready = true; break } await new Promise(r => setTimeout(r, 250)) }
  assert.ok(ready)
  sql(`CREATE TABLE hhee_requests(id uuid PRIMARY KEY,sequence bigint,work_date date,state text,approval text);
   CREATE TABLE hhee_lines(request_id uuid,person_id uuid,planned_minutes int,plan_minutes_25 int,plan_minutes_35 int,plan_minutes_100 int,rest_day boolean);
   CREATE FUNCTION hhee_pe_holiday(d date) RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;`)
  const migration = read('supabase/migrations/20261021070000_hhee_calculo_legal_consolidado.sql'), begin = migration.indexOf('CREATE OR REPLACE FUNCTION public.hhee_flow_split(')
  sql(migration.slice(begin, migration.indexOf('END $$;', begin) + 7))
  const box = read('supabase/tests/caja_c128_rutas_auxiliar_hhee_auto.test.sql'), check = box.slice(box.indexOf('  -- T5:'), box.indexOf('  -- T6:'))
  // Misma aserción de producción; el cálculo real usa las solicitudes anteriores de cada persona.
  for (const prior of [0, 90, 120, 210]) {
   const result = sql(`TRUNCATE hhee_lines,hhee_requests;
    INSERT INTO hhee_requests VALUES('00000000-0000-4000-8000-000000000001',1,'2026-10-20','BORRADOR','PENDIENTE'),
     ('00000000-0000-4000-8000-000000000002',2,'2026-10-20','BORRADOR','PENDIENTE'),
     ('00000000-0000-4000-8000-000000000003',3,'2026-10-20','CANCELADA','PENDIENTE'),
     ('00000000-0000-4000-8000-000000000004',4,'2026-10-20','BORRADOR','RECHAZADA'),
     ('00000000-0000-4000-8000-000000000005',5,'2026-10-20','BORRADOR','PENDIENTE'),
     ('00000000-0000-4000-8000-000000000006',6,'2026-10-20','BORRADOR','PENDIENTE');
    INSERT INTO hhee_lines VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000010',${prior},least(${prior},120),greatest(${prior}-120,0),0,false);
    -- Canceladas, rechazadas y solicitudes posteriores no consumen las primeras dos horas de esta solicitud.
    INSERT INTO hhee_lines SELECT id,'00000000-0000-4000-8000-000000000010',180,120,60,0,false FROM hhee_requests WHERE sequence IN(3,4,6);
    INSERT INTO hhee_lines SELECT '00000000-0000-4000-8000-000000000005',p,150,(s->>'m25')::int,(s->>'m35')::int,(s->>'m100')::int,false
     FROM unnest(ARRAY['00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000011']::uuid[]) p
     CROSS JOIN LATERAL hhee_flow_split(p,'2026-10-20',150,false,'00000000-0000-4000-8000-000000000005') s;
    DO $$ DECLARE v_id uuid:='00000000-0000-4000-8000-000000000005';pass int:=0;fails text[]:='{}'; BEGIN
     ${check}
     IF pass<>1 OR cardinality(fails)>0 THEN RAISE EXCEPTION 'C128 con % minutos previos: %',${prior},fails; END IF;
    END $$;
    SELECT plan_minutes_25||'/'||plan_minutes_35 FROM hhee_lines WHERE request_id='00000000-0000-4000-8000-000000000005' AND person_id='00000000-0000-4000-8000-000000000010';`)
   assert.match(result, new RegExp(`${Math.min(150, Math.max(0, 120 - prior))}/${150 - Math.min(150, Math.max(0, 120 - prior))}$`))
  }
  console.log('PASS C128: reparto legal con 0, 90, 120 y 210 minutos previos; canceladas, rechazadas, posteriores y otras personas no se acumulan indebidamente.')
 } finally { docker(['rm', '-f', name]) }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
