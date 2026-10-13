const assert = require('node:assert/strict')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const root = path.resolve(__dirname, '..'), name = `jrm-attention-${process.pid}`
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const read = f => fs.readFileSync(path.join(root,f),'utf8')
function fn(file,name) { const s=read(file),a=s.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`); assert(a>=0,name);return s.slice(a,s.indexOf('END $$;',a)+7) }
function docker(args,input) { const r=spawnSync('docker',args,{input,encoding:'utf8'});if(r.status)throw Error(r.stderr||r.stdout);return r.stdout }
const query = input => spawnSync('docker',['exec','-i',name,'psql','-U','postgres','-At','-v','ON_ERROR_STOP=1'],{input,encoding:'utf8'})
function sql(input) { const r=query(input);if(r.status)throw Error(r.stderr||r.stdout);return r.stdout.trim().split('\n').at(-1) }
const staff = `SET ROLE authenticated; SET request.jwt.claim.sub='${id(2)}'; `
function deny(input,pattern) {const r=query(input);assert.notEqual(r.status,0);assert.match(r.stderr,pattern)}
const json = input => JSON.parse(sql(staff+'SELECT '+input+';'))
function payload(extra={}) {return {department:'OT (Administración de Contratos)',contract_id:id(3),attention_mode:'RECOJO_CLIENTE',request_type:'DESPACHO',required_date:'2099-01-01',cargo_description:'Carga',pickup_address:'Planta',pickup_district:'Chilca',delivery_address:'Destino',delivery_district:'Callao',...extra}}
const lit = value => "'"+JSON.stringify(value).replaceAll("'","''")+"'::jsonb"
const comp = contract => [{contract_id:contract,weight_kg:100,volume_m3:2}]
const save = (p,c=[],u=[],request=null) => json(`public.save_transport_request_attention(${request?"'"+request+"'":'NULL'},${lit(p)},${lit(c)},${lit(u)})`)
try {
 docker(['run','-d','--name',name,'-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:16-alpine'])
 for(let n=0;n<40;n++){if(!spawnSync('docker',['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres']).status)break;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200)}
 sql(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 CREATE TABLE sites(id uuid PRIMARY KEY,name text); INSERT INTO sites VALUES('${id(1)}','Planta');
 CREATE TABLE user_site_access(user_id uuid,site_id uuid); INSERT INTO user_site_access VALUES('${id(2)}','${id(1)}');
 CREATE FUNCTION primary_site_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${id(1)}'::uuid $$;
 CREATE TABLE profiles(id uuid PRIMARY KEY,first_name text,last_name text,is_active boolean,contract_admin boolean DEFAULT false);
 INSERT INTO profiles VALUES('${id(2)}','Solicitud','Prueba',true,false);
 CREATE FUNCTION has_tms_permission(code text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM profiles WHERE id=auth.uid() AND is_active) $$;
 CREATE FUNCTION can_access_site(site uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT site='${id(1)}' $$;
 CREATE FUNCTION is_tms_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
 CREATE FUNCTION is_contract_administrator() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT COALESCE((SELECT contract_admin FROM profiles WHERE id=auth.uid()),false) $$;
 CREATE FUNCTION has_assigned_contract(c uuid,w boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT c IN('${id(3)}','${id(4)}') $$;
 CREATE FUNCTION has_assigned_request(p_request_id uuid,p_write boolean) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
 CREATE TABLE cost_centers(id uuid PRIMARY KEY,code text,name text,is_active boolean); INSERT INTO cost_centers VALUES('${id(5)}','CC-DIST','Logística',true);
 CREATE TABLE contracts(id uuid PRIMARY KEY,code text,type text,status text,parent_contract_id uuid,subcontract_id uuid,site_id uuid,total_weight_kg numeric,total_volume_m3 numeric,destination_address text);
 INSERT INTO contracts VALUES('${id(3)}','16523','CONTRATO','ACTIVO',NULL,NULL,'${id(1)}',10000,10000,'Destino'),('${id(4)}','OT-P','CONTRATO','ACTIVO',NULL,NULL,'${id(1)}',10000,10000,'Destino');
 CREATE TABLE contract_budgets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contract_id uuid,concept text,allocated_pen numeric DEFAULT 0,reserved_pen numeric DEFAULT 0,consumed_pen numeric DEFAULT 0,balance_pen numeric GENERATED ALWAYS AS (allocated_pen-reserved_pen-consumed_pen) STORED,updated_at timestamptz);
 INSERT INTO contract_budgets(contract_id,concept,allocated_pen) VALUES('${id(3)}','PARTIDA_TRANSPORTE',0),('${id(4)}','PARTIDA_TRANSPORTE',1000);
 CREATE SEQUENCE transport_request_number_seq;
 CREATE TABLE transport_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),request_number text UNIQUE,requester_name text,department text,pickup_address text,pickup_department text,pickup_province text,pickup_district text,delivery_address text,delivery_department text,delivery_province text,delivery_district text,required_date date,time_window text,cargo_description text,estimated_weight numeric,estimated_volume numeric,request_type text,contract_id uuid,purchase_order text,service_cost numeric DEFAULT 0,site_id uuid,created_by uuid,status text,budget_shortfall numeric DEFAULT 0,budget_observation text,reserved_pen numeric DEFAULT 0,approved_at timestamptz,approved_by uuid,unloading_estimate_pen numeric DEFAULT 0,unloading_required boolean,cost_breakdown jsonb,cost_source text,cost_override_reason text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
 CREATE TABLE transport_request_components(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),request_id uuid,component_contract_id uuid,requested_weight_kg numeric,requested_volume_m3 numeric);
 CREATE TABLE transport_request_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),request_id uuid,actor_id uuid,action text,previous_state jsonb,next_state jsonb);
 CREATE TABLE drivers(id uuid PRIMARY KEY,first_name text,last_name text,is_active boolean,profile_id uuid);
 INSERT INTO drivers VALUES('${id(6)}','Chofer','Prueba',true,'${id(7)}');
 CREATE TABLE dispatches(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),dispatch_number text,vehicle_plate text,driver_id uuid,driver_name text,scheduled_departure timestamptz,status text,estimated_distance_km numeric,freight_cost numeric,contract_id uuid,docs_required boolean,site_id uuid,modalidad text);
 CREATE UNIQUE INDEX dispatch_one_active_driver ON dispatches(driver_id) WHERE status IN ('PROGRAMADO','EN RUTA');
 CREATE UNIQUE INDEX dispatch_one_active_vehicle ON dispatches(vehicle_plate) WHERE status IN ('PROGRAMADO','EN RUTA') AND vehicle_plate<>'EXTERNO';
 CREATE TABLE dispatch_requests(dispatch_id uuid,transport_request_id uuid,status text,document_type text,document_number text,leg_planned_km numeric,sequence_order int);
 CREATE TABLE contract_services(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contract_id uuid NOT NULL,service_type text,description text,amount_pen numeric,service_date date,plate text,driver_name text,category text,created_by uuid,dispatch_id uuid,provider_name text);
 CREATE TABLE transport_unloading_costs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),transport_request_id uuid,dispatch_id uuid,contract_id uuid NOT NULL,concept text,description text,estimated_pen numeric DEFAULT 0,planned_pen numeric,actual_pen numeric,status text DEFAULT 'ESTIMADO',created_by uuid,planned_by uuid,planned_at timestamptz,consumed_by uuid,consumed_at timestamptz,expense_id uuid,provider_name text,contract_service_id uuid,void_reason text);
 CREATE FUNCTION quote_transport(c uuid,s jsonb,w numeric,vc text,p text,u jsonb) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('freight_total',308,'unloading_total',50*jsonb_array_length(u),'total',308+50*jsonb_array_length(u),'lines',jsonb_build_array(jsonb_build_object('concept','FLETE','unit_rate',308)) || COALESCE((SELECT jsonb_agg(jsonb_build_object('concept',e->>'concept','unit_rate',50)) FROM jsonb_array_elements(u)e),'[]'::jsonb)); $$;
 CREATE FUNCTION unloading_service_type(c text) RETURNS text LANGUAGE sql AS $$ SELECT c $$;
 CREATE FUNCTION unloading_concept_label(c text) RETURNS text LANGUAGE sql AS $$ SELECT c $$;
 CREATE FUNCTION schedule_dispatch_tercero(p_carrier_id uuid,p_plate text,p_conductor text,p_telefono text,p_doc text,p_departure timestamptz,p_estimated_km numeric,p_freight_cost numeric,p_contract_id uuid,p_requests jsonb) RETURNS uuid LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'tercero stub must not be reached in a pickup'; END $$;
 GRANT USAGE ON SCHEMA public,auth TO authenticated; GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;`)
 sql(fn('supabase/migrations/20260929200000_documentario_f3.sql','schedule_dispatch'))
 sql(`INSERT INTO transport_requests(request_number,department,status,contract_id,site_id,service_cost,budget_shortfall,budget_observation,unloading_estimate_pen) VALUES('RT-000006','OT (Administración de Contratos)','OBSERVADA','${id(3)}','${id(1)}',308,308,'Partida insuficiente: faltan S/ 308',0),('RT-HISTORICA','OT (Administración de Contratos)','OBSERVADA','${id(3)}','${id(1)}',308,308,'Partida insuficiente: faltan S/ 308',0);`)
 sql(read('supabase/migrations/20261007140000_request_attention_mode.sql'))
 sql(read('supabase/migrations/20261007150000_request_optional_pickup_details.sql'))
 assert.equal(sql("SELECT attention_mode||'/'||service_cost||'/'||status FROM transport_requests WHERE request_number='RT-000006'"),'RECOJO_CLIENTE/0/PENDIENTE DE APROBACIÓN')
 assert.equal(sql("SELECT count(*) FROM transport_requests WHERE request_number='RT-HISTORICA' AND attention_mode IS NULL AND service_cost=308"),'1')
 console.log('PASS: owner-confirmed RT-000006 is corrected with audit and fresh approval; unrelated historical requests keep their funding.')
 sql(`CREATE TRIGGER request_budget_sync BEFORE UPDATE OF status ON transport_requests FOR EACH ROW EXECUTE FUNCTION transport_request_budget_sync(); CREATE TRIGGER cost_guard BEFORE INSERT OR UPDATE OF service_cost ON transport_requests FOR EACH ROW EXECUTE FUNCTION transport_request_cost_guard();`)
 // Real zero-budget OT: pickup saves atomically without freight even when UI submits a stale quote.
 const pickup=save(payload({service_cost:308}),comp(id(3)))
 assert.equal(pickup.service_cost,0);assert.equal(pickup.quote.total,0);assert.equal(pickup.status,'PENDIENTE DE APROBACIÓN')
 sql(`UPDATE transport_requests SET status='APROBADA' WHERE id='${pickup.id}';`)
 assert.equal(sql(`SELECT reserved_pen FROM transport_requests WHERE id='${pickup.id}'`),'0')
 deny(staff+`SELECT schedule_dispatch('${id(6)}','PLACA',now(),10,0,'${id(3)}','GR',${lit([{id:pickup.id}])});`,/modalidad se define/)
 deny(staff+`SELECT schedule_dispatch(NULL,'EXTERNO',now(),10,308,'${id(3)}','NOTA_SALIDA',${lit([{id:pickup.id}])});`,/flete JRM cero/)
 const dispatch=sql(staff+`SELECT schedule_dispatch(NULL,'EXTERNO',now(),10,0,'${id(3)}','NOTA_SALIDA',${lit([{id:pickup.id}])});`)
 deny(staff+`UPDATE dispatch_requests SET document_type='GR' WHERE dispatch_id='${dispatch}';`,/documento de salida/);
 assert.equal(sql(`SELECT freight_cost||'/'||estimated_distance_km||'/'||driver_name FROM dispatches WHERE id='${dispatch}'`),'0/0/CLIENTE')
 deny(staff+`UPDATE transport_requests SET attention_mode='TRANSPORTE_JRM' WHERE id='${pickup.id}';`,/Retire la solicitud/)
 console.log('PASS: zero-budget pickup has no freight/reserve, inherits Nota de Salida and rejects route-mode override.')
 const costly=save(payload(),comp(id(3)),[{concept:'MONTACARGAS',estimated_pen:50}]);assert.equal(costly.status,'OBSERVADA');assert.equal(costly.unloading_estimate_pen,50);assert.equal(costly.quote.total,50)
 console.log('PASS: customer pickup retains unloading charges and their budget observation.')
 deny(staff+`SELECT save_transport_request_attention(NULL,${lit(payload({contract_id:null}))},'[]','[]');`,/requiere una OT/)
 const generic=save(payload({department:'Logística',contract_id:null,estimated_weight:120,estimated_volume:3}))
 assert.equal(generic.status,'PENDIENTE DE APROBACIÓN');assert.equal(sql(`SELECT estimated_weight FROM transport_requests WHERE id='${generic.id}'`),'120')
 deny(staff+`SELECT save_transport_request_attention(NULL,${lit(payload({department:'Logística',contract_id:null,site_id:id(8)}))},'[]','[]');`,/sede autorizada/)
 sql(`UPDATE profiles SET contract_admin=true WHERE id='${id(2)}';`)
 deny(staff+`SELECT save_transport_request_attention(NULL,${lit(payload({department:'Logística',contract_id:null,site_id:id(1)}))},'[]','[]');`,/requiere una OT/)
 sql(`UPDATE profiles SET contract_admin=false WHERE id='${id(2)}';`)
 console.log('PASS: OT area/contract administrators require OT; other areas save without OT, site/cost-center inputs or pickup contacts; site is internally scoped.')
 const funded=save(payload({contract_id:id(4),attention_mode:'TRANSPORTE_JRM'}),comp(id(4)))
 sql(`UPDATE transport_requests SET status='APROBADA' WHERE id='${funded.id}'`)
 assert.equal(sql(`SELECT reserved_pen FROM contract_budgets WHERE contract_id='${id(4)}'`),'308')
 const edited=save(payload({contract_id:id(4)}),comp(id(4)),[],funded.id)
 assert.equal(edited.status,'PENDIENTE DE APROBACIÓN');assert.equal(sql(`SELECT reserved_pen FROM contract_budgets WHERE contract_id='${id(4)}'`),'0')
 assert.equal(sql(`SELECT count(*) FROM transport_request_events WHERE request_id='${funded.id}' AND next_state->>'attention_mode'='RECOJO_CLIENTE'`),'1')
 console.log('PASS: switching approved transport to pickup releases its reserve, records history and requires fresh approval.')
 const operational=save(payload({department:'Logística',contract_id:null,attention_mode:'TRANSPORTE_JRM',cost_center_id:id(5)}))
 assert.equal(operational.status,'OBSERVADA')
 assert.equal(sql(`SELECT cost_center_id IS NULL FROM transport_requests WHERE id='${operational.id}'`),'t')
 sql(staff+`UPDATE transport_requests SET status='APROBADA' WHERE id='${operational.id}'`)
 assert.equal(sql(`SELECT status||'/'||COALESCE(approved_at::text,'NULL') FROM transport_requests WHERE id='${operational.id}'`),'OBSERVADA/NULL')
 deny(staff+`SELECT schedule_dispatch('${id(6)}','ZZ-A',now(),10,308,NULL,'GR',${lit([{id:operational.id}])});`,/debe imputarse a una OT/)
 deny(staff+`UPDATE transport_requests SET operational_approved_pen=9999 WHERE id='${operational.id}'`,/nueva aprobación/)
 deny(staff+`UPDATE transport_requests SET status='ASIGNADA' WHERE id='${operational.id}'`,/Vincule una OT/)
 const linked=save(payload({department:'Logística',contract_id:id(4),attention_mode:'TRANSPORTE_JRM'}),comp(id(4)),[],operational.id)
 assert.equal(linked.status,'PENDIENTE DE APROBACIÓN')
 sql(staff+`UPDATE transport_requests SET status='APROBADA' WHERE id='${operational.id}'`)
 assert.equal(sql(`SELECT reserved_pen FROM contract_budgets WHERE contract_id='${id(4)}'`),'308')
 const opDispatch=sql(staff+`SELECT schedule_dispatch('${id(6)}','ZZ-A',now(),10,308,'${id(4)}','GR',${lit([{id:operational.id}])});`)
 assert.equal(sql(`SELECT cost_center_id IS NULL FROM dispatches WHERE id='${opDispatch}'`),'t')
 console.log('PASS: other-area JRM requests register without OT/CC; paid approval and scheduling require OT, then reserve/consume its budget.')
 const operationalUnloading=save(payload({department:'Logística',contract_id:null,attention_mode:'RECOJO_CLIENTE'}),[],[{concept:'ESTIBA',estimated_pen:50}])
 assert.equal(operationalUnloading.status,'OBSERVADA')
 sql(staff+`UPDATE transport_requests SET status='APROBADA' WHERE id='${operationalUnloading.id}'`)
 assert.equal(sql(`SELECT status FROM transport_requests WHERE id='${operationalUnloading.id}'`),'OBSERVADA')
 const freePickup=save(payload({department:'Logística',contract_id:null,attention_mode:'RECOJO_CLIENTE'}),[],[],operationalUnloading.id)
 assert.equal(freePickup.status,'PENDIENTE DE APROBACIÓN')
 sql(staff+`UPDATE transport_requests SET status='APROBADA' WHERE id='${freePickup.id}'`)
 const unloadDispatch=sql(staff+`SELECT schedule_dispatch(NULL,'EXTERNO',now(),0,0,NULL,'NOTA_SALIDA',${lit([{id:freePickup.id}])});`)
 assert.equal(json(`plan_dispatch_unloading('${unloadDispatch}',${lit([{request_id:freePickup.id,concept:'ESTIBA',planned_pen:50}])})`).success,false)
 assert.equal(json(`plan_dispatch_unloading('${unloadDispatch}',${lit([{request_id:freePickup.id,concept:'ESTIBA',planned_pen:0}])})`).success,true)
 const zeroLine=sql(`SELECT id FROM transport_unloading_costs WHERE dispatch_id='${unloadDispatch}'`)
 deny(staff+`SELECT register_unloading_actual('${zeroLine}',50,'Proveedor');`,/Vincule una OT/)
 assert.equal(json(`register_unloading_actual('${zeroLine}',0,'Cliente')`).success,true)

 console.log('PASS: pickup without OT/contact/site/CC approves and programs free; extra JRM unloading still requires OT funding.')
 // Default site must remain authorized; fall back to the user scope instead of prompting in the form.
 sql(`CREATE OR REPLACE FUNCTION primary_site_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${id(8)}'::uuid $$;`)
 const fallback=save(payload({department:'Logística',contract_id:null}))
 assert.equal(sql(`SELECT site_id FROM transport_requests WHERE id='${fallback.id}'`),id(1))
 sql(`DELETE FROM user_site_access`)
 deny(staff+`SELECT save_transport_request_attention(NULL,${lit(payload({department:'Logística',contract_id:null}))},'[]','[]');`,/sede autorizada/)
 sql(`CREATE OR REPLACE FUNCTION primary_site_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${id(1)}'::uuid $$;`)
 console.log('PASS: internal default/fallback site respects user access; registration without authorized access is rejected.')
 const count=sql('SELECT count(*) FROM transport_requests')
 deny(staff+`SELECT save_transport_request_attention(NULL,${lit(payload({contract_id:id(4)}))},${lit(comp(id(4)))},${lit([{concept:'INVALIDO'}])});`,/Concepto o monto/)
 assert.equal(sql('SELECT count(*) FROM transport_requests'),count)
 deny(staff+`SELECT schedule_dispatch_attention_legacy(NULL,'EXTERNO',now(),0,0,NULL,'NOTA_SALIDA','[]');`,/permission denied/)
 console.log('PASS: invalid unloading rolls back the complete save; legacy scheduling cannot bypass the new gateway.')
 // Execute the exact production regression against the same realistic schema, always rolled back.
 sql(`CREATE TABLE auth.users(id uuid PRIMARY KEY); INSERT INTO auth.users VALUES('${id(2)}'); CREATE TABLE vehicles(site_id uuid); INSERT INTO vehicles VALUES('${id(1)}'); ALTER TABLE contracts ALTER COLUMN id SET DEFAULT gen_random_uuid(); CREATE OR REPLACE FUNCTION is_tms_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;`)
 // Current request policy supersedes generic no-OT registrations above, while retaining historical coverage.
 sql(`ALTER TABLE contracts ADD COLUMN client_id uuid; ALTER TABLE contracts ADD COLUMN created_by uuid; ALTER TABLE contracts ADD COLUMN destination_department text; ALTER TABLE contracts ADD COLUMN destination_province text; ALTER TABLE contracts ADD COLUMN destination_district text;
 CREATE FUNCTION is_active_tms_user() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM profiles WHERE id=auth.uid() AND is_active) $$;`)
 sql(read('supabase/migrations/20261012020000_request_inline_components.sql'))
 sql(read('supabase/migrations/20261012040000_request_component_native_type.sql'))
 deny(staff+`SELECT save_transport_request_attention(NULL,${lit(payload({department:'Logística',contract_id:null}))},'[]','[]');`,/Seleccione una OT madre/)
 deny(staff+`INSERT INTO transport_requests(request_number,site_id) VALUES('ZZ-UNLINKED','${id(1)}');`,/Seleccione una OT madre/)
 const sub=json(`create_transport_request_component('${id(3)}','SUBCONTRATO','s001')`)
 assert.equal(sub.success,true);assert.equal(sub.code,'16523-S001')
 const errorComponent=json(`create_transport_request_component('${id(3)}','ERROR','e014')`)
 assert.equal(errorComponent.success,true);assert.equal(errorComponent.code,'16523-E014')
 assert.equal(sql(`SELECT count(*) FROM contract_budgets WHERE contract_id IN('${sub.id}','${errorComponent.id}')`),'0')
 assert.equal(json(`create_transport_request_component('${id(3)}','ERROR','E014')`).success,false)
 assert.equal(json(`create_transport_request_component('${id(3)}','ERROR','S014')`).success,false)
 deny(staff+`SELECT create_transport_request_component('${sub.id}','ERROR','E001');`,/OT madre/)
 const family=save(payload({department:'Logística'}),[{contract_id:sub.id},{contract_id:errorComponent.id}])
 assert.equal(sql(`SELECT contract_id FROM transport_requests WHERE id='${family.id}'`),id(3))
 assert.equal(sql(`SELECT count(*) FROM transport_request_components WHERE request_id='${family.id}'`),'2')
 sql(`UPDATE profiles SET is_active=false WHERE id='${id(2)}';`)
 deny(staff+`SELECT create_transport_request_component('${id(3)}','ERROR','E099');`,/Sin permiso/)
 sql(`UPDATE profiles SET is_active=true WHERE id='${id(2)}';`)
 console.log('PASS: all new requests require mother OT; inline variants need no budget, retain mother association and reject duplicates, invalid codes, child parents and inactive profiles.')
 const c45=query(read('supabase/tests/caja_c45_solicitud_recojo_cliente.test.sql'))
 assert.notEqual(c45.status,0); assert.match(c45.stderr,/CAJA C45 PASS \(3\/3\)/)
 console.log('PASS: exact production C45 proves registration without pickup details or site/CC inputs and rolls back intentionally.')
 sql(`UPDATE contracts SET client_id='${id(9)}' WHERE id='${id(3)}';`)
 const c91=query(read('supabase/tests/caja_c91_request_inline_components.test.sql'))
 assert.notEqual(c91.status,0); assert.match(c91.stderr,/CAJA C91 PASS/)
 console.log('PASS: exact production C91 verifies family creation and mandatory mother with rollback.')
 // The real production column is an enum; test the same function with both native shapes.
 sql(`CREATE TYPE public.contract_type AS ENUM('CONTRATO','OT_INDEPENDIENTE','SUBCONTRATO','ERROR');
 ALTER TABLE contracts ALTER COLUMN type TYPE public.contract_type USING type::public.contract_type;`)
 sql(read('supabase/migrations/20261012040000_request_component_native_type.sql'))
 const enumSub=json(`create_transport_request_component('${id(3)}','SUBCONTRATO','S002')`)
 const enumError=json(`create_transport_request_component('${id(3)}','ERROR','E002')`)
 assert.equal(enumSub.success,true);assert.equal(enumError.success,true)
 assert.equal(sql(`SELECT count(*) FROM contracts WHERE id IN('${enumSub.id}','${enumError.id}') AND type IN('SUBCONTRATO','ERROR')`),'2')
 const enumC91=query(read('supabase/tests/caja_c91_request_inline_components.test.sql'))
 assert.notEqual(enumC91.status,0);assert.match(enumC91.stderr,/CAJA C91 PASS/)
 console.log('PASS: inline Subcontrato/Error creation and exact production C91 work with native contract_type enum as well as text.')
 // Corrected service rules: recojo/punto a punto use purchasing references, not mandatory OT.
 sql(`ALTER TABLE transport_requests ADD COLUMN reference_type text; ALTER TABLE transport_requests ADD COLUMN reference_number text;
 ALTER TABLE transport_requests ADD COLUMN supplier_id uuid; ALTER TABLE transport_requests ADD COLUMN supplier_location_id uuid;
 CREATE TABLE suppliers(id uuid PRIMARY KEY,is_active boolean); INSERT INTO suppliers VALUES('${id(11)}',true);
 CREATE TABLE supplier_locations(id uuid PRIMARY KEY,supplier_id uuid);`)
 sql(fn('supabase/migrations/20261009120000_suppliers.sql','apply_request_supplier'))
 sql(fn('supabase/migrations/20261009120000_suppliers.sql','save_transport_request_full'))
 sql('REVOKE ALL ON FUNCTION save_transport_request_full(uuid,jsonb,jsonb,jsonb) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION save_transport_request_full(uuid,jsonb,jsonb,jsonb) TO authenticated; REVOKE ALL ON FUNCTION apply_request_supplier(uuid,jsonb) FROM PUBLIC,anon,authenticated;')
 sql(read('supabase/migrations/20261012130000_request_reference_without_ot.sql'))
 const full=(p,c=[])=>json(`save_transport_request_full(NULL,${lit(p)},${lit(c)},'[]')`)
 for(const kind of ['RECOJO','TRASLADO']) {
   for(const ref of ['OC','OS','RQ']) {
     const operational=full(payload({department:'OT (Administración de Contratos)',contract_id:null,request_type:kind,attention_mode:'TRANSPORTE_JRM',supplier_id:id(11),reference_type:ref,reference_number:'  000123  '}))
     assert.equal(sql(`SELECT contract_id IS NULL AND reference_type='${ref}' AND reference_number='000123' AND supplier_id='${id(11)}' FROM transport_requests WHERE id='${operational.id}'`),'t')
     assert.equal(operational.status,'OBSERVADA') // Payment controls remain authoritative.
   }
   deny(staff+`SELECT save_transport_request_full(NULL,${lit(payload({contract_id:null,request_type:kind,supplier_id:id(11)}))},'[]','[]');`,/Seleccione OC/)
   deny(staff+`SELECT save_transport_request_full(NULL,${lit(payload({contract_id:null,request_type:kind,supplier_id:id(11),reference_type:'OC',reference_number:'  '}))},'[]','[]');`,/Seleccione OC/)
   deny(staff+`SELECT save_transport_request_full(NULL,${lit(payload({contract_id:null,request_type:kind,attention_mode:'TRANSPORTE_JRM',reference_type:'RQ',reference_number:'1'}))},'[]','[]');`,/Seleccione el proveedor/)
 }
 sql(`UPDATE profiles SET contract_admin=true WHERE id='${id(2)}';`)
 const adminRecojo=full(payload({contract_id:null,request_type:'RECOJO',attention_mode:'TRANSPORTE_JRM',supplier_id:id(11),reference_type:'OS',reference_number:'000456'}))
 assert.equal(sql(`SELECT contract_id IS NULL FROM transport_requests WHERE id='${adminRecojo.id}'`),'t')
 assert.equal(sql(staff+`SELECT has_assigned_request('${adminRecojo.id}',true)`),'t')
 sql(`ALTER TABLE transport_requests ENABLE ROW LEVEL SECURITY; CREATE POLICY test_read ON transport_requests FOR SELECT TO authenticated USING(true);`)
 assert.equal(sql(staff+`SELECT count(*) FROM transport_requests WHERE id='${adminRecojo.id}'`),'1')
 sql(`UPDATE transport_requests SET created_by='${id(99)}' WHERE id='${adminRecojo.id}';`)
 assert.equal(sql(staff+`SELECT has_assigned_request('${adminRecojo.id}',false)`),'f')
 assert.equal(sql(staff+`SELECT count(*) FROM transport_requests WHERE id='${adminRecojo.id}'`),'0')
 sql(`UPDATE transport_requests SET created_by='${id(2)}' WHERE id='${adminRecojo.id}'; ALTER TABLE transport_requests DISABLE ROW LEVEL SECURITY;`)

 sql(`UPDATE profiles SET contract_admin=false WHERE id='${id(2)}';`)
 deny(staff+`SELECT save_transport_request_full(NULL,${lit(payload({contract_id:null,request_type:'DESPACHO',reference_type:'OC',reference_number:'1'}))},'[]','[]');`,/Seleccione una OT madre/)
 deny(staff+`INSERT INTO transport_requests(request_number,site_id,request_type,reference_type,reference_number) VALUES('ZZ-BADREF','${id(1)}','RECOJO','OC',' ');`,/Seleccione OC/)
 deny(staff+`UPDATE transport_requests SET reference_number=NULL WHERE id='${adminRecojo.id}'`,/Seleccione OC/)
 deny(staff+`UPDATE transport_requests SET request_type='DESPACHO' WHERE id='${adminRecojo.id}'`,/Seleccione una OT madre/)
 sql(staff+`UPDATE transport_requests SET status='APROBADA' WHERE id='${adminRecojo.id}'`)
 assert.equal(sql(`SELECT status FROM transport_requests WHERE id='${adminRecojo.id}'`),'OBSERVADA')
 console.log('PASS: recojo/punto a punto register without OT using OC/OS/RQ; references, supplier and delivery mother are enforced and paid-approval controls preserved.')
 sql(`ALTER TABLE suppliers ALTER COLUMN id SET DEFAULT gen_random_uuid(); ALTER TABLE suppliers ALTER COLUMN is_active SET DEFAULT true;
 ALTER TABLE suppliers ADD COLUMN tax_id text; ALTER TABLE suppliers ADD COLUMN business_name text;`)
 const c93=query(read('supabase/tests/caja_c93_request_purchasing_reference.test.sql'))
 assert.notEqual(c93.status,0);assert.match(c93.stderr,/CAJA C93 PASS/)
 console.log('PASS: exact C93 verifies OC/OS/RQ no-OT registration, purchasing references, supplier and rollback.')





 // Financial lifecycle against the real approval/scheduling functions with native enums.
 sql(`ALTER TABLE contract_services ADD COLUMN provider_ruc text; ALTER TABLE contract_services ADD COLUMN status text;
 ALTER TABLE dispatches ADD COLUMN carrier_id uuid; ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS cost_center_id uuid;
 CREATE TABLE carriers(id uuid PRIMARY KEY,tax_id text,business_name text);
 CREATE TABLE dispatch_request_freight(dispatch_id uuid,request_id uuid,contract_id uuid,amount_pen numeric,service_id uuid,status text DEFAULT 'RESERVADO',PRIMARY KEY(dispatch_id,request_id));
 CREATE TABLE dispatch_events(dispatch_id uuid,event_type text,description text,created_by text);
 CREATE TABLE delivery_conformities(dispatch_id uuid,request_id uuid,state text);
 CREATE FUNCTION delivery_required(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
 CREATE FUNCTION has_tms_read_permission(text) RETURNS boolean LANGUAGE sql AS $$ SELECT has_tms_permission($1) $$;`)
 function native(file,name) {const source=read(file);const re=new RegExp('CREATE(?: OR REPLACE)? FUNCTION public\\.'+name+'\\(');const start=source.search(re);assert(start>=0,name);return source.slice(start,source.indexOf('END $$;',start)+7).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION')}
 const mixed='supabase/migrations/20261007200000_mixed_routes_operating_budget.sql'
 for(const name of ['transport_request_budget_sync','validate_mixed_dispatch','reserve_mixed_dispatch','settle_mixed_dispatch_freight','schedule_dispatch','schedule_dispatch_tercero','plan_dispatch_unloading']) sql(native(mixed,name))
 sql(native('supabase/migrations/20261007150000_request_optional_pickup_details.sql','set_transport_request_status'))
 sql(native('supabase/migrations/20261007140000_request_attention_mode.sql','register_unloading_actual'))
 sql(native('supabase/migrations/20261011060000_active_route_add_service.sql','add_active_route_service'))
 for(const name of ['get_dispatch_freight_reconciliation_queue','reconcile_dispatch_freight']) sql(native('supabase/migrations/20261009030000_service_registry.sql',name))
 sql(`CREATE FUNCTION plan_dispatch_unloading_single_ot(uuid,jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
`)
 sql(read('supabase/migrations/20261012140000_reference_transport_finance.sql'))
 const pay=full(payload({contract_id:null,request_type:'RECOJO',attention_mode:'TRANSPORTE_JRM',supplier_id:id(11),reference_type:'OC',reference_number:'0042'}))
 assert.equal(pay.status,'PENDIENTE DE APROBACIÓN')
 deny(staff+`SELECT approve_reference_transport_request('${pay.id}',309,'OC','0042');`,/costo o el sustento cambió/)
 sql(staff+`SELECT approve_reference_transport_request('${pay.id}',308,'OC','0042');`)
 assert.equal(sql(`SELECT status||'/'||operational_approved_pen||'/'||reserved_pen FROM transport_requests WHERE id='${pay.id}'`),'APROBADA/308/0')
 sql(`INSERT INTO transport_unloading_costs(transport_request_id,contract_id,concept,estimated_pen,status) VALUES('${pay.id}',NULL,'ESTIBA',0,'ESTIMADO');`)
 const requests=[{id:pay.id,freight_share_pen:258}]
 const countServices=sql('SELECT count(*) FROM contract_services')
 const budgetBefore=sql('SELECT sum(reserved_pen)+sum(consumed_pen) FROM contract_budgets')
 // Isolate the already-assigned test driver from previous harness routes.
 sql(`UPDATE dispatches SET status='CANCELADO';`)
 const route=sql(staff+`SELECT schedule_dispatch('${id(6)}','REF-001','2099-01-01T10:00:00-05:00',12,258,NULL,'GR',${lit(requests)});`)
 assert.equal(sql(`SELECT status FROM transport_requests WHERE id='${pay.id}'`),'ASIGNADA')
 assert.equal(sql(`SELECT amount_pen||'/'||reference_type||'/'||reference_number||'/'||status FROM dispatch_request_freight WHERE dispatch_id='${route}'`),'258/OC/0042/RESERVADO')
 assert.equal(sql('SELECT count(*) FROM contract_services'),countServices)
 assert.equal(sql('SELECT sum(reserved_pen)+sum(consumed_pen) FROM contract_budgets'),budgetBefore)
 const over=json(`plan_dispatch_unloading('${route}',${lit([{request_id:pay.id,concept:'ESTIBA',planned_pen:51}])})`)
 assert.equal(over.success,false)
 assert.equal(json(`plan_dispatch_unloading('${route}',${lit([{request_id:pay.id,concept:'ESTIBA',planned_pen:50}])})`).success,true)
 const line=sql(`SELECT id FROM transport_unloading_costs WHERE dispatch_id='${route}' AND planned_pen=50`)
 deny(staff+`SELECT register_unloading_actual('${line}',51,'Proveedor');`,/importe aprobado/)
 assert.equal(json(`register_unloading_actual('${line}',50,'Proveedor')`).success,true)
 sql(`SELECT settle_mixed_dispatch_freight('${route}',true); UPDATE dispatch_requests SET status='ENTREGADO' WHERE dispatch_id='${route}'; UPDATE dispatches SET status='LIQUIDADO' WHERE id='${route}';`)
 const registry=json(`get_reference_service_registry(NULL,NULL)`)
 assert.equal(registry.filter(x=>x.dispatch_id===route).length,2)
 assert.ok(registry.filter(x=>x.dispatch_id===route).every(x=>x.stage==='REALIZADO'&&x.reference_number==='0042'))
 deny(staff+`UPDATE transport_requests SET reference_number='0043' WHERE id='${pay.id}'`,/Retire la solicitud/)
 sql(`INSERT INTO user_site_access VALUES('${id(2)}','${id(1)}');`);

 sql(`CREATE OR REPLACE FUNCTION has_tms_permission(code text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT EXISTS(SELECT 1 FROM profiles WHERE id=auth.uid() AND is_active) AND (code<>'despacho-aprobacion' OR current_setting('test.supervisor',true) IS DISTINCT FROM 'off') $$;`)
 const capRequest=full(payload({contract_id:null,request_type:'TRASLADO',attention_mode:'TRANSPORTE_JRM',supplier_id:id(11),reference_type:'OS',reference_number:'0044'}))
 deny(staff+`SET test.supervisor='off'; SELECT approve_reference_transport_request('${capRequest.id}',308,'OS','0044');`,/Solo el Supervisor/)
 sql(staff+`SELECT approve_reference_transport_request('${capRequest.id}',308,'OS','0044');`)
 sql(staff+`UPDATE transport_requests SET reference_number='0045' WHERE id='${capRequest.id}';`)
 assert.equal(sql(`SELECT status||'/'||operational_approved_pen FROM transport_requests WHERE id='${capRequest.id}'`),'PENDIENTE DE APROBACIÓN/0')
 sql(staff+`SELECT approve_reference_transport_request('${capRequest.id}',308,'OS','0045');`)
 const cancelled=sql(staff+`SELECT schedule_dispatch('${id(6)}','REF-002','2099-01-01T10:00:00-05:00',12,308,NULL,'GR',${lit([{id:capRequest.id,freight_share_pen:308}])});`)
 sql(native(mixed,'release_mixed_stop_freight'))
 sql(`CREATE TRIGGER release_stop AFTER DELETE ON dispatch_requests FOR EACH ROW EXECUTE FUNCTION release_mixed_stop_freight();`)
 sql(native(mixed,'dispatch_release_on_cancel'))
 sql(staff+`SET test.supervisor='off'; UPDATE dispatches SET status='CANCELADO' WHERE id='${cancelled}'; SELECT dispatch_release_on_cancel('${cancelled}','prueba');`)
 assert.equal(sql(`SELECT status||'/'||operational_approved_pen FROM transport_requests WHERE id='${capRequest.id}'`),'APROBADA/308')
 assert.equal(sql(`SELECT status FROM dispatch_request_freight WHERE dispatch_id='${cancelled}'`),'LIBERADO')
 sql(staff+`SELECT set_transport_request_status('${capRequest.id}','REPROGRAMADA','2099-01-02');`)
 const rescheduled=sql(staff+`SELECT schedule_dispatch('${id(6)}','REF-003','2099-01-02T10:00:00-05:00',12,308,NULL,'GR',${lit([{id:capRequest.id,freight_share_pen:308}])});`)
 assert.equal(sql(`SELECT status FROM dispatch_request_freight WHERE dispatch_id='${rescheduled}'`),'RESERVADO')
 sql(staff+`UPDATE dispatches SET status='CANCELADO' WHERE id='${rescheduled}'; SELECT dispatch_release_on_cancel('${rescheduled}','prueba'); UPDATE transport_requests SET status='OBSERVADA',budget_observation='Proveedor observado: revisión manual' WHERE id='${capRequest.id}';`)
 assert.equal(sql(`SELECT status||'/'||budget_observation FROM transport_requests WHERE id='${capRequest.id}'`),'OBSERVADA/Proveedor observado: revisión manual')
 console.log('PASS: non-supervisor cannot approve, reference edits invalidate approval, cancellation releases costs, reprogramming preserves authorized cap and manual observations remain intact.')

 const c94=query(read('supabase/tests/caja_c94_reference_transport_finance.test.sql')); assert.notEqual(c94.status,0); assert.match(c94.stderr,/CAJA C94 PASS/);
 console.log('PASS: exact C94 runs approval, immutable reference, combined and cross-dispatch cap plus contract ledger isolation.');
 console.log('PASS: paid OC request approves, schedules and consumes freight + unloading within a supervisor cap; native enums, immutable reference, no fake OT and registry visibility.')

 // C63 must exercise a synthetic pending request, never mutate a real assigned service.
 // Expand the minimal supplier fixtures to the deployed schema, then install its exact RLS,
 // private supplier RPC and deferred invariants before running the production regression.
 sql(`ALTER TABLE suppliers ADD COLUMN category text NOT NULL DEFAULT 'MATERIA_PRIMA';
 ALTER TABLE suppliers ADD COLUMN contact_name text; ALTER TABLE suppliers ADD COLUMN contact_phone text;
 ALTER TABLE suppliers ADD COLUMN contact_email text; ALTER TABLE suppliers ADD COLUMN notes text;
 ALTER TABLE suppliers ADD COLUMN created_by uuid DEFAULT auth.uid();
 ALTER TABLE suppliers ADD COLUMN created_at timestamptz DEFAULT now(); ALTER TABLE suppliers ADD COLUMN updated_at timestamptz DEFAULT now();
 UPDATE suppliers SET tax_id='20999999999',business_name='Proveedor financiero de prueba' WHERE tax_id IS NULL;
 ALTER TABLE suppliers ALTER COLUMN tax_id SET NOT NULL; ALTER TABLE suppliers ALTER COLUMN business_name SET NOT NULL;
 ALTER TABLE suppliers ADD CONSTRAINT suppliers_tax_id_format CHECK (tax_id ~ '^[0-9]{11}$');
 ALTER TABLE suppliers ADD CONSTRAINT suppliers_name_present CHECK (btrim(business_name)<>'');
 ALTER TABLE supplier_locations ALTER COLUMN id SET DEFAULT gen_random_uuid();
 ALTER TABLE supplier_locations ADD COLUMN name text NOT NULL; ALTER TABLE supplier_locations ADD COLUMN address text NOT NULL;
 ALTER TABLE supplier_locations ADD COLUMN department text; ALTER TABLE supplier_locations ADD COLUMN province text;
 ALTER TABLE supplier_locations ADD COLUMN district text; ALTER TABLE supplier_locations ADD COLUMN contact_name text;
 ALTER TABLE supplier_locations ADD COLUMN contact_phone text; ALTER TABLE supplier_locations ADD COLUMN is_active boolean DEFAULT true;
 ALTER TABLE supplier_locations ADD COLUMN created_at timestamptz DEFAULT now();
 ALTER TABLE supplier_locations ADD CONSTRAINT supplier_locations_present CHECK (btrim(name)<>'' AND btrim(address)<>'');
 CREATE FUNCTION can_view_driver_evidence() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;`)
 sql(read('supabase/migrations/20261009120000_suppliers.sql'))
 const c63=query(read('supabase/tests/caja_c63_proveedores.test.sql'))
 assert.notEqual(c63.status,0);assert.match(c63.stderr,/CAJA C63 PASS \(7\/7\)/)
 assert.equal(sql(`SELECT reference_number FROM transport_requests WHERE id='${pay.id}'`),'0042')
 deny(staff+`UPDATE transport_requests SET reference_number='0043' WHERE id='${pay.id}'`,/Retire la solicitud/)
 console.log('PASS: exact production C63 (7/7) uses a pending synthetic supplier fixture and leaves assigned references immutable after finance changes.')


 // Own-fleet pickup regression: actual active-route context and daily-cutoff gateway.
 sql(`ALTER TABLE transport_requests ADD COLUMN client_id uuid;
 ALTER TABLE dispatches ALTER COLUMN modalidad SET DEFAULT 'PROPIA'; UPDATE dispatches SET modalidad='PROPIA' WHERE modalidad IS NULL;
 ALTER TABLE delivery_conformities ADD COLUMN arrived_at timestamptz; ALTER TABLE delivery_conformities ADD PRIMARY KEY(dispatch_id,request_id);
 ALTER TABLE vehicles ADD COLUMN id uuid PRIMARY KEY DEFAULT gen_random_uuid(); ALTER TABLE vehicles ADD COLUMN plate text; ALTER TABLE vehicles ADD COLUMN weight_capacity numeric;
 CREATE TABLE route_track_points(dispatch_id uuid,leg_order int);
 CREATE TABLE notifications(evento text,categoria text,severidad text,titulo text,cuerpo text,link text,permisos text[],target_user uuid,dedupe_key text);
 CREATE TABLE dispatch_service_additions(operation_id uuid PRIMARY KEY,dispatch_id uuid,request_id uuid,created_by uuid,created_at timestamptz,reason text,expected_at timestamptz,available_kg numeric,cargo_kg numeric,extra_km numeric,result jsonb);
 CREATE FUNCTION delivery_can_review(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;`)
 sql(native('supabase/migrations/20261011010000_cliente_proveedor_obligatorio.sql','request_party_missing'))
 for(const [file,name] of [['supabase/migrations/20260922100000_contract_portfolio_security.sql','contract_root_id'],['supabase/migrations/20261010060000_transport_family_budget.sql','contract_budget_owner']]) {
   const source=read(file), start=source.indexOf('CREATE OR REPLACE FUNCTION public.'+name+'('); assert(start>=0,name);sql(source.slice(start,source.indexOf('$$;',start)+3))
 }
 sql(native('supabase/migrations/20261011060000_active_route_add_service.sql','active_route_context'))
 sql('ALTER FUNCTION active_route_context(uuid) RENAME TO active_route_context_before_daily_cutoff;')
 const daily=read('supabase/migrations/20261011110000_daily_route_cutoff.sql');
 for(const name of ['dispatch_operating_day','dispatch_cutoff_at']) {const at=daily.indexOf('CREATE FUNCTION public.'+name+'(');sql(daily.slice(at,daily.indexOf('$$;',at)+3))}
 sql(native('supabase/migrations/20261011110000_daily_route_cutoff.sql','active_route_context'))
 const additionAt=daily.indexOf('DO $addition$');sql(daily.slice(additionAt,daily.indexOf('END $addition$;',additionAt)+15))
 sql(read('supabase/migrations/20261012150000_route_service_peso_hora.sql'))
 const pendingAutoPickup=full(payload({contract_id:null,request_type:'RECOJO',attention_mode:'TRANSPORTE_JRM',supplier_id:id(11),reference_type:'OC',reference_number:'HIST-AUTO'}))
 const pendingManualPickup=full(payload({contract_id:null,request_type:'RECOJO',attention_mode:'TRANSPORTE_JRM',supplier_id:id(11),reference_type:'OS',reference_number:'HIST-MANUAL'}))
 sql(staff+`SET tms.tariff_apply='on'; UPDATE transport_requests SET service_cost=77,cost_source='MANUAL',cost_override_reason='Costo real registrado' WHERE id='${pendingManualPickup.id}';`)
 sql(read('supabase/migrations/20261013180000_own_fleet_pickup_documentation.sql'))
 assert.equal(sql(`SELECT service_cost||'/'||status FROM transport_requests WHERE id='${pendingAutoPickup.id}'`),'0/PENDIENTE DE APROBACIÓN')
 assert.equal(sql(`SELECT service_cost||'/'||cost_source FROM transport_requests WHERE id='${pendingManualPickup.id}'`),'77/MANUAL')
 assert.equal(sql(`SELECT service_cost FROM transport_requests WHERE id='${pay.id}'`),'308')
 console.log('PASS: pending automatic pickup quote is repaired; manual pickup cost and already-assigned financial history remain untouched.')
 const c99=query(read('supabase/tests/caja_c99_own_fleet_pickup.test.sql')); assert.notEqual(c99.status,0); assert.match(c99.stderr,/CAJA C99 PASS/)
 console.log('PASS: exact production C99 documents own pickups without freight/km; capacity, day, retry and explicit third-party quote remain enforced.')
 const updatedC94=query(read('supabase/tests/caja_c94_reference_transport_finance.test.sql')); assert.notEqual(updatedC94.status,0); assert.match(updatedC94.stderr,/CAJA C94 PASS/)
 console.log('PASS: exact C94 financial lifecycle remains valid after own-pickup tariff normalization.')
 const ownPickup=full(payload({contract_id:null,request_type:'RECOJO',attention_mode:'TRANSPORTE_JRM',supplier_id:id(11),reference_type:'OC',reference_number:'OWN-001'}))
 assert.equal(ownPickup.service_cost,0);assert.equal(ownPickup.quote.freight_total,0)
 sql(staff+`SELECT approve_reference_transport_request('${ownPickup.id}',0,'OC','OWN-001'); UPDATE dispatches SET status='CANCELADO';`)
 const ownRoute=sql(staff+`SELECT schedule_dispatch('${id(6)}','OWN-001','2099-01-01T10:00:00-05:00',99,308,NULL,'GR',${lit([{id:ownPickup.id,freight_share_pen:308}])});`)
 assert.equal(sql(`SELECT freight_cost||'/'||estimated_distance_km FROM dispatches WHERE id='${ownRoute}'`),'0/0')
 assert.equal(sql(`SELECT amount_pen FROM dispatch_request_freight WHERE dispatch_id='${ownRoute}'`),'0')
 // Same-OT pickup + delivery must create a ledger per stop without lending pickup cost to the delivery.
 const ownOtPickup=full(payload({contract_id:id(4),request_type:'RECOJO',attention_mode:'TRANSPORTE_JRM',supplier_id:id(11),reference_type:'OS',reference_number:'OWN-OT'}),comp(id(4)))
 const ownDelivery=full(payload({contract_id:id(4),request_type:'DESPACHO',attention_mode:'TRANSPORTE_JRM'}),comp(id(4)))
 sql(staff+`UPDATE transport_requests SET status='APROBADA' WHERE id IN('${ownOtPickup.id}','${ownDelivery.id}'); UPDATE dispatches SET status='CANCELADO';`)
 const mix=[{id:ownOtPickup.id,freight_share_pen:308},{id:ownDelivery.id,freight_share_pen:308}]
 const mixRoute=sql(staff+`SELECT schedule_dispatch('${id(6)}','OWN-MIX','2099-01-01T10:00:00-05:00',20,616,'${id(4)}','GR',${lit(mix)});`)
 assert.equal(sql(`SELECT freight_cost||'/'||estimated_distance_km FROM dispatches WHERE id='${mixRoute}'`),'308/20')
 assert.equal(sql(`SELECT amount_pen FROM dispatch_request_freight WHERE dispatch_id='${mixRoute}' AND request_id='${ownOtPickup.id}'`),'0')
 assert.equal(sql(`SELECT amount_pen FROM dispatch_request_freight WHERE dispatch_id='${mixRoute}' AND request_id='${ownDelivery.id}'`),'308')
 console.log('PASS: own pickup schedule ignores stale freight/km; same-OT mixed route retains delivery freight and independent zero-cost pickup ledger.')


} finally {spawnSync('docker',['rm','-f',name],{stdio:'ignore'})}
