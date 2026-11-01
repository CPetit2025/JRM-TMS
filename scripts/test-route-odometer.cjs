const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { PGlite } = require('@electric-sql/pglite')

const uid = '00000000-0000-4000-8000-000000000001'
const dispatch = '00000000-0000-4000-8000-000000000010'
const request = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const migration = readFileSync('supabase/migrations/20261209110000_km_ruta_odometro_y_reporte.sql', 'utf8')
const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.delivery_submit_driver_with_odometer(')
const end = migration.indexOf('END $$;', start) + 'END $$;'.length
assert.ok(start >= 0 && end > start, 'odometer RPC is present')

async function main() {
  const db = new PGlite()
  await db.exec(`CREATE SCHEMA auth; CREATE SCHEMA storage;
    CREATE TABLE public.dispatches(id uuid PRIMARY KEY, vehicle_plate text, modalidad text, start_odometer numeric);
    CREATE TABLE public.dispatch_requests(dispatch_id uuid, transport_request_id uuid, sequence_order integer,
      leg_actual_km numeric, leg_gps_complete boolean, stop_odometer numeric, stop_odometer_photo text,
      stop_odometer_at timestamptz, stop_odometer_flag text, leg_odometer_km numeric, leg_km_source text,
      PRIMARY KEY(dispatch_id,transport_request_id));
    CREATE TABLE public.unit_odometer_readings(vehicle_plate text, captured_at timestamptz, odometer numeric);
    CREATE TABLE storage.objects(bucket_id text,name text);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[split_part($1,'/',1)] $$;
    CREATE FUNCTION public.delivery_submit_driver(uuid,uuid,text[],text,text,text,uuid,timestamptz) RETURNS jsonb
      LANGUAGE plpgsql AS $$ BEGIN
        UPDATE public.dispatch_requests SET leg_actual_km=CASE WHEN $2='${request(3)}'::uuid THEN 4 END,
          leg_gps_complete=($2='${request(3)}'::uuid) WHERE dispatch_id=$1 AND transport_request_id=$2;
        RETURN jsonb_build_object('success',true,'pending_review',true);
      END $$;
    INSERT INTO public.dispatches VALUES('${dispatch}','ABC-123','PROPIA',100);
    INSERT INTO public.dispatch_requests(dispatch_id,transport_request_id,sequence_order) VALUES
      ('${dispatch}','${request(1)}',1),('${dispatch}','${request(2)}',2),('${dispatch}','${request(3)}',3),('${dispatch}','${request(4)}',4);
    INSERT INTO storage.objects VALUES('driver_evidence','${uid}/stop-1.jpg'),('driver_evidence','${uid}/stop-2.jpg'),
      ('driver_evidence','${uid}/stop-3.jpg'),('driver_evidence','${uid}/stop-4.jpg');
    SET request.jwt.claim.sub='${uid}';`)
  await db.exec(migration.slice(start, end))
  const call = (n, km, photo=`${uid}/stop-${n}.jpg`) => db.query(`SELECT public.delivery_submit_driver_with_odometer(
    '${dispatch}','${request(n)}',ARRAY['guide.jpg'],'Cliente',NULL,'G-1','${request(100+n)}',now(),${km},'${photo}') AS result`)

  await call(1, 112.5)
  await call(2, 120)
  await call(3, 128)
  const rows = await db.query(`SELECT sequence_order,leg_actual_km,leg_odometer_km,leg_km_source,stop_odometer,stop_odometer_flag
    FROM dispatch_requests WHERE dispatch_id='${dispatch}' ORDER BY sequence_order`)
  const numericOrNull = value => value == null ? null : Number(value)
  assert.deepEqual(rows.rows.map(r => [numericOrNull(r.leg_actual_km), numericOrNull(r.leg_odometer_km), r.leg_km_source]), [
    [12.5,12.5,'ODOMETRO'], [7.5,7.5,'ODOMETRO'], [4,8,'GPS_COMPLETO'], [null,null,null],
  ])
  await assert.rejects(call(4, 127), /no puede ser menor/)
  await assert.rejects(call(4, 130, `${uid}/missing.jpg`), /foto del tablero/)
  await call(4, 1800)
  const anomaly = await db.query(`SELECT leg_km_source,stop_odometer_flag,leg_actual_km FROM dispatch_requests WHERE dispatch_id='${dispatch}' AND transport_request_id='${request(4)}'`)
  assert.deepEqual({ ...anomaly.rows[0], leg_actual_km: Number(anomaly.rows[0].leg_actual_km) }, { leg_km_source: 'ODOMETRO', stop_odometer_flag: 'SALTO', leg_actual_km: 1672 })
  await db.close()
  console.log('PASS: odometer delta by stop, GPS precedence, photo enforcement, retrograde rejection and anomaly flag.')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
