// Contrato aislado de la ampliación de mantenimiento. No conecta a Supabase productivo.
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { PGlite } = require('@electric-sql/pglite')

const uid = '00000000-0000-4000-8000-000000000001'
const site = '00000000-0000-4000-8000-000000000002'
const vehicle = '00000000-0000-4000-8000-000000000003'
const order = '00000000-0000-4000-8000-000000000004'
const noBudgetOrder = '00000000-0000-4000-8000-000000000005'

;(async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE SCHEMA storage;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      CREATE TABLE public.profiles(id uuid PRIMARY KEY, is_active boolean DEFAULT true, first_name text, last_name text);
      CREATE TABLE public.sites(id uuid PRIMARY KEY);
      CREATE TABLE public.vehicles(id uuid PRIMARY KEY, plate text UNIQUE, type text, criticality text, status text, site_id uuid);
      CREATE TABLE public.drivers(id uuid PRIMARY KEY, first_name text, last_name text);
      CREATE TABLE public.maintenance_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), vehicle_plate text, severity text, status text, description text,
        reported_at timestamptz DEFAULT now(), odometer_at_report numeric, horometer numeric, photo_url text, driver_id uuid, dispatch_id uuid,
        assigned_to uuid, diagnosis text, scheduled_for date, work_order_id uuid, site_id uuid, source text);
      CREATE TABLE public.maintenance_request_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, request_id uuid, evento text, estado_nuevo text,
        at timestamptz DEFAULT now(), by uuid, detalle text);
      CREATE TABLE public.maintenance_work_orders(id uuid PRIMARY KEY, ot_code text, status text, order_type text, source_type text, priority text,
        description text, diagnostic text, activities_performed text, tasks jsonb, evidence_urls jsonb, notes text, vehicle_id uuid, plan_id uuid,
        provider_id uuid, responsible_id uuid, mechanic_id uuid, approved_by uuid, approved_at timestamptz, validated_at timestamptz,
        closed_at timestamptz, cancel_reason text, start_date date, estimated_end_date date, actual_end_date timestamptz,
        downtime_start timestamptz, downtime_end timestamptz, downtime_hours numeric, labor_cost numeric DEFAULT 0, parts_cost numeric DEFAULT 0,
        services_cost numeric DEFAULT 0, total_cost numeric DEFAULT 0, release_result jsonb, site_id uuid, created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(), type text);
      CREATE TABLE public.work_order_costs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), work_order_id uuid, cost_type text, amount numeric,
        quantity numeric, description text, document_number text, spare_part_id uuid, created_by uuid);
      CREATE TABLE storage.objects(bucket_id text, name text, owner_id text);
      CREATE FUNCTION public.has_cmms_permission(text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION public.has_cmms_read_permission(text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION public.has_tms_permission(text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION public.is_tms_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION public.can_access_site(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION public.is_active_tms_user() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION public.security_maintenance_object_site(text,text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION public.convert_request_to_wo(uuid,uuid DEFAULT NULL) RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
      INSERT INTO public.profiles(id) VALUES ('${uid}');
      INSERT INTO public.sites(id) VALUES ('${site}');
      INSERT INTO public.vehicles(id,plate,type,criticality,status,site_id) VALUES ('${vehicle}','ZZ-TEST','CAMION','MEDIA','DISPONIBLE','${site}');
      INSERT INTO public.maintenance_work_orders(id,ot_code,status,order_type,priority,description,vehicle_id,site_id,type)
        VALUES ('${order}','OT-TEST','BORRADOR','CORRECTIVA','NORMAL','Prueba integral','${vehicle}','${site}','CORRECTIVO'),
               ('${noBudgetOrder}','OT-SIN-PRESUPUESTO','BORRADOR','CORRECTIVA','NORMAL','Prueba guard','${vehicle}','${site}','CORRECTIVO');
      SELECT set_config('request.jwt.claim.sub','${uid}',false);
    `)
    await db.exec(readFileSync('supabase/migrations/20261225090000_mantenimiento_operacion_integral.sql', 'utf8'))

    const request = (await db.query(`SELECT public.request_work_order_budget($1,100,'Prueba de presupuesto inicial') AS value`, [order])).rows[0].value
    assert.equal(request.success, true)
    const decision = (await db.query(`SELECT public.decide_work_order_budget($1,'APROBADA','Validación aislada') AS value`, [request.id])).rows[0].value
    assert.equal(decision.success, true)
    await db.query(`UPDATE public.maintenance_work_orders SET status='APROBADA' WHERE id=$1`, [order])
    await db.query(`INSERT INTO public.work_order_costs(work_order_id,cost_type,amount) VALUES ($1,'MANO_OBRA',90)`, [order])
    await assert.rejects(db.query(`INSERT INTO public.work_order_costs(work_order_id,cost_type,amount) VALUES ($1,'OTROS',11)`, [order]), /supera el presupuesto aprobado/)
    const underfunded = (await db.query(`SELECT public.request_work_order_budget($1,80,'Monto inferior al costo ejecutado') AS value`, [order])).rows[0].value
    assert.equal(underfunded.success, false)

    await assert.rejects(db.query(`UPDATE public.maintenance_work_orders SET status='APROBADA' WHERE id=$1`, [noBudgetOrder]), /requiere un presupuesto aprobado/)
    const previo = (await db.query(`SELECT public.register_maintenance_work_order_report($1,'PREVIO',$2,'{"test":true}'::jsonb,'abc') AS value`,
      [order, `ot/${order}/reports/PREVIO/test.pdf`])).rows[0].value
    assert.equal(previo.success, true)
    assert.equal(previo.version, 1)
    const prematureClose = (await db.query(`SELECT public.register_maintenance_work_order_report($1,'CIERRE',$2,'{"test":true}'::jsonb,'def') AS value`,
      [order, `ot/${order}/reports/CIERRE/test.pdf`])).rows[0].value
    assert.equal(prematureClose.success, false)
    await db.query(`UPDATE public.maintenance_work_orders SET status='CERRADA' WHERE id=$1`, [order])
    const cierre = (await db.query(`SELECT public.register_maintenance_work_order_report($1,'CIERRE',$2,'{"test":true}'::jsonb,'def') AS value`,
      [order, `ot/${order}/reports/CIERRE/test.pdf`])).rows[0].value
    assert.equal(cierre.success, true)
    console.log('PASS CMMS integral: presupuesto/aprobación, bloqueo de exceso, aprobación obligatoria de OT e informes versionados con cierre controlado')
  } finally {
    await db.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
