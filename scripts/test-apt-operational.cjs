// Prueba SQL aislada: datos sintéticos y forma de producción; nunca conecta a Supabase.
const {readFileSync} = require('node:fs')
const {spawnSync} = require('node:child_process')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const name = `jrm-apt-operational-${process.pid}`
const read = file => readFileSync(path.join(root, file), 'utf8')
function run(args, input) {
  const result = spawnSync('docker', args, {input, encoding: 'utf8'})
  if (result.status !== 0) throw Error(result.stderr || result.stdout || String(result.error))
  return result.stdout
}
function fn(source, name) {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  assert.ok(start >= 0, `Missing function ${name}`)
  return source.slice(start, source.indexOf('$$;', start) + 3)
}
const sql = input => run(['exec', '-i', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], input)
const json = input => JSON.parse(run(['exec', '-i', name, 'psql', '-U', 'postgres', '-qtA', '-v', 'ON_ERROR_STOP=1'], input).trim())
const query = (filters = {}) => json(`SELECT apt_operational_summary('${JSON.stringify(filters).replaceAll("'", "''")}'::jsonb)`)
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 0.005, `${label}: ${actual} != ${expected}`)
try {
  run(['run', '-d', '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:16-alpine'])
  let ready = false
  for (let n = 0; n < 40; n++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status === 0) {ready = true; break}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  }
  assert.ok(ready, 'Scratch PostgreSQL did not become ready')
  const shape = read('scripts/security/production-shape.sql')
  const table = name => {
    const start = shape.indexOf(`CREATE TABLE public."${name}" (`)
    assert.ok(start >= 0, `Missing production shape ${name}`)
    return shape.slice(start, shape.indexOf(';', start) + 1)
  }
  const family = read('supabase/migrations/20261003160000_apt_familia_ot.sql')
  const flow = read('supabase/migrations/20261003100000_apt_flujo_multialmacen.sql')
  sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE FUNCTION apt_can_view() RETURNS boolean LANGUAGE sql AS $$
      SELECT COALESCE(current_setting('test.can_view',true),'true')='true' $$;
    ` + ['apt_flow_layers','apt_flow_exits','apt_flow_alloc','apt_flow_pieces','apt_flow_state','apt_settings','apt_movements','apt_uploads','apt_layers','apt_allocations'].map(table).join('\n') +
    fn(family, 'apt_ot_raiz') + fn(family, 'apt_flow_match') + fn(flow, 'apt_flow_tn') +
    fn(read('supabase/migrations/20261002100000_apt_estadia_inventario.sql'), 'apt_date'))
  const migration = read('supabase/migrations/20261011200000_apt_operational_analytics.sql')
  sql(migration)
  sql(migration) // Idempotencia.
  const optimization = read('supabase/migrations/20261012010000_apt_operational_query_plan.sql')
  sql(optimization)
  sql(optimization) // Optimización idempotente y sin cambios al límite del servicio.
  // Saldo 17 TN: producción 25 − despacho 7 − consumo 6 + apertura inferida 3 + retorno 2.
  // Traspaso de 20 a ST se cuenta en la ubicación, pero no como producción/despacho adicional.
  sql(`INSERT INTO apt_settings(id,alert_days,tolerance) VALUES(1,7,0.02);
    INSERT INTO apt_flow_state(id,cutoff,data_min,rebuilt_at) VALUES(1,'2026-01-10','2026-01-01','2026-01-11 12:00+00');
    INSERT INTO apt_flow_layers(id,almacen,lote,producto,tipo,fecha,kg_in,kg_out,kg_saldo,cliente,exit_id,lote_origen) VALUES
    (1,'647','16544','P','PRODUCCION','2026-01-01',20000,20000,0,'Test',NULL,NULL),
    (2,'ST','16544','P','TRASPASO','2026-01-04',20000,8000,12000,'Test',10,'16544'),
    (3,'540','16544-S001','P','INICIAL',NULL,3000,0,3000,'Test',NULL,NULL),
    (4,'647','16545','P','PRODUCCION','2026-01-01',5000,5000,0,'Other',NULL,NULL),
    (5,'647','16546 D','P','DEVOLUCION','2026-01-09',2000,0,2000,'Third',NULL,NULL);
    INSERT INTO apt_flow_exits(id,almacen,lote,producto,tipo,fecha,kg,documento,lote_destino) VALUES
    (10,'647','16544','P','TRASPASO','2026-01-04',20000,'T1','16544'),
    (11,'ST','16544','P','DESPACHO','2026-01-06',7000,'G1',NULL),
    (12,'ST','16544','P','CONSUMO','2026-01-08',1000,'C1',NULL),
    (13,'647','16545','P','CONSUMO','2026-01-05',5000,'C2',NULL);
    INSERT INTO apt_flow_alloc(layer_id,exit_id,kg) VALUES(1,10,20000),(2,11,7000),(2,12,1000),(4,13,5000);
    INSERT INTO apt_flow_pieces(id,es_saldo,layer_id,root_id,almacen,lote,producto,fecha_origen,kg,origen) VALUES
    (1,true,2,1,'ST','16544','P','2026-01-01',12000,'PRODUCCION'),
    (2,true,3,3,'540','16544-S001','P',NULL,3000,'INICIAL_540'),
    (3,true,5,5,'647','16546 D','P','2026-01-09',2000,'DEVOLUCION');
    INSERT INTO apt_movements(id,kind,active,valid,fecha,lote,peso_kg,almacen,producto) VALUES
    (1,'ENTRADA',true,true,'2026-01-01','16544',20000,'647','P'),
    (2,'SALIDA',true,true,'2026-01-06','16544',7000,'ST','P'),
    (3,'ENTRADA',true,true,'2026-01-01','16545',5000,'647','P'),
    (4,'DEVOLUCION',true,true,'2026-01-09','16546 D',2000,'647','P'),
    (5,'SALIDA',true,true,'2026-01-10','16544',0,'ST','P');`)
  const all = query({desde:'2026-01-01',hasta:'2026-01-10'})
  assert.equal(all.success, true)
  assert.equal(all.schema_version, 1)
  assert.equal(all.meta.calculation_basis, 'DOCUMENTAL_RECONSTRUIDO')
  near(all.kpis.stock_tn, 17, 'Stock conserves internal transfers')
  near(all.kpis.inferred_opening_tn, 3, 'Opening remains explicitly inferred')
  near(all.kpis.known_origin_stock_tn, 14, 'Known dated origin')
  near(all.kpis.unknown_origin_stock_tn, 3, 'Unknown origin is not zero days')
  near(all.kpis.production_tn, 25, 'Transfers and return are not production')
  near(all.kpis.dispatch_tn, 7, 'Consumption is not customer dispatch')
  near(all.kpis.consumption_tn, 6, 'Both consumptions included')
  near(all.kpis.returns_tn, 2, 'Returns explicit')
  assert.equal(all.kpis.observed_days, 10)
  near(all.kpis.average_stock_tn, 21.6, 'Mean daily stock includes opening and closed cohorts')
  near(all.kpis.turnover, 7/21.6, 'Turnover uses mean daily stock')
  near(all.kpis.weighted_age_days, 7.9, 'Known origin weighted age excludes 3 unknown TN')
  near(all.kpis.stock_tn_days, 110, 'Snapshot TN-days, not integrated occupation')
  assert.equal(all.quality.missing_weight_rows, 1)
  const familyResult = query({ot:'16544',desde:'2026-01-01',hasta:'2026-01-10'})
  near(familyResult.kpis.stock_tn, 15, 'OT family includes variant')
  const clientResult = query({clientes:['Test'],desde:'2026-01-01',hasta:'2026-01-10'})
  near(clientResult.kpis.stock_tn, 15, 'Client cohort retains exits with missing raw client')
  near(clientResult.kpis.dispatch_tn, 7, 'Client cohort counts dispatch with missing raw client')
  const st = query({almacen:'ST',desde:'2026-01-01',hasta:'2026-01-10'})
  near(st.kpis.stock_tn, 12, 'Current warehouse includes transfer stock')
  near(st.kpis.production_tn, 0, 'Warehouse transfer is not production')
  const paged = query({limit:1,offset:1,desde:'2026-01-01',hasta:'2026-01-10'})
  assert.deepEqual(paged.kpis, all.kpis, 'Paging does not alter totals')
  assert.equal(paged.rows.length, 1)
  const none = query({lote:'NO-SUCH-LOT'})
  near(none.kpis.stock_tn, 0, 'Empty scope stock')
  assert.equal(none.kpis.turnover, null, 'Zero denominator not false zero turnover')
  const past = query({cutoff:'2026-01-03',desde:'2026-01-01',hasta:'2026-01-03'})
  near(past.kpis.stock_tn, 28, 'Historical pretransfer stock includes opening')
  near(past.kpis.dispatch_tn, 0, 'Future dispatch excluded')
  assert.equal(query({desde:'2026-01-10',hasta:'2026-01-01'}).success, false)
  assert.equal(query({cutoff:'invalid'}).success, false)
  assert.equal(query({cutoff:'2025-12-31'}).success, false, 'No precoverage stock claim')
  assert.equal(query({desde:'2025-12-31',hasta:'2026-01-10'}).success, false, 'No precoverage average stock claim')
  sql(`INSERT INTO apt_uploads(id,file_name,status,applied_at) VALUES
    ('22222222-2222-2222-2222-222222222222','same-date replacement','APLICADA','2026-01-11 13:00+00');`)
  assert.equal(query().meta.model_fresh, false, 'Same date replacement invalidates model')
  // Independent snapshots are append-only evidence, never an adjustment to the source ledger.
  sql(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES('11111111-1111-1111-1111-111111111111');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULLIF(current_setting('test.uid',true),'')::uuid $$;
    CREATE FUNCTION apt_can_load() RETURNS boolean LANGUAGE sql AS $$ SELECT COALESCE(current_setting('test.can_load',true),'false')='true' $$;
    CREATE FUNCTION is_active_tms_user() RETURNS boolean LANGUAGE sql AS $$ SELECT COALESCE(current_setting('test.active',true),'true')='true' $$;`)
  sql(read('supabase/migrations/20261011220000_apt_stock_reconciliation.sql'))
  sql(read('supabase/migrations/20261011230000_apt_observation_author_index.sql'))
  sql(`DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid='apt_stock_observations'::regclass AND c.contype='f'
      AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.conrelid AND i.indisvalid AND i.indpred IS NULL
        AND (i.indkey::smallint[])[0:cardinality(c.conkey)-1] @> c.conkey)) THEN
      RAISE EXCEPTION 'Observation author FK has no covering index';
    END IF;
  END $$;`)
  const observe = data => json(`SELECT apt_stock_observation_save('${JSON.stringify(data).replaceAll("'", "''")}'::jsonb)`)
  const observation = {cutoff:'2026-01-10',almacen:'ST',lote:'16544',producto:'P',peso_kg:12000,source:'ERP',reference:'Synthetic ERP snapshot'}
  assert.equal(observe(observation).success, false, 'No permission to save snapshot')
  sql(`ALTER DATABASE postgres SET "test.uid"='11111111-1111-1111-1111-111111111111'; ALTER DATABASE postgres SET "test.can_load"='true';`)
  assert.equal(observe(observation).success, true)
  assert.equal(observe({...observation,peso_kg:-1}).success, false)
  assert.equal(observe({...observation,peso_kg:'NaN'}).success, false)
  assert.equal(observe({...observation,reference:''}).success, false)
  assert.equal(observe({...observation,peso_kg:11900,source:'FISICO',reference:'Synthetic physical count'}).success, true)
  let reconciliation = json(`SELECT apt_stock_reconciliation('{"cutoff":"2026-01-10"}')`)
  assert.equal(reconciliation.total, 2, 'ERP and physical observations are independent')
  assert.equal(reconciliation.certifies_full_inventory, false)
  assert.equal(reconciliation.model_fresh, false, 'Same-date applied replacement makes reconciliation stale')
  assert.equal(reconciliation.documentary_available, false)
  for (const row of reconciliation.rows) {
    assert.equal(row.status, 'MODELO_PENDIENTE', 'Old model must never certify an observation')
    assert.equal(row.documentary_kg, null)
    assert.equal(row.difference_kg, null)
  }
  sql(`UPDATE apt_flow_state SET rebuilt_at='2026-01-11 13:00+00' WHERE id=1`)
  reconciliation = json(`SELECT apt_stock_reconciliation('{"cutoff":"2026-01-10"}')`)
  assert.equal(reconciliation.model_fresh, true, 'A model at the applied version can compare again')
  assert.equal(reconciliation.documentary_available, true)
  assert.equal(reconciliation.rows.find(r => r.source==='ERP').status, 'COINCIDE_DOCUMENTAL')
  assert.equal(reconciliation.rows.find(r => r.source==='FISICO').difference_kg, -100)
  assert.equal(query().kpis.stock_tn, 17, 'Observation never overwrites the reconstructed inventory')
  assert.equal(observe({...observation,peso_kg:11800,source:'FISICO',reference:'Corrected count'}).success, true)
  reconciliation = json(`SELECT apt_stock_reconciliation('{"cutoff":"2026-01-10","source":"FISICO"}')`)
  assert.equal(reconciliation.total, 1, 'Latest observation per source/key is compared')
  assert.equal(reconciliation.rows[0].difference_kg, -200)
  assert.equal(json('SELECT jsonb_build_object(\'n\',count(*)) FROM apt_stock_observations').n, 3, 'Prior evidence remains in history')
  assert.equal(observe({...observation,cutoff:'2026-01-12'}).success, true)
  assert.equal(json(`SELECT apt_stock_reconciliation('{"cutoff":"2026-01-12"}')`).rows[0].documentary_kg, null, 'No model beyond its cutoff is not zero inventory')
  sql(`DO $$ BEGIN
    IF has_table_privilege('authenticated','apt_stock_observations','INSERT') OR has_table_privilege('anon','apt_stock_observations','SELECT') THEN RAISE EXCEPTION 'Direct stock evidence access'; END IF;
    END $$;`)
  assert.equal(json(`SET test.can_view='false'; SELECT apt_operational_summary('{}')`).success, false)
  assert.equal(json(`SET test.can_view='false'; SELECT apt_stock_reconciliation('{}')`).success, false)
  assert.equal(json(`SET test.active='false'; SELECT apt_stock_reconciliation('{}')`).success, false)
  assert.equal(json(`SET test.active='false'; SELECT apt_stock_observation_save('${JSON.stringify(observation)}')`).success, false)
  sql(`DO $$ BEGIN
    IF has_function_privilege('anon','apt_operational_summary(jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Anonymous access'; END IF;
    IF NOT has_function_privilege('authenticated','apt_operational_summary(jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Authorized role missing'; END IF;
    END $$;`)
  // Exercise the actual RPC over a wide observed window and 64k independent inventory keys.
  // The timeout is a regression bound on a disposable database, not a production SLA.
  sql(`UPDATE apt_flow_state SET data_min='2025-01-10',cutoff='2026-01-10' WHERE id=1;
    INSERT INTO apt_flow_layers(id,almacen,lote,producto,tipo,fecha,kg_in,kg_out,kg_saldo,cliente)
    SELECT 100000+n,CASE WHEN n%4=0 THEN 'ST' ELSE '647' END,'PERF-'||n,'P','PRODUCCION',
      '2025-01-10'::date+(n%366),1000,200,800,CASE WHEN n%2=0 THEN 'Perf A' ELSE 'Perf B' END
    FROM generate_series(1,64000) n;
    INSERT INTO apt_flow_exits(id,almacen,lote,producto,tipo,fecha,kg,documento)
    SELECT 100000+n,CASE WHEN n%4=0 THEN 'ST' ELSE '647' END,'PERF-'||n,'P','DESPACHO',
      '2025-01-10'::date+(n%366),200,'PERF-G-'||n FROM generate_series(1,64000) n;
    INSERT INTO apt_flow_pieces(id,es_saldo,layer_id,root_id,almacen,lote,producto,fecha_origen,kg,origen)
    SELECT 100000+n,true,100000+n,100000+n,CASE WHEN n%4=0 THEN 'ST' ELSE '647' END,'PERF-'||n,'P',
      '2025-01-10'::date+(n%366),800,'PRODUCCION' FROM generate_series(1,64000) n;
    ANALYZE apt_flow_layers; ANALYZE apt_flow_exits; ANALYZE apt_flow_pieces;`)
  const perfFilters = {lote:'PERF-',desde:'2025-01-10',hasta:'2026-01-10',limit:25}
  const perfQuery = filters => json(`SET statement_timeout='8s'; SELECT apt_operational_summary('${JSON.stringify(filters)}'::jsonb)`)
  const started = performance.now()
  const perf = perfQuery(perfFilters)
  const elapsed = performance.now()-started
  assert.equal(perf.total, 64000)
  assert.equal(perf.rows.length, 25)
  assert.equal(perf.series.length, 366)
  near(perf.kpis.stock_tn, 51200, 'Large ledger balance')
  near(perf.kpis.production_tn, 64000, 'Large ledger production')
  near(perf.kpis.dispatch_tn, 12800, 'Large ledger dispatched weight')
  const scopedPerf = perfQuery({...perfFilters,clientes:['Perf A'],almacen:'ST'})
  assert.equal(scopedPerf.total,16000,'Customer and warehouse cohort preserve scope at scale')
  near(scopedPerf.kpis.stock_tn,12800,'Scoped large ledger balance')
  near(scopedPerf.kpis.dispatch_tn,3200,'Customer filter preserves exits missing raw customer')
  console.log(`PERF: actual summary RPC, 64k layers/exits/pieces, 366 days, ${elapsed.toFixed(0)} ms including psql; full and scoped queries below 8s scratch timeout.`)
  // Production-shaped documentary history: repeated cohort keys, missing weights and
  // anomalous allocations were absent from the old performance fixture. These rows
  // exercise coverage and quality queries instead of timing only inventory aggregates.
  sql(`INSERT INTO apt_movements(id,kind,active,valid,fecha,lote,peso_kg,almacen,producto)
    SELECT 200000+n,'ENTRADA',true,true,'2025-01-10'::date+(n%366),
      'PERF-'||(1+(n%100)),CASE WHEN n%7=0 THEN 0 ELSE 1000 END,
      CASE WHEN (1+(n%100))%4=0 THEN 'ST' ELSE '647' END,'P'
    FROM generate_series(1,71000) n;
    -- Import replacement retains inactive historical documents in production. They must
    -- neither affect coverage nor cause repeated per-row filtering of the active ledger.
    INSERT INTO apt_movements(id,kind,active,valid,fecha,lote,peso_kg,almacen,producto)
    SELECT 700000+n,'ENTRADA',false,true,'2025-01-10'::date+(n%366),
      'INACTIVE-'||(1+(n%27250)),0,'647','P' FROM generate_series(1,190000) n;
    INSERT INTO apt_layers(movement_id,lote,producto)
    SELECT id,lote,producto FROM apt_movements WHERE id>200000 AND active;
    INSERT INTO apt_allocations(layer_id,exit_id,kg,fecha_ingreso,fecha_salida,dias)
    SELECT id,id,1,fecha,fecha-1,0 FROM apt_movements WHERE id>200000 AND active;
    ANALYZE apt_movements; ANALYZE apt_layers; ANALYZE apt_allocations;`)
  const documentaryStarted = performance.now()
  const documentary = perfQuery(perfFilters)
  assert.equal(documentary.quality.missing_weight_rows,Math.floor(71000/7))
  assert.equal(documentary.quality.temporal_anomaly_rows,71000)
  const documentaryElapsed = performance.now()-documentaryStarted
  const documentaryScoped = perfQuery({...perfFilters,clientes:['Perf A'],almacen:'ST'})
  assert.equal(documentaryScoped.quality.temporal_anomaly_rows,17750)
  const optimizedAll = documentary
  const optimizedScope = documentaryScoped
  // Compare the full JSON contract to the installed predecessor, not just selected KPI fields.
  sql(migration)
  const predecessorStarted = performance.now()
  const predecessorAll = query(perfFilters)
  const predecessorElapsed = performance.now()-predecessorStarted
  const predecessorScope = query({...perfFilters,clientes:['Perf A'],almacen:'ST'})
  assert.deepEqual(optimizedAll,predecessorAll,'Optimization preserves full unfiltered documentary contract')
  assert.deepEqual(optimizedScope,predecessorScope,'Optimization preserves full customer/warehouse contract')
  sql(optimization)
  console.log(`PERF: 71k active documentary movements/layers/anomalous allocations, 190k inactive documents, plus 64k inventory keys; full and customer-scoped queries below 8s scratch timeout, ${Math.round(performance.now()-documentaryStarted)} ms including contract comparisons.`)
  console.log(`PERF comparison: full documentary ledger optimized ${Math.round(documentaryElapsed)} ms; predecessor ${Math.round(predecessorElapsed)} ms; identical JSON.`)
  // ERP exports often contain many repeated lot/product keys, rather than independent lots.
  // This skew changes join estimates; ANALYZE must also protect a single hot cohort.
  sql(`INSERT INTO apt_flow_layers(id,almacen,lote,producto,tipo,fecha,kg_in,kg_out,kg_saldo,cliente)
    SELECT 400000+n,'647','HOT-1','HOT-P','PRODUCCION','2026-01-10',1,0.25,0.75,'Hot' FROM generate_series(1,71000) n;
    INSERT INTO apt_flow_exits(id,almacen,lote,producto,tipo,fecha,kg,documento)
    SELECT 400000+n,'647','HOT-1','HOT-P','DESPACHO','2026-01-10',0.25,'HOT-G-'||n FROM generate_series(1,71000) n;
    INSERT INTO apt_flow_pieces(id,es_saldo,layer_id,root_id,almacen,lote,producto,fecha_origen,kg,origen)
    SELECT 400000+n,true,400000+n,400000+n,'647','HOT-1','HOT-P','2026-01-10',0.75,'PRODUCCION' FROM generate_series(1,71000) n;
    ANALYZE apt_flow_layers; ANALYZE apt_flow_exits; ANALYZE apt_flow_pieces;`)
  const hot = perfQuery({lote:'HOT-1',clientes:['Hot'],desde:'2026-01-10',hasta:'2026-01-10'})
  assert.equal(hot.total,1,'Repeated movements consolidate one inventory cohort')
  near(hot.kpis.stock_tn,53.25,'Repeated-key balance stays exact')
  near(hot.kpis.production_tn,71,'Repeated-key production stays exact')
  near(hot.kpis.dispatch_tn,17.75,'Repeated-key dispatched weight stays exact')
  // Run the deployment Caja tests with real APT permission functions and production-shaped identities.
  sql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE TABLE roles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,permissions jsonb);
    CREATE TABLE profiles(id uuid PRIMARY KEY,role_id uuid,is_active boolean);
    CREATE TABLE drivers(profile_id uuid);
    INSERT INTO profiles(id,is_active) VALUES('11111111-1111-1111-1111-111111111111',true);
    CREATE SEQUENCE fixture_piece_ids START 10000;
    ALTER TABLE apt_flow_pieces ALTER COLUMN id SET DEFAULT nextval('fixture_piece_ids');
    GRANT USAGE ON SCHEMA auth TO authenticated;
    GRANT SELECT ON roles,profiles,drivers,auth.users TO authenticated;` +
    fn(read('supabase/migrations/20261002100000_apt_estadia_inventario.sql'), 'apt_can_view') +
    fn(read('supabase/migrations/20261002100000_apt_estadia_inventario.sql'), 'apt_can_load') +
    fn(read('supabase/migrations/20261008020000_production_security_boundaries.sql'), 'is_active_tms_user'))
  for (const [file, code] of [['caja_c88_apt_operational.test.sql','C88'],['caja_c90_apt_stock_observations.test.sql','C90']]) {
    sql(read(`supabase/tests/${file}`).replace(`RAISE EXCEPTION 'CAJA ${code} PASS:`, `RAISE NOTICE 'CAJA ${code} PASS:`))
  }
  console.log('PASS: operational SQL; mean-stock turnover, family/current warehouse, FIFO known/unknown age, residual balances, transfer conservation, consumption/return separation, historical cutoff, full-set paging totals, empty denominators, same-date freshness, date validation and authorization. Synthetic fixtures only.')
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  spawnSync('docker', ['rm', '-f', name], {stdio:'ignore'})
}
