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
 CREATE FUNCTION has_assigned_contract(c uuid,w boolean) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT c IN('${id(3)}','${id(4)}') $$;
 CREATE FUNCTION has_assigned_request(r uuid,w boolean) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
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
 const c45=query(read('supabase/tests/caja_c45_solicitud_recojo_cliente.test.sql'))
 assert.notEqual(c45.status,0); assert.match(c45.stderr,/CAJA C45 PASS \(3\/3\)/)
 console.log('PASS: exact production C45 proves registration without pickup details or site/CC inputs and rolls back intentionally.')

} finally {spawnSync('docker',['rm','-f',name],{stdio:'ignore'})}
