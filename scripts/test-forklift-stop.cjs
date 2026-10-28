// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const read = path => readFileSync(path, 'utf8')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
;(async () => {
 const db = new PGlite()
 try {
  await db.exec(read('scripts/fixtures/hhee-schema.sql'))
  await db.exec(read('scripts/fixtures/route-operations-schema.sql'))
  await db.exec(`ALTER TABLE transport_requests ADD COLUMN request_number text, ADD COLUMN delivery_address text;
   ALTER TABLE dispatch_requests ADD FOREIGN KEY(dispatch_id) REFERENCES dispatches(id) ON DELETE CASCADE;
   CREATE UNIQUE INDEX dispatch_one_active_driver ON dispatches(driver_id) WHERE driver_id IS NOT NULL AND status='PROGRAMADO';
   CREATE UNIQUE INDEX dispatch_one_active_vehicle ON dispatches(vehicle_plate) WHERE status='PROGRAMADO';
   CREATE OR REPLACE FUNCTION schedule_dispatch(p_driver_id uuid,p_vehicle_plate text,p_departure timestamptz,p_estimated_km numeric,p_freight_cost numeric,p_contract_id uuid,p_document_type text,p_requests jsonb) RETURNS uuid LANGUAGE plpgsql AS $$DECLARE v uuid;BEGIN
    INSERT INTO dispatches(driver_id,vehicle_plate,scheduled_departure,site_id,contract_id,driver_name) VALUES(p_driver_id,p_vehicle_plate,p_departure,primary_site_id(),p_contract_id,'Conductor Prueba') RETURNING id INTO v;
    INSERT INTO dispatch_requests(dispatch_id,transport_request_id) SELECT v,(j->>'id')::uuid FROM jsonb_array_elements(p_requests) j;
    RETURN v; END$$;
   CREATE FUNCTION notif_emit(text,text,text,text,text,uuid) RETURNS void LANGUAGE sql AS $$SELECT$$;
   SELECT set_config('request.jwt.claim.sub','${id(1)}',false);`)
  for (const path of ['20261021160000_route_operations.sql','20261022100000_supplier_services_forklift.sql','20261022110000_supplier_fleet_master.sql','20261022120000_supplier_fleet_fk_indexes.sql','20261022130000_logistics_supplier_permissions.sql','20261022140000_forklift_service_times_and_logistics_reads.sql']) await db.exec(read('supabase/migrations/'+path))
  await db.exec(`INSERT INTO suppliers(id,business_name,tax_id,category) VALUES('${id(10)}','Montacarga prueba','20123456789','MONTACARGA');
   INSERT INTO contracts(id,code) VALUES('${id(20)}','OT-A'),('${id(21)}','OT-B'),('${id(22)}','OT-C');
   INSERT INTO transport_requests(id,contract_id,request_number,delivery_address) VALUES
    ('${id(30)}','${id(20)}','S-1','Entrega A'),('${id(31)}','${id(21)}','S-2','Entrega B'),('${id(32)}','${id(22)}','S-3','Entrega C'),('${id(33)}','${id(22)}','OTRA','Fuera de ruta');`)
  await db.exec(`INSERT INTO carriers(id,type,business_name,ruc) VALUES('${id(40)}','EXTERNO','Transportista prueba','20100070970');`)
  const scalar = async (sql, params=[]) => (await db.query(sql,params)).rows[0].value
  let sequence = 0
  const payload = (extra={}) => ({ mode:'PROPIA',p_driver_id:null,p_vehicle_plate:`TEST-${++sequence}`,p_departure:'2099-01-01T12:00:00Z',p_estimated_km:10,p_freight_cost:900,p_contract_id:id(20),p_document_type:'GR',auxiliaries:[],p_requests:[{id:id(30)},{id:id(31)},{id:id(32)}],forklift:{supplier_id:id(10),operator_name:'Operador prueba',hourly_rate:'75'},...extra })
  const schedule = p => scalar('SELECT schedule_route_resources($1::jsonb) AS value',[JSON.stringify(p)])
  const historical = await schedule(payload())
  await db.exec(read('supabase/migrations/20261103120000_route_forklift_stop.sql'))
  assert.equal(await scalar('SELECT transport_request_id AS value FROM route_forklifts WHERE dispatch_id=$1',[historical]),null,'never assign historical service silently to the first stop')
  const before = await scalar('SELECT count(*)::int AS value FROM dispatches')
  await assert.rejects(schedule(payload()),/Seleccione la parada/)
  await assert.rejects(schedule(payload({forklift:{supplier_id:id(10),operator_name:'Operador prueba',hourly_rate:75,transport_request_id:id(33)}})),/Seleccione la parada/)
  assert.equal(await scalar('SELECT count(*)::int AS value FROM dispatches'),before,'invalid scope rolls back the whole route')
  const route = await schedule(payload({forklift:{supplier_id:id(10),operator_name:'Operador prueba',hourly_rate:75,transport_request_id:id(31)}}))
  assert.equal(await scalar('SELECT transport_request_id AS value FROM route_forklifts WHERE dispatch_id=$1',[route]),id(31),'single forklift targets second stop, not first OT')
  const shares = await scalar('SELECT get_route_share_details(ARRAY[$1::uuid]) AS value',[route])
  assert.equal(shares[0].forklift.request_number,'S-2')
  assert.equal(shares[0].forklift.destination_address,'Entrega B')
  assert.equal(shares[0].forklift.ot_code,'OT-B')
  const settled = await scalar("SELECT settle_route_forklift_times($1,'2099-01-01T12:00:00Z','2099-01-01T14:00:00Z') AS value",[route])
  assert.equal(settled.amount,150,'only one provider service is charged')
  const report = await scalar('SELECT route_forklift_settlement_document($1) AS value',[route])
  assert.equal(report.stop.id,id(31)); assert.equal(report.stop.ot_code,'OT-B'); assert.equal(report.service.amount,150)
  assert.equal(await scalar('SELECT count(*)::int AS value FROM route_forklifts WHERE dispatch_id=$1',[route]),1,'amount is not duplicated per route stop')
  await assert.rejects(db.query('UPDATE route_forklifts SET transport_request_id=$1 WHERE dispatch_id=$2',[id(33),route]),/no pertenece/)
  await assert.rejects(db.query('DELETE FROM dispatch_requests WHERE dispatch_id=$1 AND transport_request_id=$2',[route,id(31)]),/no se puede retirar/)
  const single = await schedule(payload({p_requests:[{id:id(30)}]}))
  assert.equal(await scalar('SELECT transport_request_id AS value FROM route_forklifts WHERE dispatch_id=$1',[single]),id(30),'single-stop clients remain compatible')
  const unexecuted = await schedule(payload({forklift:{supplier_id:id(10),operator_name:'Operador prueba',hourly_rate:75,transport_request_id:id(31)}}))
  await db.query('DELETE FROM dispatch_requests WHERE dispatch_id=$1 AND transport_request_id=$2',[unexecuted,id(31)])
  assert.equal(await scalar('SELECT count(*)::int AS value FROM route_forklifts WHERE dispatch_id=$1',[unexecuted]),0,'removing a programmed stop cancels only its unexecuted forklift')
  assert.equal(await scalar("SELECT count(*)::int AS value FROM dispatch_events WHERE dispatch_id=$1 AND event_type='MONTACARGA_RETIRADO'",[unexecuted]),1,'withdrawal is audited without publishing costs or personal data')
  const zeroSettled = await schedule(payload({forklift:{supplier_id:id(10),operator_name:'Operador prueba',hourly_rate:75,transport_request_id:id(31)}}))
  await db.query('UPDATE route_forklifts SET final_hours=0,final_amount=0 WHERE dispatch_id=$1',[zeroSettled])
  await assert.rejects(db.query('DELETE FROM dispatch_requests WHERE dispatch_id=$1 AND transport_request_id=$2',[zeroSettled,id(31)]),/no se puede retirar/)
  await db.query("UPDATE dispatches SET status='CANCELADO' WHERE id=$1",[route])
  await db.query('DELETE FROM dispatch_requests WHERE dispatch_id=$1',[route])
  assert.equal(await scalar('SELECT transport_request_id AS value FROM route_forklifts WHERE dispatch_id=$1',[route]),id(31),'whole-route cancellation preserves historical stop and does not block release')
  assert.equal(await scalar('SELECT final_amount AS value FROM route_forklifts WHERE dispatch_id=$1',[route]),'150.00')
  await db.query('DELETE FROM dispatches WHERE id=$1',[single])
  assert.equal(await scalar('SELECT count(*)::int AS value FROM route_forklifts WHERE dispatch_id=$1',[single]),0,'normal route cascade deletion remains possible')
  const noForklift = await schedule(payload({forklift:null}))
  assert.equal(await scalar('SELECT count(*)::int AS value FROM route_forklifts WHERE dispatch_id=$1',[noForklift]),0)
  // El stub de schedule_dispatch_tercero de la fixture delega en el scheduler propio
  // reemplazado arriba: conserva las tres solicitudes reales y registra el transportista.
  const thirdPayload = (extra={}) => {
   const own = payload()
   return { ...own, mode:'TERCERO',p_carrier_id:id(40),p_plate:`EXT-${own.p_vehicle_plate}`,
    p_conductor:'Conductor tercero',p_telefono:'999111222',p_doc:'44556677',
    forklift:{supplier_id:id(10),operator_name:'Operador tercero',hourly_rate:75,transport_request_id:id(31)},...extra }
  }
  const thirdBefore = await scalar('SELECT count(*)::int AS value FROM dispatches')
  await assert.rejects(schedule(thirdPayload({forklift:{supplier_id:id(10),operator_name:'Operador tercero',hourly_rate:75,transport_request_id:id(33)}})),/Seleccione la parada/)
  assert.equal(await scalar('SELECT count(*)::int AS value FROM dispatches'),thirdBefore,'third-party route with a foreign target rolls back atomically')
  const thirdRoute = await schedule(thirdPayload())
  assert.equal(await scalar('SELECT carrier_id AS value FROM dispatches WHERE id=$1',[thirdRoute]),id(40),'TERCERO dispatch branch retains its carrier')
  assert.equal(await scalar('SELECT count(*)::int AS value FROM dispatch_requests WHERE dispatch_id=$1',[thirdRoute]),3,'third-party scheduler retains all three stops')
  assert.equal(await scalar('SELECT transport_request_id AS value FROM route_forklifts WHERE dispatch_id=$1',[thirdRoute]),id(31),'third-party forklift targets the second stop')
  const thirdSettled = await scalar("SELECT settle_route_forklift_times($1,'2099-01-01T12:00:00Z','2099-01-01T14:00:00Z') AS value",[thirdRoute])
  assert.equal(thirdSettled.amount,150)
  const thirdReport = await scalar('SELECT route_forklift_settlement_document($1) AS value',[thirdRoute])
  assert.equal(thirdReport.stop.id,id(31)); assert.equal(thirdReport.stop.number,'S-2')
  assert.equal(thirdReport.stop.destination,'Entrega B'); assert.equal(thirdReport.stop.ot_code,'OT-B')
  assert.equal(thirdReport.service.amount,150)
  assert.equal(await scalar('SELECT count(*)::int AS value FROM route_forklifts WHERE dispatch_id=$1',[thirdRoute]),1,'third-party route has one provider service, not three')
  assert.equal(await scalar('SELECT sum(final_amount) AS value FROM route_forklifts WHERE dispatch_id=$1',[thirdRoute]),'150.00','third-party route retains a single 150 charge on the selected stop')
  const oldReport = await scalar('SELECT route_forklift_settlement_document($1) AS value',[historical])
  assert.equal(oldReport.stop,null)
  assert.equal(await scalar("SELECT has_function_privilege('anon','schedule_route_resources(jsonb)','EXECUTE') AS value"),false)
  assert.equal(await scalar("SELECT has_table_privilege('authenticated','route_forklifts','UPDATE') AS value"),false)
  await assert.rejects(db.exec(read('supabase/tests/caja_c159_forklift_stop.test.sql')),/CAJA C159 PASS/)
  await db.exec('ROLLBACK')
  console.log('PASS: PROPIA/TERCERO 3 stops / second-stop forklift, foreign or missing target rejection with atomic rollback, one amount on its own OT, single-stop compatibility, historical scope, unlink and access guards')
 } finally { await db.close() }
})().catch(error => { console.error(error); process.exitCode=1 })
