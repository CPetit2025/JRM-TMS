// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Etapa 4: cierre económico por ruta — costo final por servicio con reglas de cobro, envío, observación, aprobación con
// permiso propio, impacto en la partida solo por diferencia, reapertura con motivo e historial solo de inserción.
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
   '20261107090000_costo_acordado_servicios.sql','20261108100000_flete_etapas.sql']) await db.exec(read('supabase/migrations/'+m))
  const migration = read('supabase/migrations/20261109090000_cierre_economico.sql')
  assert.doesNotMatch(migration, /replace\(\s*(def|source)/i, 'functions are rewritten in full, never patched with replace()')
  await db.exec(migration)
  await db.exec(migration) // reaplicable
  const scalar = async (sql, params=[]) => (await db.query(sql,params)).rows[0]?.value
  const rpc = async (sql, params=[]) => (await db.query(`SELECT ${sql} AS value`,params)).rows[0].value

  // Reglas de cobro: fracción hacia arriba, mínimo, hora completa, jornada y sin ejecución.
  const billable = (u,q,f,m) => scalar('SELECT economic_billable_qty($1,$2,$3,$4)::float AS value',[u,q,f,m])
  assert.equal(await billable('HORA',2.25,30,3),3,'2 h 15 min → 2.5 h por fracción de 30, mínimo 3')
  assert.equal(await billable('HORA',3.2,30,3),3.5)
  assert.equal(await billable('HORA',3.1,15,null),3.25)
  assert.equal(await billable('HORA',1.1,null,null),2,'sin fracción: hora completa')
  assert.equal(await billable('JORNADA',0.5,null,1),1)
  assert.equal(await billable('SERVICIO',1,null,null),1)
  assert.equal(await billable('HORA',0,30,3),0,'no ejecutado: no se cobra mínimo')

  // --- Ruta de una OT con grúa (acordada por hora) y estiba agregada en programación ---
  await db.exec(`INSERT INTO suppliers(id,business_name,tax_id,category) VALUES('${id(11)}','Grúas prueba','20111111111','GRUA'),('${id(12)}','Estiba prueba','20222222222','ESTIBA');`)
  await rpc('save_request_unloading_costs($1,$2::jsonb)',[id(30),JSON.stringify([{concept:'GRUA',estimated_pen:0}])])
  await rpc('apply_request_tariff($1)',[id(30)])
  const grua = await scalar(`SELECT id AS value FROM transport_unloading_costs WHERE transport_request_id=$1 AND concept='GRUA'`,[id(30)])
  const budget = () => db.query(`SELECT reserved_pen::float AS reserved,consumed_pen::float AS consumed FROM contract_budgets WHERE contract_id=$1`,[id(20)]).then(r => r.rows[0])
  const route = await scalar('SELECT schedule_route_resources($1::jsonb) AS value',[JSON.stringify({ mode:'PROPIA',p_driver_id:null,p_vehicle_plate:'E4-1',
   p_departure:'2026-10-30T12:00:00Z',p_estimated_km:10,p_freight_cost:0,p_contract_id:id(20),p_document_type:'GR',auxiliaries:[],p_requests:[{id:id(30)}],forklift:null,
   special_services:{items:[{id:grua,supplier_id:id(11),billing_unit:'HORA',agreed_rate:100,agreed_qty:2,min_billable_qty:3,fraction_minutes:30},
    {transport_request_id:id(30),concept:'ESTIBA',supplier_id:id(12),billing_unit:'JORNADA',agreed_rate:90,agreed_qty:1,workers:4,reason:'Cuadrilla por volumen'}]} })])
  const estiba = await scalar(`SELECT id AS value FROM transport_unloading_costs WHERE dispatch_id=$1 AND concept='ESTIBA'`,[route])
  await db.query(`UPDATE dispatches SET freight_cost=500 WHERE id=$1`,[route])  // flete acordado al programar
  const b0 = await budget()
  const validate = (line, p) => rpc('validate_service_final($1,$2::jsonb)',[line,JSON.stringify(p)])
  const action = (a, reason=null) => rpc('economic_closure_action($1,$2,$3)',[route,a,reason])

  await db.query(`UPDATE dispatches SET status='EN RUTA' WHERE id=$1`,[route])
  assert.match((await validate(grua,{executed_qty:2})).error,/después de la ejecución/)
  await db.query(`UPDATE dispatches SET status='ENTREGADO' WHERE id=$1`,[route])
  // Caja aprobó la estiba por 380 (consumo real); el cierre la ajusta a lo validado.
  await db.query(`SELECT unloading_consume($1,380,NULL,'Estiba prueba')`,[estiba])
  let r = await validate(grua,{executed_qty:2.25})
  assert.equal(r.success,true,r.error); assert.equal(Number(r.final_pen),300,'2.25 h → mínimo 3 h × 100, igual a lo acordado: sin motivo')
  r = await validate(grua,{executed_qty:3.2})
  assert.match(r.error,/Justifique/,'final above the agreed cost needs a reason')
  r = await validate(grua,{executed_qty:3.2,reason:'La descarga tomó más tiempo'})
  assert.equal(Number(r.final_pen),350); assert.equal(Number(r.billable_qty),3.5)
  r = await validate(estiba,{executed_qty:1,workers:4,extras_pen:40,reason:'Movilidad de la cuadrilla'})
  assert.equal(Number(r.final_pen),400,'4 trabajadores × 1 jornada × 90 + 40 adicionales')

  // No se envía con pendientes: la ruta no está cerrada y falta el flete final.
  r = await action('ENVIAR')
  assert.equal(r.success,false); assert.match(r.error,/Cierre la ruta/); assert.match(r.error,/flete final/)
  // Cierre de la ruta en Torre de Control: consume el flete vigente (como close_dispatch_route).
  await db.query(`INSERT INTO contract_services(id,contract_id,service_type,dispatch_id,amount_pen) VALUES($1,$2,'FLETE',$3,500)`,[id(85),id(20),route])
  await db.query(`UPDATE contract_budgets SET consumed_pen=consumed_pen+500 WHERE contract_id=$1`,[id(20)])
  await db.query(`UPDATE dispatches SET status='LIQUIDADO' WHERE id=$1`,[route])
  r = await rpc('register_dispatch_freight_final($1,$2::jsonb)',[route,JSON.stringify({executed_as_planned:true,extras_pen:50,reason:'Peaje adicional'})])
  assert.equal(r.success,true,r.error)
  const queue = await rpc(`economic_closure_queue('2026-10-01','2026-10-31')`)
  const row = queue.routes.find(x => x.dispatch_id === route)
  assert.deepEqual([row.state.status,row.state.pending.length,Number(row.state.agreed_pen),Number(row.state.final_pen),Number(row.state.extras_pen)],
   ['PENDIENTE',0,1160,1300,90],'agreed 500 + 300 + 360; final 550 + 350 + 400; extras 50 + 40')

  // Envío, observación, reenvío y aprobación (permiso de Cierre económico)
  assert.equal((await action('ENVIAR')).status,'EN_REVISION')
  assert.match((await validate(grua,{executed_qty:3})).error,/en revisión o cerrado/,'locked while under review')
  r = await rpc('register_dispatch_freight_final($1,$2::jsonb)',[route,JSON.stringify({executed_as_planned:true})])
  assert.match(r.error,/en revisión o cerrado/,'freight final locked while under review')
  assert.match((await action('OBSERVAR')).error,/observación/,'observation needs a reason')
  assert.equal((await action('OBSERVAR','Adjuntar el sustento del peaje')).status,'OBSERVADO')
  assert.equal((await action('ENVIAR')).status,'EN_REVISION')
  // Programación (sin permiso de Cierre económico) no aprueba.
  await db.exec(`INSERT INTO roles(id,name,permissions) VALUES('${id(92)}','Despacho','["despacho"]');
   INSERT INTO profiles(id,role_id,first_name) VALUES('${id(93)}','${id(92)}','Despacho');
   INSERT INTO auth.users VALUES('${id(93)}'); INSERT INTO user_site_access(user_id,site_id) SELECT '${id(93)}',primary_site_id();
   SELECT set_config('request.jwt.claim.sub','${id(93)}',false);`)
  assert.match((await action('APROBAR')).error,/permiso de Cierre económico/)
  await db.exec(`SELECT set_config('request.jwt.claim.sub','${id(1)}',false)`)
  r = await action('APROBAR')
  assert.equal(r.status,'CERRADO',r.error)
  const b1 = await budget()
  assert.deepEqual([b1.reserved,b1.consumed],[b0.reserved-360-300,b0.consumed+380+500+350+20+50],
   'estiba de Caja: libera 360 y consume 380 (+20 al cierre); grúa: libera 300 y consume 350; flete 500 → +50')
  assert.deepEqual(r.detail.budget_delta_by_contract,{[id(20)]:120})
  assert.equal(await scalar(`SELECT amount_pen::float AS value FROM contract_services WHERE id=$1`,[id(85)]),550,'the OT freight service shows the final freight')
  assert.equal(await scalar(`SELECT actual_pen::float AS value FROM transport_unloading_costs WHERE id=$1`,[estiba]),400)

  // Reapertura con motivo; al volver a cerrar solo se mueve la diferencia.
  assert.equal((await action('REABRIR')).success,false)
  assert.equal((await action('REABRIR','Factura de la grúa por 3 h')).status,'PENDIENTE')
  assert.equal((await validate(grua,{executed_qty:3})).success,true)
  await action('ENVIAR'); r = await action('APROBAR')
  assert.equal(r.status,'CERRADO',r.error)
  const b2 = await budget()
  assert.deepEqual([b2.reserved,b2.consumed],[b1.reserved,b1.consumed-50],'re-close moves only the difference (350 → 300)')
  assert.deepEqual((await db.query(`SELECT action FROM economic_closure_events WHERE dispatch_id=$1 ORDER BY created_at`,[route])).rows.map(x => x.action),
   ['ENVIAR','OBSERVAR','ENVIAR','APROBAR','REABRIR','ENVIAR','APROBAR'])
  await assert.rejects(db.exec(`DELETE FROM economic_closure_events`),/no se modifica/,'closure history is append-only')
  const detail = await rpc('economic_closure_detail($1)',[route])
  assert.equal(detail.success,true); assert.equal(detail.services.length,2); assert.equal(detail.events.length,7); assert.equal(detail.can_approve,true)

  // --- Ruta mixta: el flete final se aplica por OT. Como en producción, editar el servicio FLETE sincroniza el reparto
  //     y la guarda de referencias solo deja pasar filas con OT. ---
  await db.exec(`CREATE FUNCTION sync_mixed() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
    UPDATE dispatch_request_freight SET amount_pen=NEW.amount_pen WHERE service_id=NEW.id AND status<>'LIBERADO'; RETURN NEW; END$$;
   CREATE TRIGGER sync_mixed AFTER UPDATE OF amount_pen ON contract_services FOR EACH ROW EXECUTE FUNCTION sync_mixed();
   CREATE FUNCTION ref_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.contract_id IS NOT NULL THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'El flete y la descarga superan el importe aprobado para esta referencia'; END$$;
   CREATE TRIGGER ref_guard BEFORE UPDATE ON dispatch_request_freight FOR EACH ROW EXECUTE FUNCTION ref_guard();`)
  const mixed = id(86)
  await db.query(`INSERT INTO dispatches(id,vehicle_plate,status,site_id,freight_cost,scheduled_departure) VALUES($1,'E4-M','PROGRAMADO',primary_site_id(),500,'2026-10-30T12:00:00Z')`,[mixed])
  await db.query(`INSERT INTO dispatch_requests(dispatch_id,transport_request_id) VALUES($1,$2),($1,$3)`,[mixed,id(31),id(39)])
  await db.query(`INSERT INTO contract_services(id,contract_id,service_type,dispatch_id,amount_pen) VALUES($1,$2,'FLETE',$3,300),($4,$5,'FLETE',$3,200)`,[id(87),id(20),mixed,id(88),id(21)])
  await db.query(`INSERT INTO dispatch_request_freight(dispatch_id,request_id,contract_id,amount_pen,service_id,status) VALUES($1,$2,$3,300,$4,'CONSUMIDO'),($1,$5,$6,200,$7,'CONSUMIDO')`,
   [mixed,id(31),id(20),id(87),id(39),id(21),id(88)])
  await db.query(`UPDATE dispatches SET status='LIQUIDADO' WHERE id=$1`,[mixed])
  r = await rpc('register_dispatch_freight_final($1,$2::jsonb)',[mixed,JSON.stringify({executed_as_planned:true,extras_pen:60,reason:'Estadía en ambas obras',
   allocation:[{request_id:id(31),final_pen:340},{request_id:id(39),final_pen:220}]})])
  assert.equal(r.success,true,r.error)
  const consumed = c => scalar(`SELECT consumed_pen::float AS value FROM contract_budgets WHERE contract_id=$1`,[c])
  const [c20, c21] = [await consumed(id(20)), await consumed(id(21))]
  assert.equal((await rpc('economic_closure_action($1,$2,$3)',[mixed,'ENVIAR',null])).status,'EN_REVISION')
  r = await rpc('economic_closure_action($1,$2,$3)',[mixed,'APROBAR',null])
  assert.equal(r.status,'CERRADO',r.error)
  assert.deepEqual([await consumed(id(20)) - c20, await consumed(id(21)) - c21],[40,20],'each OT absorbs only its own difference')
  assert.deepEqual((await db.query(`SELECT amount_pen::float AS a FROM dispatch_request_freight WHERE dispatch_id=$1 ORDER BY request_id`,[mixed])).rows.map(x => x.a),[340,220])

  // --- Etapa 6: indicadores (cada costo una vez; rutas mixtas por OT) ---
  await db.exec(`CREATE TABLE documentary_closures(dispatch_id uuid, request_id uuid, status text);
   INSERT INTO documentary_closures VALUES('${route}','${id(30)}','PENDIENTE'),('${mixed}','${id(31)}','COMPLETO'),('${mixed}','${id(39)}','COMPLETO');`)
  await db.exec(read('supabase/migrations/20261110090000_indicadores_costos_servicios.sql'))
  const ind = await rpc(`service_cost_indicators('2026-10-01','2026-10-31')`)
  assert.equal(ind.success,true,ind.error); assert.equal(ind.routes,2)
  const t = ind.totals
  assert.deepEqual([t.items,t.with_final,Number(t.referential_pen),Number(t.agreed_pen),Number(t.final_pen),Number(t.extras_pen)],[5,5,380,1660,1810,150],
   'freight 300/500/550 + grúa 80/300/300 + estiba 0/360/400 + mixed OT A 0/300/340 + OT B 0/200/220')
  const flete = ind.by_type.find(x => x.concept === 'FLETE')
  assert.deepEqual([flete.items,Number(flete.agreed_pen),Number(flete.final_pen)],[3,1000,1110])
  const ot20 = ind.by_contract.find(x => x.contract_id === id(20)), ot21 = ind.by_contract.find(x => x.contract_id === id(21))
  assert.deepEqual([Number(ot20.agreed_pen),Number(ot20.final_pen),Number(ot21.agreed_pen),Number(ot21.final_pen)],[1460,1590,200,220])
  assert.ok(ot20.budget && Number(ot20.budget.allocated_pen) === 5000,'OT budget beside its costs')
  assert.deepEqual(ind.by_supplier.find(x => x.supplier === 'Grúas prueba').final_pen*1,300)
  assert.deepEqual(ind.pending,{routes_open:0,economic_pending:0,economic_review:0,economic_closed:2,documentary_pending_services:1,documentary_complete_economic_pending:0})
  assert.equal((await rpc(`service_cost_indicators('2026-01-01','2027-12-31')`)).success,false,'period up to 366 days')

  await assert.rejects(db.exec(read('supabase/tests/caja_c174_indicadores_costos.test.sql')),/CAJA C174 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  await db.exec(`SELECT set_config('request.jwt.claim.sub','${id(1)}',false)`)

  // --- Etapa E: referencial protegido. Un recojo ya autorizado (evento COTIZACION_TERCERO) recupera su referencial original;
  //     una modificación del flete tras aprobar la solicitud conserva el primer valor. ---
  await db.exec(`ALTER TABLE transport_requests ADD COLUMN approved_at timestamptz;
   CREATE TABLE transport_request_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),request_id uuid REFERENCES transport_requests(id) ON DELETE CASCADE,
    actor_id uuid,action text,previous_state jsonb,next_state jsonb,created_at timestamptz DEFAULT now());
   INSERT INTO transport_request_events(request_id,action,previous_state,next_state) VALUES
    ('${id(31)}','STATUS_CHANGED','{"service_cost":120}','{"service_cost":200,"source":"COTIZACION_TERCERO"}');`)
  const refMigration = read('supabase/migrations/20261111090000_referencial_protegido.sql')
  assert.doesNotMatch(refMigration, /UPDATE public\.transport_requests/i, 'never updates transport_requests (production guards)')
  await db.exec(refMigration); await db.exec(refMigration)
  const referential = r0 => scalar('SELECT request_referential_freight($1)::float AS value',[r0])
  assert.equal(await referential(id(31)),120,'backfill from the third-party quote event')
  assert.equal(await referential(id(30)),300,'without changes: the current service_cost')
  await db.query(`UPDATE transport_requests SET service_cost=999 WHERE id=$1`,[id(30)])
  assert.equal(await referential(id(30)),999,'before approval the referential can still change')
  await db.query(`UPDATE transport_requests SET service_cost=300, approved_at=now() WHERE id=$1`,[id(30)])
  await db.query(`UPDATE transport_requests SET service_cost=450 WHERE id=$1`,[id(30)])
  await db.query(`UPDATE transport_requests SET service_cost=500 WHERE id=$1`,[id(30)])
  assert.equal(await referential(id(30)),300,'after approval the first value is kept')
  const ind2 = await rpc(`service_cost_indicators('2026-10-01','2026-10-31')`)
  assert.equal(Number(ind2.totals.referential_pen),380 + 120,'indicators read the protected referential (route 300, mixed OT A 120)')
  assert.equal(Number((await rpc('dispatch_freight_summary($1)',[route])).referential_pen),300)

  // Verificación de producción C173 sobre este esquema
  await assert.rejects(db.exec(read('supabase/tests/caja_c173_cierre_economico.test.sql')),/CAJA C173 PASS/)
  await db.exec('ROLLBACK').catch(() => {})

  // Sin permisos de lectura no se ve la bandeja.
  await db.exec(`INSERT INTO roles(id,name,permissions) VALUES('${id(90)}','Lector','[]');
   INSERT INTO profiles(id,role_id,first_name) VALUES('${id(91)}','${id(90)}','Lector');
   SELECT set_config('request.jwt.claim.sub','${id(91)}',false);`)
  assert.equal((await rpc(`economic_closure_queue('2026-10-01','2026-10-31')`)).success,false)
  assert.equal((await action('ENVIAR')).success,false)
  console.log('PASS cierre económico: reglas de cobro (fracción, mínimo, jornada), validación con motivo, bloqueo en revisión, envío, observación, aprobación con permiso, impacto en la partida solo por diferencia, reapertura (Etapa 4) e indicadores (Etapa 6)')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
