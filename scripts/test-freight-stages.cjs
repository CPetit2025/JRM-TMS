// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Etapa 3: flete con etapas — acordado al programar (renegociable solo mientras la ruta está programada), ajustes
// después de la salida, final con adicionales y motivo, reparto por OT en rutas mixtas e historial de costos.
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
  // Tipo producción: flete vigente en dispatches, reparto por OT y servicios FLETE de la OT.
  await db.exec(`ALTER TABLE dispatches ADD COLUMN freight_cost numeric DEFAULT 0;
   ALTER TABLE transport_requests ADD COLUMN IF NOT EXISTS reserved_pen numeric DEFAULT 0;
   ALTER TABLE contract_services ADD COLUMN service_type text, ADD COLUMN dispatch_id uuid, ADD COLUMN amount_pen numeric DEFAULT 0;
   CREATE TABLE dispatch_request_freight(dispatch_id uuid NOT NULL REFERENCES dispatches(id),request_id uuid NOT NULL REFERENCES transport_requests(id),
    contract_id uuid REFERENCES contracts(id),amount_pen numeric(15,2) NOT NULL CHECK(amount_pen>=0),service_id uuid REFERENCES contract_services(id),
    status text NOT NULL DEFAULT 'RESERVADO' CHECK(status IN ('RESERVADO','CONSUMIDO','LIBERADO')),PRIMARY KEY(dispatch_id,request_id));
   CREATE FUNCTION update_contract_service_amount(p_service_id uuid,p_new_amount numeric) RETURNS boolean LANGUAGE sql AS $$
    UPDATE contract_services SET amount_pen=p_new_amount WHERE id=p_service_id RETURNING true $$;`)
  await db.exec(read('supabase/migrations/20261105090000_herencia_servicios_especiales.sql'))
  await db.exec(read('supabase/migrations/20261105100000_route_forklift_unloading_cost_index.sql'))
  await db.exec(read('supabase/migrations/20261107090000_costo_acordado_servicios.sql'))
  // Ruta mixta previa a la migración: su acordado se toma del monto vigente.
  await db.exec(`INSERT INTO dispatches(id,vehicle_plate,status,site_id,freight_cost) VALUES('${id(80)}','OLD-1','LIQUIDADO',primary_site_id(),100);
   INSERT INTO dispatch_request_freight(dispatch_id,request_id,contract_id,amount_pen,status) VALUES('${id(80)}','${id(39)}','${id(21)}',100,'CONSUMIDO');`)
  const migration = read('supabase/migrations/20261108090000_flete_etapas.sql')
  assert.doesNotMatch(migration, /replace\(\s*(def|source)/i, 'functions are rewritten in full, never patched with replace()')
  await db.exec(migration)
  await db.exec(migration) // reaplicable
  const scalar = async (sql, params=[]) => (await db.query(sql,params)).rows[0]?.value
  const rpc = async (sql, params=[]) => (await db.query(`SELECT ${sql} AS value`,params)).rows[0].value
  assert.equal(await scalar(`SELECT agreed_pen::float AS value FROM dispatch_request_freight WHERE dispatch_id=$1`,[id(80)]),100,'backfill: historical agreed = current amount')
  const stage = d => db.query(`SELECT agreed_pen::float AS agreed,base_pen::float AS base,extras_pen::float AS extras,final_pen::float AS final,executed_as_planned,final_reason FROM dispatch_freight_stages WHERE dispatch_id=$1`,[d]).then(r => r.rows[0])
  const events = d => db.query(`SELECT stage,old_amount::float AS old,new_amount::float AS new,reason FROM service_cost_events WHERE service_kind='FLETE' AND dispatch_id=$1 ORDER BY created_at,id`,[d]).then(r => r.rows.map(e => [e.stage,e.old,e.new,e.reason]))
  const final = (d, p) => rpc('register_dispatch_freight_final($1,$2::jsonb)',[d,JSON.stringify(p)])

  // --- Ruta de una OT: acordado al programar, renegociado solo mientras está programada ---
  await db.query(`UPDATE transport_requests SET service_cost=480 WHERE id=$1`,[id(30)])
  await db.query(`INSERT INTO dispatches(id,vehicle_plate,status,site_id,contract_id,freight_cost) VALUES($1,'F-1','PROGRAMADO',primary_site_id(),$2,500)`,[id(81),id(20)])
  await db.query(`INSERT INTO dispatch_requests(dispatch_id,transport_request_id) VALUES($1,$2)`,[id(81),id(30)])
  assert.equal((await stage(id(81))).agreed,500,'agreed freight fixed at programming')
  await db.exec(`BEGIN; SELECT set_config('tms.cost_reason','Transportista ajusta por peaje nuevo',true); UPDATE dispatches SET freight_cost=550 WHERE id='${id(81)}'; COMMIT;`)
  assert.equal((await stage(id(81))).agreed,550,'renegotiated while programmed')
  await db.query(`UPDATE dispatches SET status='EN RUTA' WHERE id=$1`,[id(81)])
  assert.equal((await final(id(81),{executed_as_planned:true})).success,false,'final only after execution')
  await db.query(`UPDATE dispatches SET freight_cost=600 WHERE id=$1`,[id(81)])
  assert.equal((await stage(id(81))).agreed,550,'a change after departure does not overwrite the agreed freight')
  assert.deepEqual(await events(id(81)),[['ACORDADO',null,500,null],['ACORDADO',500,550,'Transportista ajusta por peaje nuevo'],['AJUSTE',550,600,null]])

  // --- Final después de la ejecución: conforme, con adicionales justificados o distinto a lo programado ---
  await db.query(`UPDATE dispatches SET status='ENTREGADO' WHERE id=$1`,[id(81)])
  let r = await final(id(81),{executed_as_planned:true})
  assert.equal(r.success,true,r.error); assert.equal(Number(r.final_pen),550)
  r = await final(id(81),{executed_as_planned:true,extras_pen:80})
  assert.equal(r.success,false); assert.match(r.error,/Justifique/,'a difference with the agreed freight needs a reason')
  r = await final(id(81),{executed_as_planned:true,extras_pen:80,reason:'Espera de 2 h en obra'})
  assert.equal(r.success,true); assert.equal(Number(r.final_pen),630); assert.equal(Number(r.difference_pen),80)
  assert.deepEqual(await stage(id(81)),{agreed:550,base:550,extras:80,final:630,executed_as_planned:true,final_reason:'Espera de 2 h en obra'})
  r = await final(id(81),{executed_as_planned:false,base_pen:500,reason:'Se entregó solo una parada'})
  assert.equal(Number(r.final_pen),500)
  assert.deepEqual((await events(id(81))).filter(e => e[0]==='FINAL').map(e => [e[1],e[2]]),[[null,550],[550,630],[630,500]],'each final registration is kept in the history')
  assert.equal((await final(id(81),{executed_as_planned:false,reason:'Sin monto'})).success,false,'not as planned needs the executed amount')
  const sum1 = await rpc('dispatch_freight_summary($1)',[id(81)])
  assert.deepEqual([sum1.success,Number(sum1.referential_pen),Number(sum1.agreed_pen),Number(sum1.current_pen),Number(sum1.final_pen),sum1.final_by,sum1.can_register_final],
   [true,480,550,600,500,'Prueba Admin',true],'summary compares referential, agreed, current and final')

  // --- Ruta mixta: acordado y final por OT, sin duplicar ---
  await db.query(`INSERT INTO dispatches(id,vehicle_plate,status,site_id,freight_cost) VALUES($1,'F-2','PROGRAMADO',primary_site_id(),500)`,[id(82)])
  await db.query(`INSERT INTO dispatch_requests(dispatch_id,transport_request_id) VALUES($1,$2),($1,$3)`,[id(82),id(31),id(39)])
  await db.query(`INSERT INTO dispatch_request_freight(dispatch_id,request_id,contract_id,amount_pen) VALUES($1,$2,$3,300),($1,$4,$5,200)`,[id(82),id(31),id(20),id(39),id(21)])
  await db.query(`UPDATE dispatch_request_freight SET amount_pen=320 WHERE dispatch_id=$1 AND request_id=$2`,[id(82),id(31)])
  await db.query(`UPDATE dispatches SET status='RETORNO_COMPLETADO' WHERE id=$1`,[id(82)])
  await db.query(`UPDATE dispatch_request_freight SET amount_pen=330 WHERE dispatch_id=$1 AND request_id=$2`,[id(82),id(31)])
  const perOt = () => db.query(`SELECT request_id,agreed_pen::float AS agreed,final_pen::float AS final FROM dispatch_request_freight WHERE dispatch_id=$1 ORDER BY request_id`,[id(82)]).then(x => x.rows)
  assert.deepEqual((await perOt()).map(x => x.agreed),[320,200],'per-OT agreed follows renegotiation only while programmed')
  r = await final(id(82),{executed_as_planned:false,base_pen:520,extras_pen:30,reason:'Peaje y estadía'})
  assert.equal(r.success,true,r.error)
  assert.deepEqual((await perOt()).map(x => x.final),[338.46,211.54],'final split by agreed share, rounding on the last OT, sum = 550')
  r = await final(id(82),{executed_as_planned:false,base_pen:520,extras_pen:30,reason:'Peaje y estadía',allocation:[{request_id:id(31),final_pen:400}]})
  assert.equal(r.success,false,'allocation must cover every OT and add up to the final')
  r = await final(id(82),{executed_as_planned:false,base_pen:520,extras_pen:30,reason:'Peaje en la OT A',allocation:[{request_id:id(31),final_pen:350},{request_id:id(39),final_pen:200}]})
  assert.equal(r.success,true,r.error); assert.deepEqual((await perOt()).map(x => x.final),[350,200])
  const sum2 = await rpc('dispatch_freight_summary($1)',[id(82)])
  assert.equal(sum2.by_request.length,2); assert.equal(Number(sum2.by_request.find(x => x.request_id===id(31)).agreed_pen),320)

  // --- Corrección del flete en Servicios de la OT con la ruta cerrada: queda como ajuste con motivo ---
  await db.query(`INSERT INTO contract_services(id,contract_id,service_type,dispatch_id,amount_pen) VALUES($1,$2,'FLETE',$3,600)`,[id(83),id(20),id(81)])
  await db.query(`UPDATE dispatches SET status='LIQUIDADO' WHERE id=$1`,[id(81)])
  await assert.rejects(db.query(`SELECT update_contract_service_amount_with_reason($1,620,' ')`,[id(83)]),/motivo/)
  assert.equal(await rpc('update_contract_service_amount_with_reason($1,620,$2)',[id(83),'Factura con recargo']),true)
  assert.deepEqual((await events(id(81))).at(-1),['AJUSTE',600,620,'Factura con recargo'])

  // Verificación de producción C172 sobre este esquema
  await assert.rejects(db.exec(read('supabase/tests/caja_c172_flete_etapas.test.sql')),/CAJA C172 PASS/)
  await db.exec('ROLLBACK').catch(() => {})

  // Permisos: sin despacho ni contratos no se registra el final ni se ve el resumen.
  await db.exec(`INSERT INTO roles(id,name,permissions) VALUES('${id(90)}','Lector','[]');
   INSERT INTO profiles(id,role_id,first_name) VALUES('${id(91)}','${id(90)}','Lector');
   SELECT set_config('request.jwt.claim.sub','${id(91)}',false);`)
  assert.equal((await final(id(81),{executed_as_planned:true})).success,false)
  assert.equal((await rpc('dispatch_freight_summary($1)',[id(81)])).success,false)
  console.log('PASS flete con etapas: acordado al programar, ajuste después de la salida, final con adicionales y motivo, reparto por OT e historial (Etapa 3)')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
