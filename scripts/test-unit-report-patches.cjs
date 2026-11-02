const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { PGlite } = require('@electric-sql/pglite')

const read = file => readFileSync(file, 'utf8')
const base = read('supabase/migrations/20261024090000_reporte_unidad_km_referencias.sql')
const patch = (source, marker) => {
  const anchor = source.indexOf(marker)
  assert.ok(anchor >= 0, `patch anchor ${marker} exists`)
  const start = source.indexOf('DO $patch$', anchor)
  const end = source.indexOf('END $patch$;', start)
  assert.ok(start > anchor && end > start, `patch block after ${marker} exists`)
  return source.slice(start, end + 'END $patch$;'.length)
}

async function main() {
  const db = new PGlite()
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
      CREATE TABLE public.vehicles(plate text, type text, status text, site_id uuid, current_odometer numeric);
      CREATE TABLE public.dispatches(id uuid, dispatch_number text, status text, driver_name text, scheduled_departure timestamptz,
        vehicle_plate text, modalidad text, actual_distance_km numeric, estimated_distance_km numeric, actual_distance_source text,
        start_odometer numeric, end_odometer numeric, operational_closed_at timestamptz, returned_at timestamptz, arrival_time timestamptz, liquidation_data jsonb);
      CREATE TABLE public.route_track_points(dispatch_id uuid,cumulative_m numeric);
      CREATE TABLE public.unit_odometer_readings(vehicle_plate text,operation_date date,kind text,captured_at timestamptz,odometer numeric,flag text,photo_path text);
      CREATE TABLE public.driver_preuse_inspections(vehicle_plate text,operation_date date,can_operate boolean,driver_name text);
      CREATE TABLE public.dispatch_requests(dispatch_id uuid,transport_request_id uuid,sequence_order int,status text,leg_actual_km numeric,leg_gps_complete boolean,
        leg_km_source text,stop_odometer numeric,stop_odometer_photo text,stop_odometer_flag text,document_number text);
      CREATE TABLE public.transport_requests(id uuid,request_number text,request_type text,contract_id uuid,client_id uuid,reference_type text,reference_number text,
        pickup_address text,pickup_district text,pickup_province text,pickup_department text,delivery_address text,delivery_district text,delivery_province text,delivery_department text,estimated_weight numeric,reference_supplier_id uuid);
      CREATE TABLE public.contracts(id uuid,code text,client_id uuid);
      CREATE TABLE public.clients(id uuid,business_name text);
      CREATE TABLE public.delivery_conformities(dispatch_id uuid,request_id uuid,state text,current_submission_id uuid);
      CREATE TABLE public.delivery_submissions(id uuid,guide_number text);
      CREATE TABLE public.apt_movements(documento text,peso_kg numeric,active bool,valid bool,kind text);
      CREATE TABLE public.suppliers(id uuid,business_name text);
      CREATE TABLE public.cost_allocations(dispatch_id uuid,status text,amount_pen numeric,kind text,basis text,expense_id uuid,request_id uuid,detail jsonb,created_at timestamptz);
      CREATE TABLE public.dispatch_expenses(id uuid,fuel_gallons numeric,fuel_odometer numeric,expense_type text);
      CREATE FUNCTION public.can_view_unit_report() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION public.can_access_site(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION public.apt_guia_key(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT $1 $$;`)
    const platesMigration = read('supabase/migrations/20261209130000_seguimiento_despachos_datos.sql')
    const platesFn = platesMigration.slice(platesMigration.indexOf('CREATE OR REPLACE FUNCTION public.unit_report_plates()'), platesMigration.indexOf('END $$;', platesMigration.indexOf('CREATE OR REPLACE FUNCTION public.unit_report_plates()')) + 'END $$;'.length)
    await db.exec(platesFn)
    await db.exec(base)
    await db.exec(patch(read('supabase/migrations/20261209100000_referencia_proveedor_y_reporte_costos.sql'), '-- Agrega proveedor y origen'))
    await db.exec(patch(read('supabase/migrations/20261209110000_km_ruta_odometro_y_reporte.sql'), '-- Expone kilómetros por OT'))
    await db.exec(patch(read('supabase/migrations/20261209130000_seguimiento_despachos_datos.sql'), '-- Alcance por sede'))
    const { rows } = await db.query("SELECT pg_get_functiondef('public.unit_daily_report(text,date,date)'::regprocedure) AS def")
    for (const token of ['reference_supplier', 'pickup_address', 'fuel_gallons', 'km_real_source', 'odo_reading', 'odo_photo', 'closed_at', 'odo_start', 'odo_end', 'odo_end_photo']) {
      assert.ok(rows[0].def.includes(token), `patched report includes ${token}`)
    }
    await db.exec(`INSERT INTO public.vehicles(plate,type,status,site_id,current_odometer) VALUES
      ('SITE-A','truck','ACTIVE','00000000-0000-4000-8000-000000000001',100),('SITE-B','truck','ACTIVE','00000000-0000-4000-8000-000000000002',200);
      CREATE OR REPLACE FUNCTION public.can_access_site(p_site uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT p_site='00000000-0000-4000-8000-000000000001'::uuid $$;`)
    const plates = await db.query('SELECT public.unit_report_plates() AS plates')
    assert.deepEqual(plates.rows[0].plates.map(item => item.plate), ['SITE-A'], 'plate list respects site scope')
    assert.equal(plates.rows[0].plates[0].site_id, '00000000-0000-4000-8000-000000000001')
    console.log('PASS: report SQL patches compile in PostgreSQL/WASM, include closure and odometer evidence, and restrict plate list to accessible site.')
  } finally { await db.close() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
