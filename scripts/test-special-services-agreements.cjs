// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Etapa 2 de servicios especiales: costo acordado por servicio (proveedor, modalidad, tarifa y cantidad) al programar,
// servicios agregados o retirados con motivo, proveedores de grúa y estiba e historial de costos solo de inserción.
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
  await db.exec(read('supabase/migrations/20261105090000_herencia_servicios_especiales.sql'))
  await db.exec(read('supabase/migrations/20261105100000_route_forklift_unloading_cost_index.sql'))
  const migration = read('supabase/migrations/20261107090000_costo_acordado_servicios.sql')
  assert.doesNotMatch(migration, /replace\(\s*(def|source)/i, 'functions are rewritten in full, never patched with replace()')
  await db.exec(migration)
  await db.exec(migration) // reaplicable
  const scalar = async (sql, params=[]) => (await db.query(sql,params)).rows[0]?.value
  const rpc = async (sql, params=[]) => (await db.query(`SELECT ${sql} AS value`,params)).rows[0].value

  // Regla C55: la FK nueva al proveedor está validada y cubierta por un índice no parcial.
  assert.equal(await scalar(`SELECT count(*)::int AS value FROM pg_constraint c WHERE c.conname='transport_unloading_costs_supplier_fk'
   AND c.convalidated AND EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.conrelid AND i.indisvalid AND i.indpred IS NULL
    AND (i.indkey::smallint[])[0:cardinality(c.conkey)-1] @> c.conkey)`),1,'supplier FK covered by a non-partial index')
  // Proveedores de grúa y estiba
  await db.exec(`INSERT INTO suppliers(id,business_name,tax_id,category) VALUES('${id(11)}','Grúas prueba','20111111111','GRUA'),
   ('${id(12)}','Estiba prueba','20222222222','ESTIBA'),('${id(13)}','Grúa inactiva','20333333333','GRUA');
   UPDATE suppliers SET is_active=false WHERE id='${id(13)}';`)
  await assert.rejects(db.exec(`INSERT INTO suppliers(business_name,tax_id,category) VALUES('X','20444444444','INVENTADA')`), /suppliers_category_check/)

  // --- Solicitud: el referencial queda en el historial ---
  await rpc('save_request_unloading_costs($1,$2::jsonb)',[id(30),JSON.stringify([
   {concept:'MONTACARGAS',estimated_pen:120,estimated_source:'MANUAL',manual_reason:'Cotización del proveedor por correo'},{concept:'GRUA',estimated_pen:0}])])
  await rpc('apply_request_tariff($1)',[id(30)])
  await rpc('save_request_unloading_costs($1,$2::jsonb)',[id(31),JSON.stringify([{concept:'ESTIBA',estimated_pen:50}])])
  const lineOf = (req, concept) => scalar(`SELECT id AS value FROM transport_unloading_costs WHERE transport_request_id=$1 AND concept=$2`,[req,concept])
  const grua = await lineOf(id(30),'GRUA'), mont = await lineOf(id(30),'MONTACARGAS'), estibaPedida = await lineOf(id(31),'ESTIBA')
  assert.equal(await scalar(`SELECT count(*)::int AS value FROM service_cost_events WHERE unloading_cost_id=$1 AND stage='REFERENCIAL' AND new_amount=80`,[grua]),1,'tariff amount of the request is logged as referential')
  assert.equal(await scalar(`SELECT reason AS value FROM service_cost_events WHERE unloading_cost_id=$1 AND stage='REFERENCIAL' ORDER BY created_at LIMIT 1`,[mont]),'Cotización del proveedor por correo')

  // --- Programación: acuerdos inválidos no programan la ruta (todo o nada) ---
  const base = { mode:'PROPIA',p_driver_id:null,p_departure:'2099-01-01T12:00:00Z',p_estimated_km:10,p_freight_cost:0,p_contract_id:id(20),p_document_type:'GR',
   auxiliaries:[],p_requests:[{id:id(30)},{id:id(31)}],forklift:{supplier_id:id(10),operator_name:'Operador prueba',hourly_rate:75,transport_request_id:id(30)} }
  const routes = () => scalar('SELECT count(*)::int AS value FROM dispatches')
  const routesBefore = await routes()
  const schedule = (plate, special_services, extra = {}) => db.query('SELECT schedule_route_resources($1::jsonb) AS value',[JSON.stringify({ ...base, ...extra, p_vehicle_plate:plate, special_services })])
  await assert.rejects(schedule('E2-X1',{items:[{transport_request_id:id(31),concept:'ESTIBA',supplier_id:id(12),agreed_rate:90}]}),/motivo/,'added service needs a reason')
  await assert.rejects(schedule('E2-X2',{items:[{id:grua,supplier_id:id(12),agreed_rate:90}]}),/no presta servicios de grua/,'supplier category must match the service')
  await assert.rejects(schedule('E2-X3',{items:[{id:grua,supplier_id:id(13),agreed_rate:90}]}),/proveedor activo/,'inactive supplier rejected')
  await assert.rejects(schedule('E2-X4',{items:[{id:grua,supplier_id:id(11),agreed_rate:0}]}),/tarifa acordada/)
  await assert.rejects(schedule('E2-X5',{removed:[{id:estibaPedida,reason:'x'}]}),/motivo/,'removing a requested service needs a reason')
  // El administrador puede exceder la partida: el saldo se valida con un usuario de Programación y Ruteo.
  await db.exec(`INSERT INTO roles(id,name,permissions) VALUES('${id(92)}','Despacho','["despacho"]');
   INSERT INTO profiles(id,role_id,first_name) VALUES('${id(93)}','${id(92)}','Despacho');
   INSERT INTO auth.users VALUES('${id(93)}'); INSERT INTO user_site_access(user_id,site_id) SELECT '${id(93)}',primary_site_id();
   SELECT set_config('request.jwt.claim.sub','${id(93)}',false);`)
  await assert.rejects(schedule('E2-X6',{items:[{id:grua,supplier_id:id(11),agreed_rate:9000,agreed_qty:1}]}),/Saldo insuficiente/,'agreed cost must fit the budget')
  await db.exec(`SELECT set_config('request.jwt.claim.sub','${id(1)}',false)`)
  assert.equal(await routes(),routesBefore,'failed agreements roll back the whole programming')
  assert.equal(await scalar(`SELECT status AS value FROM transport_unloading_costs WHERE id=$1`,[grua]),'ESTIMADO')

  // --- Programación válida ---
  const reserved = () => scalar(`SELECT reserved_pen::float AS value FROM contract_budgets WHERE contract_id=$1`,[id(20)])
  const reserveBefore = await reserved()
  const linesBefore = await scalar('SELECT count(*)::int AS value FROM transport_unloading_costs')
  const route = (await schedule('E2-OK',{
   items:[
    {id:grua,supplier_id:id(11),billing_unit:'HORA',agreed_rate:100,agreed_qty:2,min_billable_qty:3,fraction_minutes:30},
    {id:mont,supplier_id:id(11),billing_unit:'SERVICIO',agreed_rate:999,agreed_qty:4},
    {transport_request_id:id(31),concept:'ESTIBA',description:'Cuadrilla de 4',supplier_id:id(12),billing_unit:'JORNADA',agreed_rate:90,agreed_qty:1,workers:4,reason:'Cuadrilla adicional por volumen'}],
   removed:[{id:estibaPedida,reason:'El cliente descarga con su personal'}] })).rows[0].value
  assert.ok(route)
  const line = l => db.query(`SELECT status,planned_pen::float AS planned,supplier_id,billing_unit,agreed_rate::float AS rate,agreed_qty::float AS qty,workers,
   min_billable_qty::float AS min,fraction_minutes,origin,void_reason,dispatch_id,agreed_reason FROM transport_unloading_costs WHERE id=$1`,[l]).then(r => r.rows[0])
  const g = await line(grua)
  assert.deepEqual([g.status,g.planned,g.supplier_id,g.billing_unit,g.rate,g.qty,g.min,g.fraction_minutes],['PLANIFICADO',300,id(11),'HORA',100,2,3,30],'grua: 100/h × max(2, mínimo 3) = 300')
  const m = await line(mont)
  assert.deepEqual([m.planned,m.supplier_id,m.billing_unit,m.rate],[300,id(10),'HORA',75],'forklift line takes supplier and hourly rate from the programmed forklift: 75 × 4 h')
  assert.equal(await scalar('SELECT unloading_cost_id AS value FROM route_forklifts WHERE dispatch_id=$1',[route]),mont,'forklift stays linked to its line')
  const added = await scalar(`SELECT id AS value FROM transport_unloading_costs WHERE transport_request_id=$1 AND concept='ESTIBA' AND origin='PROGRAMACION'`,[id(31)])
  const a = await line(added)
  assert.deepEqual([a.status,a.planned,a.workers,a.billing_unit,a.dispatch_id,a.agreed_reason],['PLANIFICADO',360,4,'JORNADA',route,'Cuadrilla adicional por volumen'],'stevedoring: 4 workers × 1 jornada × 90')
  const r = await line(estibaPedida)
  assert.deepEqual([r.status,r.planned,r.void_reason,r.dispatch_id],['ANULADO',null,'El cliente descarga con su personal',route],'removed requested service is voided with its reason')
  assert.equal(await scalar('SELECT count(*)::int AS value FROM transport_unloading_costs'),linesBefore+1,'only the added service creates a line; inherited ones are reused')
  assert.equal(await reserved(),reserveBefore+960,'reserve = agreed amounts (300 + 300 + 360), removed service not reserved')

  // Historial: un evento acordado por servicio con monto anterior, nuevo y motivo; el retiro queda como ESTADO.
  const events = (await db.query(`SELECT unloading_cost_id AS line,stage,old_amount::float AS old,new_amount::float AS new,reason,detail
   FROM service_cost_events WHERE dispatch_id=$1 AND ((detail->>'supplier_id') IS NOT NULL OR stage='ESTADO') ORDER BY created_at,id`,[route])).rows
  const ev = l => events.filter(e => e.line === l)
  assert.deepEqual(ev(grua).map(e => [e.stage,e.old,e.new]),[['ACORDADO',80,300]],'grua: referential 80 → agreed 300')
  assert.deepEqual(ev(mont).map(e => [e.stage,e.old,e.new]),[['ACORDADO',120,300]])
  assert.equal(ev(added)[0].reason,'Cuadrilla adicional por volumen'); assert.equal(ev(added)[0].detail.added_at_programming,true)
  assert.deepEqual(ev(estibaPedida).map(e => [e.stage,e.reason]),[['ESTADO','El cliente descarga con su personal']])
  await assert.rejects(db.exec(`UPDATE service_cost_events SET reason='x'`),/no se modifica/,'history is append-only')
  await assert.rejects(db.exec(`DELETE FROM service_cost_events`),/no se modifica/)
  const history = await rpc('service_cost_history($1)',[route])
  assert.equal(history.success,true); assert.ok(history.events.some(e => e.supplier === 'Grúas prueba' && e.user === 'Prueba Admin'),'history shows supplier and user')

  // Torre de Control: replanificar exige motivo y lo registra.
  const items = [{id:grua,planned_pen:320},{id:mont,planned_pen:300},{id:added,planned_pen:360}]
  assert.equal((await rpc('plan_dispatch_unloading_with_reason($1,$2::jsonb,$3)',[route,JSON.stringify(items),' '])).success,false)
  assert.equal((await rpc('plan_dispatch_unloading_with_reason($1,$2::jsonb,$3)',[route,JSON.stringify(items),'Grúa cobra traslado adicional'])).success,true)
  assert.equal(await scalar(`SELECT reason AS value FROM service_cost_events WHERE unloading_cost_id=$1 AND new_amount=320`,[grua]),'Grúa cobra traslado adicional')
  assert.equal(await reserved(),reserveBefore+980)
  // Volver a enviar el mismo acuerdo no duplica líneas ni vínculo; la reserva vuelve al monto acordado.
  const again = await rpc('set_special_service_agreements($1,$2::jsonb)',[route,JSON.stringify({items:[{id:grua,supplier_id:id(11),billing_unit:'HORA',agreed_rate:100,agreed_qty:2,min_billable_qty:3}]})])
  assert.equal(again.success,true,again.error)
  assert.equal(await scalar('SELECT count(*)::int AS value FROM transport_unloading_costs'),linesBefore+1)
  assert.equal(await reserved(),reserveBefore+960)
  assert.equal(await scalar('SELECT unloading_cost_id AS value FROM route_forklifts WHERE dispatch_id=$1',[route]),mont)

  // Sin montacarga pedido: el servicio agregado para el montacarga programado se vincula a él.
  await db.query(`INSERT INTO transport_requests(id,contract_id,request_number,site_id) VALUES($1,$2,'S-8',primary_site_id())`,[id(35),id(20)])
  const r2 = (await schedule('E2-MC',{items:[{transport_request_id:id(35),concept:'MONTACARGAS',agreed_qty:2.5,reason:'Montacarga no previsto en la solicitud'}]},
   { p_requests:[{id:id(35)}], forklift:{supplier_id:id(10),operator_name:'Operador prueba',hourly_rate:60,transport_request_id:id(35)} })).rows[0].value
  const mc = await scalar(`SELECT id AS value FROM transport_unloading_costs WHERE dispatch_id=$1`,[r2])
  assert.equal(await scalar('SELECT unloading_cost_id AS value FROM route_forklifts WHERE dispatch_id=$1',[r2]),mc,'added forklift line is linked')
  assert.equal(await scalar('SELECT planned_pen::float AS value FROM transport_unloading_costs WHERE id=$1',[mc]),150,'60/h × 2.5 h')

  // Verificación de producción C171 sobre este esquema
  await assert.rejects(db.exec(read('supabase/tests/caja_c171_special_services_agreements.test.sql')),/CAJA C171 PASS/)
  await db.exec('ROLLBACK').catch(() => {})

  // Permisos: sin despacho no se acuerdan costos ni se lee el historial.
  await db.exec(`INSERT INTO roles(id,name,permissions) VALUES('${id(90)}','Lector','[]');
   INSERT INTO profiles(id,role_id,first_name) VALUES('${id(91)}','${id(90)}','Lector');
   SELECT set_config('request.jwt.claim.sub','${id(91)}',false);`)
  assert.equal((await rpc('set_special_service_agreements($1,$2::jsonb)',[route,'{"items":[]}'])).success,false)
  assert.equal((await rpc('service_cost_history($1)',[route])).success,false)
  console.log('PASS costo acordado de servicios especiales (Etapa 2)')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
