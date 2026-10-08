const {readFileSync,writeFileSync}=require('node:fs'),{spawnSync}=require('node:child_process'),path=require('node:path'),assert=require('node:assert/strict')
const root=path.resolve(__dirname,'..'),name=`jrm-apt-gantt-${process.pid}`,read=f=>readFileSync(path.join(root,f),'utf8')
function run(args,input){const r=spawnSync('docker',args,{input,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr||r.stdout);return r.stdout}
const sql=input=>run(['exec','-i',name,'psql','-U','postgres','-v','ON_ERROR_STOP=1'],input)
const json=input=>JSON.parse(run(['exec','-i',name,'psql','-U','postgres','-qtA','-v','ON_ERROR_STOP=1'],input).trim())
const fn=(source,name)=>{const i=source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);assert.ok(i>=0,name);return source.slice(i,source.indexOf('$$;',i)+3)}
try{
 run(['run','-d','--name',name,'-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:16-alpine'])
 let ready=false;for(let n=0;n<40;n++){if(spawnSync('docker',['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres']).status===0){ready=true;break}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200)}assert.ok(ready)
 const shape=read('scripts/security/production-shape.sql'),family=read('supabase/migrations/20261003160000_apt_familia_ot.sql')
 const table=n=>{const start=shape.indexOf(`CREATE TABLE public."${n}" (`);assert.ok(start>=0);return shape.slice(start,shape.indexOf(';',start)+1)}
 sql(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE FUNCTION apt_can_view() RETURNS boolean LANGUAGE sql AS $$SELECT COALESCE(current_setting('test.can_view',true),'true')='true'$$;`+
 ['apt_flow_layers','apt_flow_exits','apt_flow_alloc','apt_flow_pieces','apt_flow_state','apt_settings','apt_movements','apt_uploads'].map(table).join('\n')+fn(family,'apt_ot_raiz'))
 const migration=read('supabase/migrations/20261009150000_apt_gantt.sql');sql(migration);sql(migration)
 sql(`INSERT INTO apt_settings(id,alert_days,tolerance) VALUES(1,7,0.02);
 INSERT INTO apt_flow_state(id,cutoff,data_min,rebuilt_at) VALUES(1,'2026-01-20','2026-01-01',now());
 INSERT INTO apt_flow_layers(id,almacen,lote,producto,tipo,fecha,kg_in,kg_out,kg_saldo,cliente,exit_id,lote_origen) VALUES
 (1,'647','16544','P','PRODUCCION','2026-01-01',20000,20000,0,'Test',NULL,NULL),
 (2,'ST','16544','P','TRASPASO','2026-01-10',20000,15000,5000,'Test',10,'16544'),
 (3,'540','16544-S001','P','INICIAL',NULL,3000,0,3000,'Test',NULL,NULL),
 (4,'647','16545','P','PRODUCCION','2026-01-18',10000,0,10000,'Other',NULL,NULL),
 (5,'647','16546','P','PRODUCCION','2026-01-01',1000,1000,0,'Third',NULL,NULL);
 INSERT INTO apt_flow_exits(id,almacen,lote,producto,tipo,fecha,kg,documento,lote_destino) VALUES
 (10,'647','16544','P','TRASPASO','2026-01-10',20000,'T1','16544'),
 (11,'ST','16544','P','DESPACHO','2026-01-12',7000,'G1',NULL),
 (12,'ST','16544','P','DESPACHO','2026-01-18',8000,'G2',NULL),
 (13,'647','16546','P','CONSUMO','2026-01-05',1000,'C1',NULL);
 INSERT INTO apt_flow_alloc(layer_id,exit_id,kg) VALUES(1,10,20000),(2,11,7000),(2,12,8000),(5,13,1000);
 INSERT INTO apt_flow_pieces(id,es_saldo,layer_id,root_id,almacen,lote,producto,fecha_origen,kg) VALUES
 (1,true,2,1,'ST','16544','P','2026-01-01',5000),(2,true,3,3,'540','16544-S001','P',NULL,3000),(3,true,4,4,'647','16545','P','2026-01-18',10000);
 INSERT INTO apt_movements(id,kind,active,valid,fecha,lote,peso_kg,fecha_entrega) VALUES
 (1,'ENTRADA',true,true,'2026-01-01','16544',20000,'2026-01-12'),(2,'SALIDA',true,true,'2026-01-18','16544',8000,NULL);`)
 const now=json("SELECT apt_gantt('{}')");writeFileSync('/tmp/jrm-gantt-result.json',JSON.stringify(now))
 assert.equal(now.kpis.ingresadas_tn,31);assert.equal(now.kpis.saldo_tn,18);assert.equal(now.kpis.despachadas_tn,15)
 assert.equal(now.kpis.criticas_tn,5);assert.equal(now.kpis.sin_fecha_tn,3);assert.equal(now.age_basis,'ORIGEN')
 const lot=now.filas.find(r=>r.lote==='16544');assert.equal(lot.ingresadas_tn,20);assert.equal(lot.estado,'PARCIAL');assert.equal(lot.edad_ponderada,19);assert.equal(lot.fecha_entrega_min,'2026-01-12');assert.equal(lot.segmentos.length,2)
 const past=json(`SELECT apt_gantt('{"corte":"2026-01-05","lote_exacto":"16544"}')`)
 assert.equal(past.kpis.saldo_tn,20);assert.equal(past.filas[0].segmentos.length,1);assert.equal(past.filas[0].segmentos[0].almacen,'647');assert.equal(past.filas[0].edad_ponderada,4);assert.equal(past.age_basis,'ALMACEN')
 const partial=json(`SELECT apt_gantt('{"corte":"2026-01-15","desde":"2026-01-14","lote_exacto":"16544"}')`)
 assert.equal(partial.kpis.saldo_tn,13);assert.equal(partial.kpis.ingresadas_tn,20);assert.equal(partial.serie[0].saldo_tn,13)
 assert.equal(json(`SELECT apt_gantt('{"ot":"16544"}',1,0)`).total,2)
 assert.equal(json(`SELECT apt_gantt('{"solo_criticos":true}')`).total,1)
 assert.equal(json(`SELECT apt_gantt('{"estado":"SALIDA_NO_ENTREGA"}')`).filas[0].lote,'16546')
 assert.equal(json(`SELECT apt_gantt('{"corte":"2027-01-01"}')`).cutoff,'2026-01-20')
 assert.equal(json(`SELECT apt_gantt('{"corte":"bad"}')`).success,false)
 assert.equal(json(`SET test.can_view='false';SELECT apt_gantt('{}')`).success,false)
 sql(`DO $$ BEGIN IF has_function_privilege('anon','apt_gantt(jsonb,integer,integer)','EXECUTE') THEN RAISE EXCEPTION 'anon access';END IF;END $$;`)
 // A replacement on identical ERP dates can invalidate the model without advancing data_max.
 sql(`BEGIN;
 INSERT INTO apt_uploads(id,file_name,status,applied_at) VALUES
 ('22222222-2222-2222-2222-222222222222','same-date replacement','APLICADA',(SELECT rebuilt_at+interval '1 minute' FROM apt_flow_state WHERE id=1)),
 ('33333333-3333-3333-3333-333333333333','discarded upload','DESCARTADA',(SELECT rebuilt_at+interval '2 minutes' FROM apt_flow_state WHERE id=1));
 DO $$ DECLARE q jsonb; prior timestamptz; BEGIN
 SELECT rebuilt_at INTO prior FROM apt_flow_state WHERE id=1;
 q:=apt_gantt('{}');
 IF (q->>'model_pending')::boolean IS DISTINCT FROM true OR (q->>'last_upload_at')::timestamptz<>prior+interval '1 minute'
  OR (q->>'data_max')::date>(q->>'model_cutoff')::date THEN RAISE EXCEPTION 'Same-date applied upload must flag pending model without a new movement date'; END IF;
 UPDATE apt_uploads SET applied_at=prior-interval '1 minute' WHERE status='APLICADA';
 q:=apt_gantt('{}');
 IF (q->>'model_pending')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'Backdated applied upload must clear pending model; discarded uploads are ignored'; END IF;
 UPDATE apt_flow_state SET cutoff=NULL,rebuilt_at=NULL WHERE id=1;
 q:=apt_gantt('{}');
 IF (q->>'vacio')::boolean IS DISTINCT FROM true OR (q->>'model_pending')::boolean IS DISTINCT FROM true
  OR q->>'last_upload_at' IS NULL THEN RAISE EXCEPTION 'Empty model must expose pending applied upload metadata'; END IF;
 END $$;
 ROLLBACK;`)
 // Isolated lifecycle cases: rolled back so the main fixture and load totals remain stable.
 sql(`BEGIN;
 INSERT INTO apt_flow_layers(id,almacen,lote,producto,tipo,fecha,kg_in,kg_out,kg_saldo,cliente,exit_id,lote_origen) VALUES
 (101,'647','16544 D','P','DEVOLUCION','2026-01-19',2000,0,2000,'Test',NULL,NULL),
 (102,'647','99010','P','PRODUCCION','2026-01-04',6000,3000,3000,'Reassigned',NULL,NULL),
 (103,'ST','99011','P','TRASPASO','2026-01-19',3000,0,3000,'Reassigned',110,'99010'),
 (104,'647','99012','P','PRODUCCION','2026-01-01',10000,9900,100,'Residual',NULL,NULL);
 INSERT INTO apt_flow_exits(id,almacen,lote,producto,tipo,fecha,kg,documento,lote_destino) VALUES
 (110,'647','99010','P','TRASPASO','2026-01-19',3000,'REASSIGN-1','99011'),
 (111,'647','99012','P','DESPACHO','2026-01-19',9900,'RESIDUAL-GUIDE',NULL);
 INSERT INTO apt_flow_alloc(layer_id,exit_id,kg) VALUES(102,110,3000),(104,111,9900);
 INSERT INTO apt_flow_pieces(id,es_saldo,layer_id,root_id,almacen,lote,producto,fecha_origen,kg) VALUES
 (101,true,101,101,'647','16544 D','P','2026-01-19',2000),
 (102,true,102,102,'647','99010','P','2026-01-04',3000),
 (103,true,103,102,'ST','99011','P','2026-01-04',3000),
 (104,true,104,104,'647','99012','P','2026-01-01',100);
 DO $$ DECLARE q jsonb; BEGIN
 q:=apt_gantt('{"lote_exacto":"16544 D"}');
 IF q#>>'{filas,0,ot}'<>'16544' OR q#>>'{filas,0,estado}'<>'CON_SALDO'
  OR (q#>>'{kpis,ingresadas_tn}')::numeric<>2 OR (q#>>'{kpis,saldo_tn}')::numeric<>2
  OR (q#>>'{filas,0,edad_ponderada}')::numeric<>1
  OR q#>>'{filas,0,eventos,0,tipo}'<>'DEVOLUCION' THEN RAISE EXCEPTION 'Return must reopen a distinct dated material cycle in the same OT family'; END IF;
 q:=apt_gantt('{"ot":"16544"}');
 IF (q->>'total')::integer<>3 OR (q#>>'{kpis,saldo_tn}')::numeric<>10 THEN RAISE EXCEPTION 'Return must remain visible in the complete OT family'; END IF;
 q:=apt_gantt('{"lote_exacto":"99011"}');
 IF (q#>>'{kpis,ingresadas_tn}')::numeric<>0 OR (q#>>'{kpis,asignadas_tn}')::numeric<>3
  OR (q#>>'{kpis,saldo_tn}')::numeric<>3 OR (q#>>'{filas,0,edad_ponderada}')::numeric<>16
  OR q#>>'{filas,0,eventos,0,lote_rel}'<>'99010' THEN RAISE EXCEPTION 'Reassignment destination must preserve root age and expose assigned weight without external ingress'; END IF;
 q:=apt_gantt('{"lote_exacto":"99010"}');
 IF (q#>>'{kpis,ingresadas_tn}')::numeric<>6 OR (q#>>'{kpis,cedidas_tn}')::numeric<>3
  OR (q#>>'{kpis,saldo_tn}')::numeric<>3 THEN RAISE EXCEPTION 'Reassignment source must conserve material and expose ceded weight'; END IF;
 q:=apt_gantt('{"lote":"9901"}');
 IF (q#>>'{kpis,ingresadas_tn}')::numeric<>16 OR (q#>>'{kpis,saldo_tn}')::numeric<>6.1
  OR (q#>>'{kpis,asignadas_tn}')::numeric<>(q#>>'{kpis,cedidas_tn}')::numeric THEN RAISE EXCEPTION 'Reassignment must not duplicate external total material'; END IF;
 q:=apt_gantt('{"lote_exacto":"99012","estado":"RESIDUAL"}');
 IF (q->>'total')::integer<>1 OR q#>>'{filas,0,estado}'<>'RESIDUAL' OR (q#>>'{kpis,saldo_tn}')::numeric<>0.1
  OR (q#>>'{kpis,abiertas}')::integer<>1 OR (q#>>'{filas,0,segmentos,0,abierto}')::boolean IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Nonzero residual within tolerance must remain open, explicitly classified and visible'; END IF;
 END $$;
 ROLLBACK;`)
 sql(`INSERT INTO apt_flow_layers(id,almacen,lote,producto,tipo,fecha,kg_in,kg_out,kg_saldo,cliente)
 SELECT 100000+i,'647',(10000+(i-1)/32)::text,'P','PRODUCCION','2026-01-01'::date+(i%14),100,40,60,'Load' FROM generate_series(1,64000)i;
 INSERT INTO apt_flow_exits(id,almacen,lote,producto,tipo,fecha,kg,documento)
 SELECT 200000+i,'647',(10000+(i-1)/32)::text,'P','DESPACHO','2026-01-02'::date+(i%14),40,'LOAD-'||i FROM generate_series(1,64000)i;
 INSERT INTO apt_flow_alloc(layer_id,exit_id,kg) SELECT 100000+i,200000+i,40 FROM generate_series(1,64000)i;
 INSERT INTO apt_flow_pieces(id,es_saldo,layer_id,root_id,almacen,lote,producto,fecha_origen,kg)
 SELECT 100000+i,true,100000+i,100000+i,'647',(10000+(i-1)/32)::text,'P','2026-01-01'::date+(i%14),60 FROM generate_series(1,64000)i;
 ANALYZE apt_flow_layers;ANALYZE apt_flow_exits;ANALYZE apt_flow_alloc;ANALYZE apt_flow_pieces;`)
 const load=json(`SET statement_timeout='8s';SELECT apt_gantt('{}',50,100)`)
 assert.equal(load.filas.length,50);assert.equal(load.total,2004);assert.equal(load.kpis.ingresadas_tn,6431)
 sql(`CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE TABLE roles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,permissions jsonb);
 CREATE TABLE profiles(id uuid PRIMARY KEY,role_id uuid,is_active boolean);
 CREATE TABLE drivers(profile_id uuid);
 INSERT INTO auth.users VALUES('11111111-1111-1111-1111-111111111111');
 INSERT INTO profiles(id,is_active) VALUES('11111111-1111-1111-1111-111111111111',true);
 GRANT USAGE ON SCHEMA auth TO authenticated;GRANT SELECT ON roles,profiles,drivers,auth.users TO authenticated;`+
 fn(read('supabase/migrations/20261002100000_apt_estadia_inventario.sql'),'apt_can_view'))
 sql(read('supabase/tests/caja_c65_apt_gantt.test.sql').replace("RAISE EXCEPTION 'CAJA C65 PASS:","RAISE NOTICE 'CAJA C65 PASS:"))
 console.log('PASS: Gantt production-shaped schema; FIFO partial/historical cutoff, internal transfers/reassignments, dated returns, nonzero residuals, OT family, same-date pending recalculation, initial unknown age, root-age critical quantities, preperiod balances, non-delivery exits, promise dates, pagination, date validation authorization and paginated 64,000-layer/exit/alloc workload under 8s.')
}catch(e){console.error(e);process.exitCode=1}finally{spawnSync('docker',['rm','-f',name],{stdio:'ignore'})}
