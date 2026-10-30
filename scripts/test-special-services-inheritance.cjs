// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Etapa 1 de servicios especiales: herencia de la descarga pedida al armar la ruta, montacarga
// vinculado a su línea, origen por flujo y costo manual "sin tarifa" que el tarifario no pisa.
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
  const migration = read('supabase/migrations/20261105090000_herencia_servicios_especiales.sql')
  assert.doesNotMatch(migration, /replace\(\s*(def|source)/i, 'functions are rewritten in full, never patched with replace()')
  await db.exec(migration)
  await db.exec(migration) // reaplicable: columnas, restricciones y disparadores con IF NOT EXISTS / DROP IF EXISTS
  const scalar = async (sql, params=[]) => (await db.query(sql,params)).rows[0]?.value
  const origin = line => scalar('SELECT origin AS value FROM transport_unloading_costs WHERE id=$1',[line])
  assert.equal(await origin(id(50)),'SOLICITUD','backfill: request line without planning')
  assert.equal(await origin(id(51)),'CAJA','backfill: unplanned Caja line')
  assert.equal(await origin(id(52)),'PROGRAMACION','backfill: line created while planning the dispatch')
  assert.equal(await scalar('SELECT tariff_missing AS value FROM transport_unloading_costs WHERE id=$1',[id(53)]),true,'backfill: historical 0 estimate is "sin tarifa", not cost 0')
  assert.equal(await scalar('SELECT tariff_missing AS value FROM transport_unloading_costs WHERE id=$1',[id(50)]),false)

  // --- Solicitud: costo manual sin tarifa con motivo obligatorio; el tarifario no lo pisa con 0 ---
  const rpc = async (sql, params=[]) => (await db.query(`SELECT ${sql} AS value`,params)).rows[0].value
  const noReason = await rpc('save_request_unloading_costs($1,$2::jsonb)',[id(30),JSON.stringify([{concept:'MONTACARGAS',estimated_pen:120,estimated_source:'MANUAL',manual_reason:' '}])])
  assert.equal(noReason.success,false); assert.match(noReason.error,/motivo/)
  const save1 = await rpc('save_request_unloading_costs($1,$2::jsonb)',[id(30),JSON.stringify([
   {concept:'MONTACARGAS',estimated_pen:120,estimated_source:'MANUAL',manual_reason:'Cotización del proveedor por correo',description:'3 t'},
   {concept:'GRUA',estimated_pen:0}])])
  assert.equal(save1.success,true)
  const tariff1 = await rpc('apply_request_tariff($1)',[id(30)])
  assert.equal(tariff1.success,true); assert.equal(Number(tariff1.unloading_estimate_pen),200,'manual 120 + tariff 80')
  const lines1 = (await db.query(`SELECT concept,estimated_pen::float AS amount,estimated_source,tariff_missing,manual_reason,origin FROM transport_unloading_costs WHERE transport_request_id=$1 ORDER BY concept`,[id(30)])).rows
  assert.deepEqual(lines1.map(l => [l.concept,l.amount,l.estimated_source,l.tariff_missing,l.origin]),
   [['GRUA',80,'TARIFA',false,'SOLICITUD'],['MONTACARGAS',120,'MANUAL',true,'SOLICITUD']],'manual amount without tariff survives apply_request_tariff')
  assert.equal(lines1[1].manual_reason,'Cotización del proveedor por correo')
  await rpc('apply_request_tariff($1)',[id(30)])
  assert.equal(await scalar(`SELECT estimated_pen::float AS value FROM transport_unloading_costs WHERE transport_request_id=$1 AND concept='MONTACARGAS'`,[id(30)]),120,'second tariff pass keeps the manual amount')
  // Sin tarifa y sin monto manual: queda marcado "sin tarifa", no como S/ 0 tarifado.
  await rpc('save_request_unloading_costs($1,$2::jsonb)',[id(31),JSON.stringify([{concept:'ESTIBA',estimated_pen:0}])])
  await rpc('apply_request_tariff($1)',[id(31)])
  const estiba = (await db.query(`SELECT estimated_pen::float AS amount,estimated_source,tariff_missing FROM transport_unloading_costs WHERE transport_request_id=$1`,[id(31)])).rows[0]
  assert.deepEqual(estiba,{amount:0,estimated_source:null,tariff_missing:true})
  assert.equal(await scalar(`SELECT unloading_required AS value FROM transport_requests WHERE id=$1`,[id(32)]),null,'request without unloading answer stays "No requiere"')

  // --- Herencia al armar la ruta + montacarga vinculado a su línea ---
  const reserved = () => scalar(`SELECT reserved_pen::float AS value FROM contract_budgets WHERE contract_id=$1`,[id(20)])
  const before = await reserved()
  const linesBefore = await scalar('SELECT count(*)::int AS value FROM transport_unloading_costs')
  const route = await scalar('SELECT schedule_route_resources($1::jsonb) AS value',[JSON.stringify({ mode:'PROPIA',p_driver_id:null,p_vehicle_plate:'ETAPA-1',
   p_departure:'2099-01-01T12:00:00Z',p_estimated_km:10,p_freight_cost:900,p_contract_id:id(20),p_document_type:'GR',auxiliaries:[],
   p_requests:[{id:id(30)},{id:id(31)},{id:id(32)}],forklift:{supplier_id:id(10),operator_name:'Operador prueba',hourly_rate:75,transport_request_id:id(30)} })])
  assert.equal(await scalar('SELECT count(*)::int AS value FROM transport_unloading_costs'),linesBefore,'inheritance reuses the requested lines, never duplicates them')
  const planned = (await db.query(`SELECT id,transport_request_id AS req,concept,planned_pen::float AS planned,status,origin FROM transport_unloading_costs WHERE dispatch_id=$1 ORDER BY concept`,[route])).rows
  assert.deepEqual(planned.map(l => [l.concept,l.planned,l.status,l.origin]),
   [['ESTIBA',0,'PLANIFICADO','SOLICITUD'],['GRUA',80,'PLANIFICADO','SOLICITUD'],['MONTACARGAS',120,'PLANIFICADO','SOLICITUD']],'requested lines move to PLANIFICADO with their requested amount')
  const forkliftLine = planned.find(l => l.concept === 'MONTACARGAS')
  assert.equal(forkliftLine.req,id(30))
  assert.equal(await scalar('SELECT unloading_cost_id AS value FROM route_forklifts WHERE dispatch_id=$1',[route]),forkliftLine.id,'forklift linked to the MONTACARGAS line of its stop')
  assert.equal(await reserved(),before+200,'route reserves the inherited unloading once')

  // Doble guardado: herencia y planificación de Torre con la misma lista no duplican líneas, reservas ni vínculos.
  await db.query('SELECT inherit_route_unloading($1)',[route])
  const replan = await rpc('plan_dispatch_unloading($1,$2::jsonb)',[route,JSON.stringify(planned.map(l => ({id:l.id,planned_pen:l.planned})))])
  assert.equal(replan.success,true)
  await db.query('SELECT inherit_route_unloading($1)',[route])
  assert.equal(await scalar('SELECT count(*)::int AS value FROM transport_unloading_costs'),linesBefore,'double save: no duplicated lines')
  assert.equal(await scalar(`SELECT count(*)::int AS value FROM transport_unloading_costs WHERE dispatch_id=$1 AND status='PLANIFICADO'`,[route]),3)
  assert.equal(await reserved(),before+200,'double save: no duplicated reserve')
  assert.equal(await scalar('SELECT count(*)::int AS value FROM route_forklifts WHERE unloading_cost_id=$1',[forkliftLine.id]),1)
  // Torre retira la línea del montacarga: se desvincula; al volver a planificarla se vincula otra vez.
  await rpc('plan_dispatch_unloading($1,$2::jsonb)',[route,JSON.stringify(planned.filter(l => l.concept !== 'MONTACARGAS').map(l => ({id:l.id,planned_pen:l.planned})))])
  assert.equal(await scalar('SELECT unloading_cost_id AS value FROM route_forklifts WHERE dispatch_id=$1',[route]),null,'released line is unlinked')
  await rpc('plan_dispatch_unloading($1,$2::jsonb)',[route,JSON.stringify(planned.map(l => ({id:l.id,planned_pen:l.planned})))])
  assert.equal(await scalar('SELECT unloading_cost_id AS value FROM route_forklifts WHERE dispatch_id=$1',[route]),forkliftLine.id,'re-planned line is linked again')
  assert.equal(await reserved(),before+200)

  // --- Origen por flujo: Programación (línea nueva en Torre) y Caja (gasto no planificado) ---
  const added = await rpc('plan_dispatch_unloading($1,$2::jsonb)',[route,JSON.stringify([...planned.map(l => ({id:l.id,planned_pen:l.planned})),{request_id:id(32),concept:'OTROS',planned_pen:15}])])
  assert.equal(added.success,true)
  assert.equal(await scalar(`SELECT origin AS value FROM transport_unloading_costs WHERE dispatch_id=$1 AND concept='OTROS'`,[route]),'PROGRAMACION')
  const plain = await scalar('SELECT schedule_route_resources($1::jsonb) AS value',[JSON.stringify({ mode:'PROPIA',p_driver_id:null,p_vehicle_plate:'ETAPA-2',
   p_departure:'2099-01-01T12:00:00Z',p_estimated_km:10,p_freight_cost:0,p_contract_id:id(21),p_document_type:'GR',auxiliaries:[],p_requests:[{id:id(39)}],forklift:null })])
  assert.equal(await scalar(`SELECT count(*)::int AS value FROM transport_unloading_costs WHERE id IN ($1,$2) AND dispatch_id=$3 AND status='PLANIFICADO'`,[id(50),id(53),plain]),2,'historical requested lines are inherited too')
  await db.query(`INSERT INTO dispatch_expenses(id,dispatch_id,expense_type,amount) VALUES($1,$2,'CUADRILLA_ESTIBA',60)`,[id(70),plain])
  await db.query(`UPDATE dispatch_expenses SET status='APROBADO' WHERE id=$1`,[id(70)])
  assert.equal(await scalar(`SELECT origin AS value FROM transport_unloading_costs WHERE expense_id=$1`,[id(70)]),'CAJA')
  assert.equal(await scalar(`SELECT description AS value FROM transport_unloading_costs WHERE expense_id=$1`,[id(70)]),'No planificado · gasto de Caja')

  // Ruta sin descarga pedida: no planifica nada ni falla.
  await db.query(`INSERT INTO transport_requests(id,contract_id,request_number,site_id) VALUES($1,$2,'S-9',primary_site_id())`,[id(33),id(20)])
  const empty = await scalar('SELECT schedule_route_resources($1::jsonb) AS value',[JSON.stringify({ mode:'PROPIA',p_driver_id:null,p_vehicle_plate:'ETAPA-3',
   p_departure:'2099-01-01T12:00:00Z',p_estimated_km:10,p_freight_cost:0,p_contract_id:id(20),p_document_type:'GR',auxiliaries:[],p_requests:[{id:id(33)}],
   forklift:{supplier_id:id(10),operator_name:'Operador prueba',hourly_rate:75} })])
  assert.equal(await scalar('SELECT count(*)::int AS value FROM transport_unloading_costs WHERE dispatch_id=$1',[empty]),0)
  assert.equal(await scalar('SELECT unloading_cost_id AS value FROM route_forklifts WHERE dispatch_id=$1',[empty]),null,'forklift without requested line stays unlinked')

  // OT sin partida: la herencia no bloquea la programación; la línea queda ESTIMADO y se registra el aviso.
  await db.query(`INSERT INTO contracts(id,code) VALUES($1,'OT-SIN-PARTIDA')`,[id(22)])
  await db.query(`INSERT INTO transport_requests(id,contract_id,request_number,site_id) VALUES($1,$2,'S-10',primary_site_id())`,[id(34),id(22)])
  await rpc('save_request_unloading_costs($1,$2::jsonb)',[id(34),JSON.stringify([{concept:'GRUA',estimated_pen:80}])])
  const unfunded = await scalar('SELECT schedule_route_resources($1::jsonb) AS value',[JSON.stringify({ mode:'PROPIA',p_driver_id:null,p_vehicle_plate:'ETAPA-4',
   p_departure:'2099-01-01T12:00:00Z',p_estimated_km:10,p_freight_cost:0,p_contract_id:id(22),p_document_type:'GR',auxiliaries:[],p_requests:[{id:id(34)}],forklift:null })])
  assert.ok(unfunded,'route is scheduled even if the inherited unloading cannot be reserved')
  assert.equal(await scalar(`SELECT status AS value FROM transport_unloading_costs WHERE transport_request_id=$1`,[id(34)]),'ESTIMADO')
  assert.equal(await scalar(`SELECT count(*)::int AS value FROM dispatch_events WHERE dispatch_id=$1 AND event_type='DESCARGA_NO_HEREDADA'`,[unfunded]),1)

  assert.equal(await scalar("SELECT has_function_privilege('authenticated','inherit_route_unloading(uuid)','EXECUTE') AS value"),false)
  assert.equal(await scalar("SELECT has_function_privilege('anon','schedule_route_resources(jsonb)','EXECUTE') AS value"),false)
  await assert.rejects(db.exec(read('supabase/tests/caja_c170_special_services_inheritance.test.sql')),/CAJA C170 PASS/)
  await db.exec('ROLLBACK')
  console.log('PASS: inherited request unloading without duplicates on double save, forklift linked to its line, origin SOLICITUD/PROGRAMACION/CAJA, manual cost without tariff kept')
 } finally { await db.close() }
})().catch(error => { console.error(error); process.exitCode=1 })
