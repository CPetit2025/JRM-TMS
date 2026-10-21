const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..'), name = `jrm-route-ops-${process.pid}`
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function docker(args, input) { const r = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 180000 }); if (r.error) throw r.error; return r }
function sql(input, fail) { const r = docker(['exec', '-i', name, 'psql', '-U', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], input); if (fail) { assert.notEqual(r.status, 0); assert.match(r.stderr, fail); return } if (r.status) throw Error(r.stderr); return r.stdout.trim().split('\n').at(-1) }
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const actor = `SET request.jwt.claim.sub='${id(1)}'; `
const payload = extra => JSON.stringify({ mode: 'PROPIA', p_driver_id: id(10), p_vehicle_plate: 'JRM-001', p_departure: '2099-01-01T18:00:00-05:00', p_estimated_km: 10, p_freight_cost: 0, p_document_type: 'GR', p_requests: [], auxiliaries: [], ...extra }).replaceAll("'", "''")
const schedule = (extra, fail) => sql(actor + `SELECT schedule_route_resources('${payload(extra)}'::jsonb)`, fail)
async function main() {
 try {
  const start = docker(['run', '-d', '--rm', '--network', 'none', '--name', name, '-e', 'POSTGRES_PASSWORD=isolated-test', 'postgres:16-alpine']); if (start.status) throw Error(start.stderr)
  let ready = false
  for (let i = 0; i < 40; i++) { if (!docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status) { ready = true; break } await new Promise(r => setTimeout(r, 250)) }
  assert.ok(ready, 'PostgreSQL inició con su servidor definitivo')
  sql(read('scripts/fixtures/hhee-schema.sql')); sql(read('scripts/fixtures/route-operations-schema.sql'))
  const notif = read('supabase/migrations/20261004120000_notificaciones_por_rol.sql'), begin = notif.indexOf('CREATE OR REPLACE FUNCTION public.notif_emit(')
  sql(notif.slice(begin, notif.indexOf('END $$;', begin) + 7))
  sql(read('supabase/migrations/20261021160000_route_operations.sql'))
  sql(read('supabase/migrations/20261022100000_supplier_services_forklift.sql'))
  sql(read('supabase/migrations/20261022110000_supplier_fleet_master.sql'))
  sql(`INSERT INTO drivers(id,document_number,license_number,license_category,phone) VALUES('${id(10)}','12345678','LIC-001','A-II','999111222');
   INSERT INTO suppliers(id,business_name,tax_id,category,contact_email) VALUES('${id(11)}','Montacargas Prueba','20123456789','MONTACARGA','proveedor@example.com'),('${id(14)}','Transportes Prueba','20100070970','TRANSPORTE','flota@example.com');
   INSERT INTO hhee_people(id,code,name,document_number) VALUES('${id(12)}','T001','Operador Uno','87654321');
   INSERT INTO supplier_personnel(id,supplier_id,full_name,document_number,position,license_number,license_expiration,phone) VALUES
    ('${id(13)}','${id(11)}','Operador del proveedor','99112233','Montacarguista','MONT-01','2099-01-01','999444555'),
    ('${id(15)}','${id(14)}','Conductor registrado','44556677','Conductor','A-IIIC-77','2099-05-01','999555666');
   INSERT INTO supplier_vehicles(id,supplier_id,personnel_id,plate,unit_type,brand,model) VALUES('${id(16)}','${id(14)}','${id(15)}','ABC-123','TRACTO','Volvo','FH');`)
  assert.equal(sql(`SELECT supplier_id FROM carriers WHERE ruc='20100070970'`),id(14),'transport providers share the company record with the dispatch master')
  sql(`SELECT schedule_route_resources('{}')`, /Sin permiso/)
  const before = sql('SELECT count(*) FROM dispatches')
  schedule({ forklift: { supplier_id: id(90), operator_name: 'Operador' } }, /proveedor activo/)
  schedule({ forklift: { supplier_id: id(11), person_id: id(90), operator_name: 'Operador', hourly_rate: 50 } }, /inactivo o inexistente/)
  schedule({ auxiliaries: [id(90)] }, /Auxiliar inválido/)
  assert.equal(sql('SELECT count(*) FROM dispatches'), before, 'invalid resources roll back the route')
  const route = schedule({ auxiliaries: [id(12)], forklift: { supplier_id: id(11), supplier_personnel_id: id(13), operator_name: 'Nombre falsificado', document_number: 'FALSO', license_number: 'ACR-001', phone: '999222333', hourly_rate: 75 } })
  assert.equal(sql(`SELECT operator_name||'/'||document_number FROM route_forklifts WHERE dispatch_id='${route}'`), 'Operador del proveedor/99112233')
  assert.equal(sql(`SELECT hourly_rate FROM route_forklifts WHERE dispatch_id='${route}'`), '75.00')
  const shares = JSON.parse(sql(actor + `SELECT get_route_share_details(ARRAY['${route}','${route}']::uuid[])`))
  assert.equal(shares.length, 1); assert.equal(shares[0].driver_license, 'LIC-001'); assert.equal(shares[0].auxiliaries.length, 1); assert.equal(shares[0].forklift.license_number, 'MONT-01')
  sql(actor + `SELECT get_route_share_details(ARRAY['${route}','${id(90)}']::uuid[])`, /Sin acceso/)
  sql(`SET ROLE anon; SELECT get_route_share_details(ARRAY['${route}']::uuid[])`, /permission denied/)
  sql(`SET ROLE authenticated; SELECT * FROM route_forklifts`, undefined)
  sql(`INSERT INTO roles(id,name,permissions) VALUES('${id(21)}','Supervisor de Transporte','["torre-control:read"]'),('${id(22)}','Administrador de Contratos','["torre-control:read"]'),('${id(23)}','Gerente General','["torre-control:read"]');
   INSERT INTO profiles(id,role_id,first_name) VALUES('${id(31)}','${id(21)}','Supervisor'),('${id(32)}','${id(22)}','Responsable'),('${id(33)}','${id(22)}','Otra cartera'),('${id(34)}','${id(23)}','Gerencia'),('${id(35)}','${id(21)}','Otra sede');
   INSERT INTO user_site_access SELECT p.id,s.id FROM profiles p CROSS JOIN sites s WHERE p.id IN('${id(31)}','${id(32)}','${id(33)}','${id(34)}');
   INSERT INTO contracts(id,code) VALUES('${id(40)}','OT-TEST'); INSERT INTO contract_user_assignments VALUES('${id(40)}','${id(32)}',true);
   UPDATE dispatches SET contract_id='${id(40)}' WHERE id='${route}';
   INSERT INTO dispatch_events(id,dispatch_id,event_type,description) VALUES('${id(50)}','${route}','EN_RUTA','Salida de prueba');`)
  const recipients = JSON.parse(sql(`SELECT json_agg(target_user ORDER BY target_user) FROM notifications`))
  assert.deepEqual(recipients, [id(1), id(2), id(31), id(32), id(34)])
  sql(`INSERT INTO dispatch_events(dispatch_id,event_type,description,created_at) VALUES('${route}','HISTORICO','No avisar',now()-interval '2 days')`)
  assert.equal(sql('SELECT count(*) FROM notifications'), '5')
  sql(`UPDATE dispatch_events SET description='Salida corregida' WHERE id='${id(50)}'`)
  assert.equal(sql('SELECT count(*) FROM notifications'), '10')
  sql(`UPDATE dispatch_events SET description='Salida corregida' WHERE id='${id(50)}'`)
  assert.equal(sql('SELECT count(*) FROM notifications'), '10', 'unchanged updates do not notify again')
  const missingHours = sql(`SET request.jwt.claim.sub='${id(1)}'; SELECT close_route_with_forklift('${route}','SIN_SALDO',NULL,NULL,NULL,NULL,NULL)->>'error'`)
  assert.match(missingHours, /horas finales/)
  sql(`SET request.jwt.claim.sub='${id(1)}'; SELECT close_route_with_forklift('${route}','SIN_SALDO',NULL,NULL,NULL,NULL,2.5)`)
  assert.equal(sql(`SELECT final_hours||'/'||final_amount FROM route_forklifts WHERE dispatch_id='${route}'`), '2.50/187.50')
  const report = JSON.parse(sql(actor + `SELECT route_forklift_settlement_document('${route}')`))
  assert.equal(report.supplier.email, 'proveedor@example.com'); assert.equal(report.service.amount, 187.5)
  const carrier = sql(`SELECT id FROM carriers WHERE supplier_id='${id(14)}'`)
  const thirdPartyRoute = schedule({ mode: 'TERCERO', p_carrier_id: carrier, p_plate: 'ABC-123', p_conductor: 'Nombre manual', p_telefono: '999333444', p_doc: '11112222',
    p_supplier_personnel_id: id(15), p_supplier_vehicle_id: id(16), forklift: { supplier_id: id(11), operator_name: 'Operador externo', hourly_rate: 65 } })
  assert.equal(sql(`SELECT vehicle_plate||'/'||tercero_conductor||'/'||tercero_license_number FROM dispatches WHERE id='${thirdPartyRoute}'`), 'ABC-123/Conductor registrado/A-IIIC-77')
  const box = docker(['exec', '-i', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], read('supabase/tests/caja_c132_route_operations.test.sql'))
  assert.match(box.stderr, /CAJA C132 PASS/)
  const supplierCosts = docker(['exec', '-i', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], read('supabase/tests/caja_c133_supplier_forklift_costs.test.sql'))
  assert.match(supplierCosts.stderr, /CAJA C133 PASS/)
  console.log('PASS rutas: programación atómica propia/tercero, proveedores y personal, permisos, exportación sin duplicados, destinatarios por sede/cartera y eventos sin duplicados.')
 } finally { docker(['rm', '-f', name]) }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
