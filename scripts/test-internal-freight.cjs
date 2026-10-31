// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Flete según la operación: flota propia sin OT (recojos, traslados con OC/OS/RQ) es operación interna sin flete;
// con OT es costo logístico de la partida; con tercero todo servicio tiene costo y sin OT se autoriza contra la OC/OS/RQ.
const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const read = path => readFileSync(path, 'utf8')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function fn(file, name) {
 const s = read(file), a = s.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
 assert(a >= 0, name)
 return s.slice(a, s.indexOf('END $$;', a) + 7)
}
;(async () => {
 const db = new PGlite()
 try {
  await db.exec(read('scripts/fixtures/hhee-schema.sql'))
  await db.exec(read('scripts/fixtures/route-operations-schema.sql'))
  // Tipo producción: dispatches sin created_at/updated_at, índices únicos reales de unidad y conductor.
  await db.exec(`ALTER TABLE transport_requests ADD COLUMN request_number text, ADD COLUMN delivery_address text, ADD COLUMN delivery_district text,
    ADD COLUMN delivery_province text, ADD COLUMN delivery_department text, ADD COLUMN status text DEFAULT 'PENDIENTE', ADD COLUMN service_cost numeric DEFAULT 0,
    ADD COLUMN site_id uuid, ADD COLUMN cost_center_id uuid, ADD COLUMN unloading_estimate_pen numeric DEFAULT 0, ADD COLUMN unloading_required boolean,
    ADD COLUMN budget_shortfall numeric DEFAULT 0, ADD COLUMN budget_observation text, ADD COLUMN attention_mode text DEFAULT 'TRANSPORTE_JRM',
    ADD COLUMN request_type text DEFAULT 'DESPACHO', ADD COLUMN estimated_weight numeric, ADD COLUMN cost_breakdown jsonb, ADD COLUMN cost_source text,
    ADD COLUMN cost_override_reason text;
   ALTER TABLE dispatches ADD COLUMN cost_center_id uuid;
   ALTER TABLE dispatch_requests ADD FOREIGN KEY(dispatch_id) REFERENCES dispatches(id) ON DELETE CASCADE;
   CREATE UNIQUE INDEX dispatch_one_active_driver ON dispatches(driver_id) WHERE driver_id IS NOT NULL AND status='PROGRAMADO';
   CREATE UNIQUE INDEX dispatch_one_active_vehicle ON dispatches(vehicle_plate) WHERE status='PROGRAMADO';
   CREATE OR REPLACE FUNCTION schedule_dispatch(p_driver_id uuid,p_vehicle_plate text,p_departure timestamptz,p_estimated_km numeric,p_freight_cost numeric,p_contract_id uuid,p_document_type text,p_requests jsonb) RETURNS uuid LANGUAGE plpgsql AS $$DECLARE v uuid;BEGIN
    INSERT INTO dispatches(driver_id,vehicle_plate,scheduled_departure,site_id,contract_id,driver_name) VALUES(p_driver_id,p_vehicle_plate,p_departure,primary_site_id(),p_contract_id,'Conductor Prueba') RETURNING id INTO v;
    INSERT INTO dispatch_requests(dispatch_id,transport_request_id) SELECT v,(j->>'id')::uuid FROM jsonb_array_elements(p_requests) j;
    UPDATE transport_requests SET status='ASIGNADA' WHERE id IN (SELECT (j->>'id')::uuid FROM jsonb_array_elements(p_requests) j);
    RETURN v; END$$;
   CREATE FUNCTION notif_emit(text,text,text,text,text,uuid) RETURNS void LANGUAGE sql AS $$SELECT$$;
   CREATE FUNCTION is_contract_administrator() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
   CREATE FUNCTION has_assigned_request(p_request_id uuid,p_write boolean) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
   CREATE TABLE contract_budgets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contract_id uuid,concept text,allocated_pen numeric DEFAULT 0,reserved_pen numeric DEFAULT 0,
    consumed_pen numeric DEFAULT 0,balance_pen numeric GENERATED ALWAYS AS (allocated_pen-reserved_pen-consumed_pen) STORED,updated_at timestamptz);
   CREATE TABLE contract_services(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contract_id uuid,status text);
   CREATE TABLE transport_unloading_costs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    transport_request_id uuid NOT NULL REFERENCES transport_requests(id) ON DELETE CASCADE,dispatch_id uuid REFERENCES dispatches(id) ON DELETE SET NULL,
    contract_id uuid NOT NULL,concept text NOT NULL CHECK (concept IN ('MONTACARGAS','GRUA','ESTIBA','OTROS')),description text,
    estimated_pen numeric(15,2) NOT NULL DEFAULT 0 CHECK (estimated_pen>=0),planned_pen numeric(15,2),actual_pen numeric(15,2),
    status text NOT NULL DEFAULT 'ESTIMADO' CHECK (status IN ('ESTIMADO','PLANIFICADO','CONSUMIDO','ANULADO')),contract_service_id uuid,expense_id uuid,
    provider_name text,created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),
    planned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,planned_at timestamptz,consumed_by uuid,consumed_at timestamptz,void_reason text,cost_center_id uuid);
   CREATE TABLE dispatch_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),dispatch_id uuid,expense_type text,amount numeric,status text DEFAULT 'PENDIENTE',provider_name text);
   CREATE FUNCTION quote_transport(c uuid,s jsonb,w numeric,vc text,p text,u jsonb) RETURNS jsonb LANGUAGE sql AS $$
    SELECT jsonb_build_object('freight_total',300,'unloading_total',80*(SELECT count(*) FROM jsonb_array_elements(u) e WHERE e->>'concept'='GRUA'),
     'lines',jsonb_build_array(jsonb_build_object('concept','FLETE','unit_rate',300))||COALESCE((SELECT jsonb_agg(jsonb_build_object('concept','GRUA','unit_rate',80))
       FROM jsonb_array_elements(u) e WHERE e->>'concept'='GRUA'),'[]'::jsonb),
     'missing',COALESCE((SELECT jsonb_agg('Sin tarifa de '||lower(e->>'concept')) FROM jsonb_array_elements(u) e WHERE e->>'concept'<>'GRUA'),'[]'::jsonb)) $$;
   -- Consumo interno simplificado: el gasto de Caja consume la línea una sola vez.
   CREATE FUNCTION unloading_consume(p_line uuid,p_amount numeric,p_expense uuid,p_provider text) RETURNS uuid LANGUAGE sql AS $$
    UPDATE transport_unloading_costs SET status='CONSUMIDO',actual_pen=p_amount,expense_id=p_expense WHERE id=p_line RETURNING id $$;
   SELECT set_config('request.jwt.claim.sub','${id(1)}',false);`)
  await db.exec(fn('supabase/migrations/20260929210000_despacho_f4_tripulacion_descarga.sql','caja_unloading_expense_sync'))
  await db.exec('CREATE TRIGGER caja_unloading_expense_sync AFTER UPDATE OF status ON dispatch_expenses FOR EACH ROW EXECUTE FUNCTION caja_unloading_expense_sync();')
  // Ruta de una sola OT: plan_dispatch_unloading vigente para rutas sin flete distribuido.
  await db.exec(fn('supabase/migrations/20261007150000_request_optional_pickup_details.sql','plan_dispatch_unloading'))
  for (const path of ['20261021160000_route_operations.sql','20261022100000_supplier_services_forklift.sql','20261022110000_supplier_fleet_master.sql','20261022120000_supplier_fleet_fk_indexes.sql','20261022130000_logistics_supplier_permissions.sql','20261022140000_forklift_service_times_and_logistics_reads.sql','20261103120000_route_forklift_stop.sql']) await db.exec(read('supabase/migrations/'+path))
  await db.exec(`INSERT INTO suppliers(id,business_name,tax_id,category) VALUES('${id(10)}','Montacarga prueba','20123456789','MONTACARGA');
   INSERT INTO contracts(id,code) VALUES('${id(20)}','OT-A'),('${id(21)}','OT-H');
   INSERT INTO contract_budgets(contract_id,concept,allocated_pen) VALUES('${id(20)}','PARTIDA_TRANSPORTE',5000),('${id(21)}','PARTIDA_TRANSPORTE',5000);
   INSERT INTO transport_requests(id,contract_id,request_number,delivery_address,delivery_district,site_id) VALUES
    ('${id(30)}','${id(20)}','S-1','Entrega A','Callao',primary_site_id()),('${id(31)}','${id(20)}','S-2','Entrega B','Callao',primary_site_id()),
    ('${id(32)}','${id(20)}','S-3','Entrega C','Callao',primary_site_id()),('${id(39)}','${id(21)}','H-1','Histórica','Callao',primary_site_id());`)
  // Historial previo a la migración: una línea de cada flujo, sin columna origin.
  await db.exec(`INSERT INTO dispatches(id,vehicle_plate,status,contract_id,site_id) VALUES('${id(60)}','HIST-1','EN RUTA','${id(21)}',primary_site_id());
   INSERT INTO transport_unloading_costs(id,transport_request_id,contract_id,concept,estimated_pen,created_by,created_at) VALUES('${id(50)}','${id(39)}','${id(21)}','GRUA',90,'${id(1)}','2026-01-01T10:00:00Z');
   INSERT INTO transport_unloading_costs(id,transport_request_id,dispatch_id,contract_id,concept,description,status,created_by,created_at) VALUES('${id(51)}','${id(39)}','${id(60)}','${id(21)}','ESTIBA','No planificado · gasto de Caja','CONSUMIDO','${id(1)}','2026-01-03T10:00:00Z');
   INSERT INTO transport_unloading_costs(id,transport_request_id,dispatch_id,contract_id,concept,planned_pen,status,created_by,planned_by,created_at,planned_at) VALUES('${id(52)}','${id(39)}','${id(60)}','${id(21)}','MONTACARGAS',40,'PLANIFICADO','${id(1)}','${id(1)}','2026-01-02T10:00:00Z','2026-01-02T10:00:00Z');
   INSERT INTO transport_unloading_costs(id,transport_request_id,contract_id,concept,estimated_pen,created_by,created_at) VALUES('${id(53)}','${id(39)}','${id(21)}','OTROS',0,'${id(1)}','2026-01-01T10:00:00Z');`)
  // Tipo producción: flete vigente, reparto por OT, servicios de la OT y consumo real de la descarga.
  await db.exec(`ALTER TABLE dispatches ADD COLUMN freight_cost numeric DEFAULT 0;
   ALTER TABLE contract_services ADD COLUMN service_type text, ADD COLUMN dispatch_id uuid, ADD COLUMN amount_pen numeric DEFAULT 0, ADD COLUMN description text,
    ADD COLUMN service_date date, ADD COLUMN plate text, ADD COLUMN driver_name text, ADD COLUMN provider_name text, ADD COLUMN category text, ADD COLUMN created_by uuid;
   CREATE TABLE dispatch_request_freight(dispatch_id uuid NOT NULL REFERENCES dispatches(id),request_id uuid NOT NULL REFERENCES transport_requests(id),
    contract_id uuid REFERENCES contracts(id),amount_pen numeric(15,2) NOT NULL CHECK(amount_pen>=0),service_id uuid REFERENCES contract_services(id),
    status text NOT NULL DEFAULT 'RESERVADO' CHECK(status IN ('RESERVADO','CONSUMIDO','LIBERADO')),PRIMARY KEY(dispatch_id,request_id));
   CREATE FUNCTION update_contract_service_amount(p_service_id uuid,p_new_amount numeric) RETURNS boolean LANGUAGE sql AS $$
    UPDATE contract_services SET amount_pen=p_new_amount WHERE id=p_service_id RETURNING true $$;
   CREATE FUNCTION unloading_service_type(p_concept text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE p_concept WHEN 'MONTACARGAS' THEN 'MONTACARGA' WHEN 'GRUA' THEN 'GRUA' WHEN 'ESTIBA' THEN 'ESTIBA' ELSE 'OTROS' END $$;
   CREATE FUNCTION unloading_concept_label(p_concept text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE p_concept WHEN 'MONTACARGAS' THEN 'Montacargas' WHEN 'GRUA' THEN 'Grúa' WHEN 'ESTIBA' THEN 'Estiba' ELSE 'Otros' END $$;
   DROP TRIGGER caja_unloading_expense_sync ON dispatch_expenses; DROP FUNCTION unloading_consume(uuid,numeric,uuid,text);`)
  await db.exec(fn('supabase/migrations/20261007150000_request_optional_pickup_details.sql','unloading_consume'))
  for (const m of ['20261105090000_herencia_servicios_especiales.sql','20261105100000_route_forklift_unloading_cost_index.sql',
   '20261107090000_costo_acordado_servicios.sql','20261108100000_flete_etapas.sql','20261109090000_cierre_economico.sql']) await db.exec(read('supabase/migrations/'+m))
  // schedule_dispatch de prueba: deja el flete y el reparto que recibe (como lo vería validate_mixed_dispatch de producción).
  await db.exec(`CREATE TABLE schedule_log(vehicle_plate text, freight numeric, requests jsonb);
   CREATE OR REPLACE FUNCTION schedule_dispatch(p_driver_id uuid,p_vehicle_plate text,p_departure timestamptz,p_estimated_km numeric,p_freight_cost numeric,p_contract_id uuid,p_document_type text,p_requests jsonb) RETURNS uuid LANGUAGE plpgsql AS $$DECLARE v uuid;BEGIN
    INSERT INTO schedule_log VALUES(p_vehicle_plate,p_freight_cost,p_requests);
    INSERT INTO dispatches(driver_id,vehicle_plate,scheduled_departure,site_id,contract_id,driver_name,freight_cost) VALUES(p_driver_id,p_vehicle_plate,p_departure,primary_site_id(),p_contract_id,'Conductor Prueba',COALESCE(p_freight_cost,0)) RETURNING id INTO v;
    INSERT INTO dispatch_requests(dispatch_id,transport_request_id) SELECT v,(j->>'id')::uuid FROM jsonb_array_elements(p_requests) j;
    UPDATE transport_requests SET status='ASIGNADA' WHERE id IN (SELECT (j->>'id')::uuid FROM jsonb_array_elements(p_requests) j);
    RETURN v; END$$;
   ALTER TABLE transport_requests ADD COLUMN IF NOT EXISTS reference_type text, ADD COLUMN IF NOT EXISTS reference_number text,
    ADD COLUMN IF NOT EXISTS operational_approved_pen numeric DEFAULT 0, ADD COLUMN IF NOT EXISTS approved_at timestamptz;
   CREATE TABLE IF NOT EXISTS transport_request_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),request_id uuid,actor_id uuid,action text,previous_state jsonb,next_state jsonb,created_at timestamptz DEFAULT now());
   CREATE FUNCTION is_reference_transport(t transport_requests) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(t.contract_id IS NULL AND t.request_type IN ('RECOJO','TRASLADO') AND t.reference_type IN ('OC','OS','RQ') AND length(trim(COALESCE(t.reference_number,''))) BETWEEN 1 AND 100,false) $$;
   -- Aprobación simplificada: el importe autorizado pasa a ser flete + descarga.
   CREATE FUNCTION approve_reference_transport_request(p_request_id uuid,p_expected_cost numeric,p_reference_type text,p_reference_number text) RETURNS void LANGUAGE sql AS $$
    UPDATE transport_requests SET operational_approved_pen=p_expected_cost,approved_at=now(),status='APROBADA' WHERE id=p_request_id $$;`)
  for (const m of ['20261111100000_sustento_unidades_cobro.sql']) await db.exec(read('supabase/migrations/'+m))
  const migration = read('supabase/migrations/20261121100000_flete_operacion_interna.sql')
  assert.doesNotMatch(migration, /replace\(\s*(def|source)/i, 'functions are rewritten in full, never patched with replace()')
  await db.exec(migration)
  await db.exec(migration) // reaplicable
  const scalar = async (sql, params=[]) => (await db.query(sql,params)).rows[0]?.value
  const rpc = async (sql, params=[]) => (await db.query(`SELECT ${sql} AS value`,params)).rows[0].value

  // Solicitudes: OT con flete referencial 500, traslado con OS (como RT-002582), recojo con OC y traslado con OT.
  await db.exec(`UPDATE transport_requests SET service_cost=500,status='APROBADA',approved_at=now() WHERE id='${id(30)}';
   INSERT INTO transport_requests(id,contract_id,request_number,delivery_address,delivery_district,site_id,service_cost,request_type,reference_type,reference_number,status,approved_at,operational_approved_pen) VALUES
    ('${id(33)}',NULL,'RT-T1','Pachacamac','Pachacamac',primary_site_id(),0,'TRASLADO','OS','OS-100','APROBADA',now(),0),
    ('${id(34)}',NULL,'RT-R1','Recojo OC','Lurin',primary_site_id(),0,'RECOJO','OC','OC-200','APROBADA',now(),0),
    ('${id(35)}',NULL,'RT-T2','Traslado tercero','Ate',primary_site_id(),0,'TRASLADO','RQ','RQ-300','APROBADA',now(),0);`)
  const schedule = (plate, extra) => db.query('SELECT schedule_route_resources($1::jsonb) AS value',[JSON.stringify({ mode:'PROPIA',p_driver_id:null,p_vehicle_plate:plate,
   p_departure:'2026-11-21T12:00:00Z',p_estimated_km:10,p_contract_id:null,p_document_type:'GR',auxiliaries:[],forklift:null,...extra })]).then(r => r.rows[0].value)
  const logged = plate => db.query(`SELECT freight::float AS freight,(SELECT jsonb_agg((j->>'freight_share_pen')::float) FROM jsonb_array_elements(requests) j) AS shares FROM schedule_log WHERE vehicle_plate=$1`,[plate]).then(r => r.rows[0])

  // 1) Flota propia, traslado sin OT (caso RT-002582): el flete del tarifario no se cobra, sin motivo ni aprobación.
  const own = await schedule('P-1',{p_freight_cost:990,p_requests:[{id:id(33),freight_share_pen:990}]})
  assert.deepEqual(await logged('P-1'),{freight:0,shares:[0]},'internal operation: freight forced to 0')
  assert.equal(await scalar(`SELECT agreed_pen::float AS value FROM dispatch_freight_stages WHERE dispatch_id=$1`,[own]),0)
  await db.query(`UPDATE dispatches SET status='ENTREGADO' WHERE id=$1`,[own])
  // Recojo con OC y flota propia: igual.
  const pick = await schedule('P-2',{p_freight_cost:300,p_requests:[{id:id(34),freight_share_pen:300}]})
  assert.deepEqual(await logged('P-2'),{freight:0,shares:[0]})
  await db.query(`UPDATE dispatches SET status='ENTREGADO' WHERE id=$1`,[pick])

  // 2) Ruta mixta con flota propia: el flete va solo a la OT; un monto en el servicio interno se rechaza.
  await db.exec(`UPDATE transport_requests SET status='APROBADA' WHERE id IN ('${id(33)}','${id(34)}')`)
  await assert.rejects(schedule('P-3',{p_freight_cost:600,p_requests:[{id:id(30),freight_share_pen:400},{id:id(33),freight_share_pen:200}]}),
   /servicios sin OT son operación interna/)
  await assert.rejects(schedule('P-3',{p_freight_cost:600,p_requests:[{id:id(30),freight_share_pen:600},{id:id(33),freight_share_pen:0}]}),
   /Justifique la diferencia del flete con el referencial de las solicitudes \(S\/ 500\.00 → S\/ 600\.00\)/,'referential counts only the OT service (500)')
  const mixed = await schedule('P-3',{p_freight_cost:500,p_requests:[{id:id(30),freight_share_pen:500},{id:id(33),freight_share_pen:0}]})
  assert.deepEqual(await logged('P-3'),{freight:500,shares:[500,0]},'OT carries the logistic cost; equal to its referential: no reason')
  await db.query(`UPDATE dispatches SET status='ENTREGADO' WHERE id=$1`,[mixed])

  // 3) Tercero: el servicio sin OT sí tiene costo; el supervisor autoriza el flete del traslado contra la RQ.
  const authorize = (r, freight, reason='Cotización del transportista') => rpc('authorize_pickup_reference_freight($1,$2,$3,$4,$5,$6)',[r,0,'RQ','RQ-300',freight,reason])
  const auth = await authorize(id(35),350)
  assert.equal(auth.success,true); assert.equal(Number(auth.operational_approved_pen),350,'transfers can now be authorized')
  assert.deepEqual((await db.query(`SELECT service_cost::float AS cost,operational_approved_pen::float AS approved FROM transport_requests WHERE id=$1`,[id(35)])).rows[0],{cost:350,approved:350})
  await assert.rejects(authorize(id(35),400),/costo o el sustento cambió/,'the expected cost must match the current one')
  await assert.rejects(db.query(`SELECT authorize_pickup_reference_freight($1,350,'RQ','RQ-300',360,'corto')`,[id(35)]),/motivo de la cotización/)
  await assert.rejects(db.query(`SELECT authorize_pickup_reference_freight($1,0,'OS','OS-100',100,'Cotización del transportista')`,[id(33)]),/no está disponible/,'an already scheduled service is not re-quoted')
  // Sin permiso de aprobación no se autoriza.
  await db.exec(`INSERT INTO roles(id,name,permissions) VALUES('${id(92)}','Programador','["despacho"]');
   INSERT INTO profiles(id,role_id,first_name) VALUES('${id(93)}','${id(92)}','Programador');
   SELECT set_config('request.jwt.claim.sub','${id(93)}',false);`)
  await assert.rejects(db.query(`SELECT authorize_pickup_reference_freight($1,0,'OS','OS-100',100,'Cotización del transportista')`,[id(33)]),/Supervisor de Transporte/)
  await db.exec(`SELECT set_config('request.jwt.claim.sub','${id(1)}',false)`)

  // Verificación de producción C193 sobre este esquema
  await assert.rejects(db.exec(read('supabase/tests/caja_c193_flete_operacion_interna.test.sql')),/CAJA C193 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  console.log('PASS flete por operación: flota propia sin OT sin flete, OT con costo logístico, tercero sin OT autorizado (recojos y traslados)')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
