// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Etapa D: sustento del acordado al programar (motivo cuando el servicio especial o el flete difieren del referencial)
// y unidades de cobro UNIDAD y TONELADA.
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
  // El flete programado llega a dispatches.freight_cost al crear el despacho (como schedule_dispatch de producción).
  await db.exec(`CREATE OR REPLACE FUNCTION schedule_dispatch(p_driver_id uuid,p_vehicle_plate text,p_departure timestamptz,p_estimated_km numeric,p_freight_cost numeric,p_contract_id uuid,p_document_type text,p_requests jsonb) RETURNS uuid LANGUAGE plpgsql AS $$DECLARE v uuid;BEGIN
    INSERT INTO dispatches(driver_id,vehicle_plate,scheduled_departure,site_id,contract_id,driver_name,freight_cost) VALUES(p_driver_id,p_vehicle_plate,p_departure,primary_site_id(),p_contract_id,'Conductor Prueba',COALESCE(p_freight_cost,0)) RETURNING id INTO v;
    INSERT INTO dispatch_requests(dispatch_id,transport_request_id) SELECT v,(j->>'id')::uuid FROM jsonb_array_elements(p_requests) j;
    UPDATE transport_requests SET status='ASIGNADA' WHERE id IN (SELECT (j->>'id')::uuid FROM jsonb_array_elements(p_requests) j);
    RETURN v; END$$;`)
  const migration = read('supabase/migrations/20261111100000_sustento_unidades_cobro.sql')
  assert.doesNotMatch(migration, /replace\(\s*(def|source)/i, 'functions are rewritten in full, never patched with replace()')
  await db.exec(migration)
  await db.exec(migration) // reaplicable
  const scalar = async (sql, params=[]) => (await db.query(sql,params)).rows[0]?.value
  const rpc = async (sql, params=[]) => (await db.query(`SELECT ${sql} AS value`,params)).rows[0].value

  // --- Unidades UNIDAD y TONELADA: max(cantidad, mínimo), sin fracción ---
  const billable = (u,q,f,m) => scalar('SELECT economic_billable_qty($1,$2,$3,$4)::float AS value',[u,q,f,m])
  assert.equal(await billable('TONELADA',4,null,5),5,'below the minimum: the minimum is billed')
  assert.equal(await billable('TONELADA',12.75,30,5),12.75,'tonnes are not rounded to a fraction')
  assert.equal(await billable('UNIDAD',7,null,null),7)
  assert.equal(await billable('UNIDAD',0,null,5),0,'not executed: no minimum')
  assert.equal(await billable('HORA',2.25,30,3),3,'hourly rules unchanged')

  await db.exec(`INSERT INTO suppliers(id,business_name,tax_id,category) VALUES('${id(11)}','Grúas prueba','20111111111','GRUA'),('${id(12)}','Estiba prueba','20222222222','ESTIBA');
   UPDATE transport_requests SET service_cost=500 WHERE id IN ('${id(30)}','${id(31)}','${id(32)}');
   INSERT INTO transport_requests(id,contract_id,request_number,delivery_address,delivery_district,site_id,service_cost,request_type) VALUES
    ('${id(33)}','${id(20)}','S-4','Recojo propio','Callao',primary_site_id(),150,'RECOJO');
   INSERT INTO transport_requests(id,contract_id,request_number,delivery_address,delivery_district,site_id,service_cost,attention_mode) VALUES
    ('${id(34)}','${id(20)}','S-5','Retiro cliente','Callao',primary_site_id(),90,'RECOJO_CLIENTE');
   -- Referenciales de la solicitud: grúa con tarifa (80), estiba con costo manual (120), otros sin tarifa (0).
   INSERT INTO transport_unloading_costs(id,transport_request_id,contract_id,concept,estimated_pen,origin,estimated_source,tariff_missing,manual_reason) VALUES
    ('${id(40)}','${id(30)}','${id(20)}','GRUA',80,'SOLICITUD','TARIFA',false,NULL),
    ('${id(41)}','${id(30)}','${id(20)}','ESTIBA',120,'SOLICITUD','MANUAL',true,'Cotización del cliente'),
    ('${id(42)}','${id(30)}','${id(20)}','OTROS',0,'SOLICITUD',NULL,true,NULL),
    ('${id(43)}','${id(31)}','${id(20)}','GRUA',80,'SOLICITUD','TARIFA',false,NULL);`)
  const schedule = (plate, extra) => db.query('SELECT schedule_route_resources($1::jsonb) AS value',[JSON.stringify({ mode:'PROPIA',p_driver_id:null,p_vehicle_plate:plate,
   p_departure:'2026-11-12T12:00:00Z',p_estimated_km:10,p_freight_cost:500,p_contract_id:id(20),p_document_type:'GR',auxiliaries:[],p_requests:[{id:id(30)}],forklift:null,...extra })]).then(r => r.rows[0].value)
  const grua = (p={}) => ({id:id(40),supplier_id:id(11),billing_unit:'TONELADA',agreed_rate:20,agreed_qty:4,min_billable_qty:5,...p})
  const estiba = (p={}) => ({id:id(41),supplier_id:id(12),billing_unit:'UNIDAD',agreed_rate:10,agreed_qty:12,workers:4,...p})
  const otros = {id:id(42),supplier_id:id(11),billing_unit:'SERVICIO',agreed_rate:70,agreed_qty:1}

  // --- Motivo cuando el acordado del servicio difiere del referencial ---
  await assert.rejects(schedule('D-1',{special_services:{items:[grua()]}}),/Justifique la diferencia del costo acordado de grua con el referencial \(S\/ 80\.00 → S\/ 100\.00\)/,
   'tonnes: 20 × max(4, 5) = 100 differs from the referential 80')
  await assert.rejects(schedule('D-1',{special_services:{items:[grua({reason:'Pesa más'}),estiba({agreed_qty:15})]}}),/costo acordado de estiba con el referencial \(S\/ 120\.00 → S\/ 150\.00\)/,
   'a manual referential also needs a reason when the agreed cost differs')
  assert.equal(await scalar(`SELECT count(*)::int AS value FROM dispatches WHERE vehicle_plate='D-1'`),0,'nothing is scheduled without the reason')
  await assert.rejects(schedule('D-1',{special_services:{items:[grua({billing_unit:'JORNADA',reason:'Por jornada'})]}}),/Modalidad de cobro inválida para grua/)
  // Sin tarifa (0) no exige motivo; la estiba por unidad no se multiplica por trabajadores (12 × 10 = 120 = referencial).
  const route = await schedule('D-1',{special_services:{items:[grua({reason:'Se descargan 5 t mínimo'}),estiba(),otros]}})
  const line = l => db.query(`SELECT billing_unit,planned_pen::float AS planned,workers,agreed_reason FROM transport_unloading_costs WHERE id=$1`,[l]).then(r => r.rows[0])
  assert.deepEqual(await line(id(40)),{billing_unit:'TONELADA',planned:100,workers:null,agreed_reason:'Se descargan 5 t mínimo'})
  assert.deepEqual(await line(id(41)),{billing_unit:'UNIDAD',planned:120,workers:null,agreed_reason:null},'12 units × 10 = referential 120: workers ignored, no reason')
  assert.deepEqual(await line(id(42)),{billing_unit:'SERVICIO',planned:70,workers:null,agreed_reason:null},'no-tariff line: no reason needed')
  const lineEvents = await db.query(`SELECT reason FROM service_cost_events WHERE dispatch_id=$1 AND stage='ACORDADO' AND service_kind='DESCARGA' AND detail->>'supplier_id' IS NOT NULL ORDER BY unloading_cost_id`,[route])
  assert.deepEqual(lineEvents.rows.map(e => e.reason),['Se descargan 5 t mínimo',null,null],'the reason is kept in the history')
  // Flete igual al referencial (500): sin motivo.
  assert.equal(await scalar(`SELECT agreed_reason AS value FROM dispatch_freight_stages WHERE dispatch_id=$1`,[route]),null)

  // Acordado igual al referencial: sin motivo (16 × 5 = 80).
  const same = await schedule('D-2',{p_requests:[{id:id(31)}],special_services:{items:[{id:id(43),supplier_id:id(11),billing_unit:'TONELADA',agreed_rate:16,agreed_qty:5}]}})
  assert.equal((await line(id(43))).planned,80)
  // Montacarga no se cobra por tonelada.
  const mc = await rpc(`set_special_service_agreements($1,$2::jsonb)`,[same,JSON.stringify({items:[{transport_request_id:id(31),concept:'MONTACARGAS',supplier_id:id(11),billing_unit:'TONELADA',agreed_rate:10,agreed_qty:1,reason:'Montacarga extra'}]})])
  assert.equal(mc.success,false)

  // --- Motivo cuando el flete de la ruta difiere del referencial ---
  await db.exec(`UPDATE dispatches SET status='ENTREGADO' WHERE vehicle_plate IN ('D-1','D-2')`)
  const freightRoute = extra => schedule('D-3',{p_requests:[{id:id(32)}],...extra})
  await assert.rejects(freightRoute({p_freight_cost:650}),/Justifique la diferencia del flete con el referencial de las solicitudes \(S\/ 500\.00 → S\/ 650\.00\)/)
  await assert.rejects(freightRoute({p_freight_cost:650,freight_reason:'abc'}),/Justifique la diferencia del flete/,'at least 5 characters')
  const fr = await freightRoute({p_freight_cost:650,freight_reason:'Peaje nuevo en la ruta'})
  assert.equal(await scalar(`SELECT agreed_reason AS value FROM dispatch_freight_stages WHERE dispatch_id=$1`,[fr]),'Peaje nuevo en la ruta')
  assert.deepEqual((await db.query(`SELECT stage,new_amount::float AS amount,reason FROM service_cost_events WHERE service_kind='FLETE' AND dispatch_id=$1`,[fr])).rows,
   [{stage:'ACORDADO',amount:650,reason:'Peaje nuevo en la ruta'}],'the ACORDADO freight event carries the reason')
  // Renegociar mientras está programada sin motivo: el acordado nuevo no hereda el motivo anterior.
  await db.query(`UPDATE dispatches SET freight_cost=640 WHERE id=$1`,[fr])
  assert.deepEqual((await db.query(`SELECT agreed_pen::float AS agreed,agreed_reason FROM dispatch_freight_stages WHERE dispatch_id=$1`,[fr])).rows[0],{agreed:640,agreed_reason:null})
  await db.query(`UPDATE dispatches SET status='ENTREGADO' WHERE id=$1`,[fr])

  // Excepciones: recojo con flota propia y Nota de Salida con flete 0 (referencial 150 y 90).
  const pickup = await schedule('D-4',{p_requests:[{id:id(33)}],p_freight_cost:0})
  assert.ok(pickup,'own-fleet pickup without freight: no reason')
  await db.query(`UPDATE dispatches SET status='ENTREGADO' WHERE id=$1`,[pickup])
  assert.ok(await schedule('EXTERNO',{p_requests:[{id:id(34)}],p_freight_cost:0,p_document_type:'NOTA_SALIDA'}),'customer pickup (NOTA_SALIDA) without freight: no reason')
  // Recojo con flete distinto de 0 y del referencial: exige motivo.
  await assert.rejects(schedule('D-5',{p_requests:[{id:id(33)}],p_freight_cost:120}),/Justifique la diferencia del flete/,'pickup with freight other than referential')

  // --- Costo final por tonelada y por unidad (validate_service_final) ---
  const validate = (l, p) => rpc('validate_service_final($1,$2::jsonb)',[l,JSON.stringify(p)])
  let r = await validate(id(40),{executed_qty:4.5})
  assert.equal(r.success,true,r.error); assert.equal(Number(r.billable_qty),5); assert.equal(Number(r.final_pen),100,'4.5 t → minimum 5 t × 20, equal to agreed')
  r = await validate(id(40),{executed_qty:6.25,reason:'Se descargaron 6.25 t'})
  assert.equal(Number(r.final_pen),125,'6.25 t × 20, no fraction rounding')
  r = await validate(id(41),{executed_qty:12,workers:6})
  assert.equal(r.success,true,r.error); assert.equal(Number(r.final_pen),120,'per unit: workers do not multiply the rate')
  assert.match((await validate(id(41),{})).error,/unidades o toneladas/)

  // Verificación de producción C175 sobre este esquema
  await assert.rejects(db.exec(read('supabase/tests/caja_c175_sustento_unidades_cobro.test.sql')),/CAJA C175 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  console.log('PASS sustento al programar: motivo del acordado y del flete distintos al referencial, unidades UNIDAD y TONELADA (Etapa D)')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
