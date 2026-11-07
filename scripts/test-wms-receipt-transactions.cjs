// Disposable PostgreSQL engine, actual migration/RPC bodies; never connects to a remote database.
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { PGlite } = require('@electric-sql/pglite')
const read = name => readFileSync(`supabase/wms/migrations/${name}`, 'utf8')
const core = read('20261225103000_warehouse_wms_core.sql')
const source = read('20261225104000_wms_receipt_source_import.sql')
const table = (sql, name) => sql.match(new RegExp(`CREATE TABLE public\\.${name} \\([\\s\\S]+?\\n\\);`))[0]
const fn = (sql, name) => { const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`); return sql.slice(start, sql.indexOf('END $$;', start) + 7) }
const user = '11111111-1111-4111-8111-111111111111'
const site = '22222222-2222-4222-8222-222222222222'
async function main() {
 const db = new PGlite()
 try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${user}'::uuid $$;
    CREATE TABLE roles(id uuid PRIMARY KEY,name text,permissions jsonb);
    INSERT INTO roles VALUES('${user}','Operador','["almacen-etiquetado","almacen-carga"]');
    CREATE TABLE profiles(id uuid PRIMARY KEY,role_id uuid,is_active boolean);
    INSERT INTO profiles VALUES('${user}','${user}',true);
    CREATE TABLE sites(id uuid PRIMARY KEY); INSERT INTO sites VALUES('${site}');
    CREATE TABLE clients(id uuid PRIMARY KEY,business_name text);
    CREATE TABLE contracts(id uuid PRIMARY KEY,code text,client_id uuid,parent_contract_id uuid);
    CREATE TABLE transport_requests(id uuid PRIMARY KEY); CREATE TABLE dispatches(id uuid PRIMARY KEY);
    CREATE TABLE wh_tasks(id uuid PRIMARY KEY); CREATE TABLE wh_task_lines(id uuid PRIMARY KEY);
    CREATE FUNCTION primary_site_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${site}'::uuid $$;
    CREATE FUNCTION can_access_site(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${site}'::uuid $$;
    CREATE FUNCTION is_active_tms_user() RETURNS boolean LANGUAGE sql AS $$ SELECT EXISTS(SELECT 1 FROM profiles WHERE id=auth.uid() AND is_active) $$;
    CREATE FUNCTION security_assert_active_session() RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF NOT is_active_tms_user() THEN RAISE EXCEPTION 'Denied'; END IF; END $$;
    CREATE FUNCTION inv_ot(text) RETURNS text LANGUAGE sql AS $$ SELECT $1 $$;
    CREATE FUNCTION apt_ot_raiz(text) RETURNS text LANGUAGE sql AS $$ SELECT $1 $$;
    CREATE FUNCTION inv_ot_cliente(text) RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;
    ${table(core,'wh_packages')}${table(core,'wh_receipt_validations')}${table(core,'wh_scan_events').replace('REFERENCES public.wh_lpns(id)','')}
    ${table(source,'wh_receipt_import_runs')}${table(source,'wh_receipt_sources')}
    ${fn(source,'wh_import_receipt_snapshot')}
    ALTER TABLE wh_receipt_sources ENABLE ROW LEVEL SECURITY; ALTER TABLE wh_receipt_import_runs ENABLE ROW LEVEL SECURITY;
  `)
  for(const name of ['has_tms_permission','wh_has_permission']) {
    const start=core.indexOf('CREATE OR REPLACE FUNCTION public.'+name+'(')
    await db.exec(core.slice(start,core.indexOf('$$;',start)+3))
  }
  await db.exec(read('20261226150000_wms_receipt_transaction_integrity.sql'))
  const q = async (sql, params=[]) => (await db.query(sql, params)).rows
  const receipt={source_key:'receipt-a',document_no:'IPT-1',source_date:'2026-11-07',warehouse:'PT',product_code:'PRODUCT-A',quantity:900,customer_name:'Cliente prueba',unit:'UND',lot:'LOT-1',total_weight:1800}
  const importRows=async(rows,hash)=>q('SELECT wh_import_receipt_snapshot($1,$2,$3::jsonb) result',['entrada.xlsx',hash,JSON.stringify(rows)])
  assert.equal((await importRows([receipt],'a'.repeat(64)))[0].result.rows,1)
  assert.equal((await q("SELECT wh_receipt_candidates('') result"))[0].result.length,1)
  assert.equal((await importRows([receipt],'a'.repeat(64)))[0].result.duplicate,true)
  await assert.rejects(importRows([{...receipt,quantity:-1}],'b'.repeat(64)),/positiva/)
  assert.equal((await q('SELECT count(*)::int n FROM wh_receipt_import_runs'))[0].n,1)
  await assert.rejects(q('SELECT wh_validate_receipt($1,$2)',[receipt.source_key,899]),/motivo/)
  await q('SELECT wh_validate_receipt($1,$2,$3)',[receipt.source_key,900,null])
  const amounts=[...Array(8).fill(100),75,25]
  const generate=async(a=amounts)=> (await q('SELECT wh_label_packages($1,$2::numeric[]) result',[receipt.source_key,a]))[0].result
  for(const invalid of [[-1,901],[0,900],[901],[899],[NaN],[]]) await assert.rejects(generate(invalid))
  const first=await generate()
  assert.match(first.package_codes[0],/^LPN-\d{8}-\d{6,}$/);assert.equal(first.count,10); assert.equal(new Set(first.package_codes).size,10)
  assert.deepEqual(first.labels.map(x=>Number(x.quantity)),amounts)
  assert.equal(first.labels[0].customer_name,'Cliente prueba')
  assert.equal(first.labels[0].source_product_code,'PRODUCT-A')
  const retry=await generate(); assert.deepEqual(retry.package_codes,first.package_codes)
  assert.equal((await q('SELECT count(*)::int n FROM wh_packages'))[0].n,10)
  await assert.rejects(generate([900]),/otra distribución/)
  await assert.rejects(importRows([{...receipt,quantity:950}],'c'.repeat(64)),/concilie/)
  assert.equal((await q('SELECT quantity::float8 n FROM wh_receipt_sources'))[0].n,900)
  assert.equal((await q('SELECT count(*)::int n FROM wh_receipt_import_runs'))[0].n,1)
  assert.equal((await q('SELECT sum(quantity)::float8 n FROM wh_packages'))[0].n,900)
  // An injected failure after the first package must roll back the entire RPC.
  await importRows([{...receipt,source_key:'receipt-b',document_no:'IPT-2'}],'d'.repeat(64))
  await q('SELECT wh_validate_receipt($1,$2)', ['receipt-b',900])
  await q("UPDATE wh_receipt_sources SET description='Revisada' WHERE source_key='receipt-b'")
  assert.equal((await q("SELECT wh_receipt_candidates('IPT-2') result"))[0].result[0].validation_status,'STALE')
  await assert.rejects(q("SELECT wh_label_packages('receipt-b',ARRAY[450,450]::numeric[])"),/vigente/)
  await q('SELECT wh_validate_receipt($1,$2)', ['receipt-b',900])
  await db.exec(`CREATE FUNCTION fail_second() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_movement_key='receipt-b' AND NEW.sequence_no=2 THEN RAISE EXCEPTION 'Injected storage failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_second BEFORE INSERT ON wh_packages FOR EACH ROW EXECUTE FUNCTION fail_second();`)
  await assert.rejects(q("SELECT wh_label_packages('receipt-b',ARRAY[450,450]::numeric[])"),/Injected/)
  assert.equal((await q("SELECT count(*)::int n FROM wh_packages WHERE source_movement_key='receipt-b'"))[0].n,0)
  const auditId='66666666-6666-4666-8666-666666666666'
  const audit=()=>q('SELECT wh_record_import_attempt($1,$2,$3,$4,$5,$6,$7)',[auditId,'entrada.xlsx','a'.repeat(64),'a'.repeat(64),'ACCEPTED',1,null])
  await audit();await audit()
  assert.equal((await q("SELECT count(*)::int n FROM wh_scan_events WHERE event_type='IMPORT_ACCEPTED'"))[0].n,1)
  await q('SELECT wh_record_import_attempt($1,$2,$3,$4,$5,$6,$7)',['77777777-7777-4777-8777-777777777777','invalido.xlsx',null,null,'REJECTED',null,'Faltan columnas'])
  assert.equal((await q("SELECT payload->>'reason' reason FROM wh_scan_events WHERE event_type='IMPORT_REJECTED'"))[0].reason,'Faltan columnas')
  const printId='33333333-3333-4333-8333-333333333333'
  const confirm=async(reason=null,id=printId)=>q('SELECT wh_confirm_label_print($1,$2,$3) result',[first.package_codes,reason,id])
  assert.equal((await confirm())[0].result.duplicate,false)
  assert.equal((await confirm())[0].result.duplicate,true)
  assert.equal((await q('SELECT sum(label_print_count)::int n FROM wh_packages'))[0].n,10)
  await assert.rejects(confirm('different request'),/reutilizado/)
  const secondId='44444444-4444-4444-8444-444444444444'
  await assert.rejects(confirm(null,secondId),/motivo/)
  await confirm('Etiqueta dañada',secondId)
  assert.equal((await q('SELECT sum(label_print_count)::int n FROM wh_packages'))[0].n,20)
  await q('SELECT wh_print_labels($1)',[first.package_codes])
  assert.equal((await q('SELECT sum(label_print_count)::int n FROM wh_packages'))[0].n,20)
  // Actual package read policy: the account cannot see a package in another site or write directly.
  await db.exec(`ALTER TABLE wh_packages ENABLE ROW LEVEL SECURITY; GRANT SELECT ON wh_packages TO authenticated;
    ${core.match(/CREATE POLICY wh_packages_read[\s\S]+?;/)[0]}
    INSERT INTO sites VALUES('55555555-5555-4555-8555-555555555555');
    INSERT INTO wh_packages(package_code,source_document_no,source_product_code,source_warehouse,source_date,source_movement_key,source_key,site_id,description,quantity)
    VALUES('OTHER-SITE','OTHER','OTHER','OTHER','2026-11-07','other','other','55555555-5555-4555-8555-555555555555','Other',1);
    SET ROLE authenticated;`)
  assert.equal((await q('SELECT count(*)::int n FROM wh_packages'))[0].n,10)
  await assert.rejects(q('UPDATE wh_packages SET quantity=1'),/permission denied/)
  await db.exec('RESET ROLE; SET ROLE anon;')
  await assert.rejects(generate(),/permission denied/)
  await db.exec(`RESET ROLE; UPDATE roles SET permissions='[]';`)

  await assert.rejects(generate(),/Denied|permiso/)
  console.log('PASS: import/hash/no duplicates, validation/variance, 900=8x100+75+25, 10 unique LPNs, idempotent retries, immutable issued labels, role/site RLS, anonymous/write denial, print confirmation/retry/reprint audit, full rollback on partial failure.')
 } finally { await db.close() }
}
main().catch(e=>{console.error(e.message);process.exitCode=1})
