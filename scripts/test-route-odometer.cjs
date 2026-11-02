const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { PGlite } = require('@electric-sql/pglite')

const uid = '00000000-0000-4000-8000-000000000001'
const dispatch = '00000000-0000-4000-8000-000000000010'
const request = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
// Odómetro por ingreso manual (parada y checklist): la migración vigente se aplica completa
const migration = readFileSync('supabase/migrations/20261219090000_odometro_manual_parada_checklist.sql', 'utf8')

async function main() {
  const db = new PGlite()
  await db.exec(`CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.dispatches(id uuid PRIMARY KEY, vehicle_plate text, modalidad text, start_odometer numeric);
    CREATE TABLE public.dispatch_requests(dispatch_id uuid, transport_request_id uuid, sequence_order integer,
      leg_actual_km numeric, leg_gps_complete boolean, stop_odometer numeric, stop_odometer_photo text,
      stop_odometer_at timestamptz, stop_odometer_flag text, leg_odometer_km numeric, leg_km_source text,
      PRIMARY KEY(dispatch_id,transport_request_id));
    CREATE TABLE public.unit_odometer_readings(operation_id uuid PRIMARY KEY, vehicle_plate text NOT NULL, driver_id uuid, unit_revision uuid,
      operation_date date NOT NULL, kind text NOT NULL, odometer numeric(12,1) NOT NULL, photo_path text NOT NULL, previous_odometer numeric(12,1),
      flag text, captured_at timestamptz NOT NULL, created_by uuid, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.vehicles(plate text PRIMARY KEY, current_odometer numeric);
    INSERT INTO public.vehicles VALUES('ABC-123',90);
    CREATE TABLE storage.objects(bucket_id text,name text);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[split_part($1,'/',1)] $$;
    CREATE FUNCTION public.start_dispatch_route(uuid,numeric,numeric) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'Sin GPS: registre el odómetro inicial con foto en el checklist FR-DT 007 antes de iniciar'; END $$;
    CREATE FUNCTION public.delivery_submit_driver(uuid,uuid,text[],text,text,text,uuid,timestamptz) RETURNS jsonb
      LANGUAGE plpgsql AS $$ BEGIN
        UPDATE public.dispatch_requests SET leg_actual_km=CASE WHEN $2='${request(3)}'::uuid THEN 4 END,
          leg_gps_complete=($2='${request(3)}'::uuid) WHERE dispatch_id=$1 AND transport_request_id=$2;
        RETURN jsonb_build_object('success',true,'pending_review',true);
      END $$;
    INSERT INTO public.dispatches VALUES('${dispatch}','ABC-123','PROPIA',100);
    INSERT INTO public.dispatch_requests(dispatch_id,transport_request_id,sequence_order) VALUES
      ('${dispatch}','${request(1)}',1),('${dispatch}','${request(2)}',2),('${dispatch}','${request(3)}',3),('${dispatch}','${request(4)}',4);
    INSERT INTO storage.objects VALUES('driver_evidence','${uid}/stop-2.jpg');
    SET request.jwt.claim.sub='${uid}';`)
  await db.exec(migration)
  const call = (n, km, photo = null) => db.query(`SELECT public.delivery_submit_driver_with_odometer(
    '${dispatch}','${request(n)}',ARRAY['guide.jpg'],'Cliente',NULL,'G-1','${request(100+n)}',now(),${km},${photo == null ? 'NULL' : `'${photo}'`}) AS result`)

  // Parada: solo el número digitado; una foto (cola offline antigua) se acepta si existe
  await call(1, 112.5)
  await call(2, 120, `${uid}/stop-2.jpg`)
  await call(3, 128)
  const rows = await db.query(`SELECT sequence_order,leg_actual_km,leg_odometer_km,leg_km_source,stop_odometer_photo
    FROM dispatch_requests WHERE dispatch_id='${dispatch}' ORDER BY sequence_order`)
  const numericOrNull = value => value == null ? null : Number(value)
  assert.deepEqual(rows.rows.map(r => [numericOrNull(r.leg_actual_km), numericOrNull(r.leg_odometer_km), r.leg_km_source, r.stop_odometer_photo]), [
    [12.5,12.5,'ODOMETRO',null], [7.5,7.5,'ODOMETRO',`${uid}/stop-2.jpg`], [4,8,'GPS_COMPLETO',null], [null,null,null,null],
  ])
  await assert.rejects(call(4, 127), /no puede ser menor/)
  await assert.rejects(call(4, 0), /Ingrese el odómetro/)
  await assert.rejects(call(4, 130, `${uid}/missing.jpg`), /no se encontró/)
  await call(4, 1800)
  const anomaly = await db.query(`SELECT leg_km_source,stop_odometer_flag,leg_actual_km FROM dispatch_requests WHERE dispatch_id='${dispatch}' AND transport_request_id='${request(4)}'`)
  assert.deepEqual({ ...anomaly.rows[0], leg_actual_km: Number(anomaly.rows[0].leg_actual_km) }, { leg_km_source: 'ODOMETRO', stop_odometer_flag: 'SALTO', leg_actual_km: 1672 })

  // Checklist / cierre: lectura manual sin foto; retroceso y salto quedan marcados sin bloquear
  const record = (op, km, photo = 'NULL') => db.query(`SELECT (r).flag, (r).photo_path, (r).previous_odometer::float AS previous_odometer FROM (SELECT public.unit_odometer_record(
    '${request(200+op)}','ABC-123',NULL,'2026-11-02','INICIO','${km}',${photo},now()+interval '${op} hour','${uid}',NULL) AS r) x`)
  assert.deepEqual((await record(1, '2000')).rows[0], { flag: null, photo_path: null, previous_odometer: null })
  assert.deepEqual((await record(2, '1990,5')).rows[0], { flag: 'RETROCESO', photo_path: null, previous_odometer: 2000 })
  assert.equal((await record(3, '3600')).rows[0].flag, 'SALTO')
  await assert.rejects(record(4, 'abc'), /Ingrese el odómetro/)
  await assert.rejects(record(4, '3700', `'${uid}/missing.jpg'`), /no se encontró/)
  assert.equal(Number((await db.query(`SELECT current_odometer FROM vehicles WHERE plate='ABC-123'`)).rows[0].current_odometer), 3600)
  await assert.rejects(db.query(`SELECT public.start_dispatch_route(NULL,NULL,NULL)`), err => /odómetro inicial en el checklist/.test(err.message) && !/con foto/.test(err.message))
  await db.close()
  console.log('PASS: manual odometer by stop and checklist (no photo), GPS precedence, retrograde/jump checks and start message.')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
