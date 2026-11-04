const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { PGlite } = require('@electric-sql/pglite')

async function main() {
  const db = new PGlite()
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE TABLE contract_services(id uuid PRIMARY KEY, referral_guide text);
      CREATE TABLE apt_movements(id serial PRIMARY KEY, documento text, peso_kg numeric, active boolean DEFAULT true,
        valid boolean DEFAULT true, kind text DEFAULT 'SALIDA');
      CREATE FUNCTION apt_guia_key(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
        SELECT upper(split_part($1, '-', 1)) || '-' || ltrim(split_part($1, '-', 2), '0') $$;
      CREATE TABLE registry_context(service_id uuid, guide_numbers jsonb);
      CREATE FUNCTION get_service_registry_context(ids uuid[]) RETURNS jsonb LANGUAGE plpgsql AS $$
      BEGIN
        IF cardinality(ids)>200 THEN RAISE EXCEPTION 'Consulte hasta 200 servicios por bloque'; END IF;
        RETURN (SELECT coalesce(jsonb_agg(to_jsonb(c)), '[]') FROM registry_context c WHERE service_id=ANY(ids));
      END $$;
      INSERT INTO contract_services VALUES
        ('00000000-0000-0000-0000-000000000001', 'T001-00006820'),
        ('00000000-0000-0000-0000-000000000002', NULL),
        ('00000000-0000-0000-0000-000000000003', NULL),
        ('00000000-0000-0000-0000-000000000004', 'T001-6820');
      INSERT INTO registry_context VALUES
        ('00000000-0000-0000-0000-000000000001', '["T001-6820", "T001-9999"]'),
        ('00000000-0000-0000-0000-000000000002', '["T001-6821"]'),
        ('00000000-0000-0000-0000-000000000003', '[]');
      INSERT INTO apt_movements(documento, peso_kg) VALUES
        ('T001-00006820', 11000), ('T001-00006820', 231), ('T001-00006821', 500);
    `)
    const original = readFileSync('supabase/migrations/20261006130000_servicios_peso_apt.sql', 'utf8')
    const guideMigration = readFileSync('supabase/migrations/20261003140000_guia_detalle_skus.sql', 'utf8')
    await db.exec(guideMigration.match(/CREATE OR REPLACE FUNCTION public\.apt_guia_key[\s\S]*?\$\$;/)[0])
    await db.exec(original.match(/CREATE OR REPLACE FUNCTION public\.apt_guias_peso\(p_guias text\)[\s\S]*?\$\$;/)[0])
    await db.exec(readFileSync('supabase/migrations/20261224120000_servicios_peso_actual.sql', 'utf8'))
    await db.exec(readFileSync('supabase/migrations/20261224140000_servicios_peso_consulta_lote.sql', 'utf8'))
    const ids = [1, 2, 3, 4].map(n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`)
    const query = () => db.query('SELECT service_id, kg::text, encontradas, faltan FROM get_service_registry_weight($1::uuid[]) ORDER BY service_id', [ids])
    assert.deepEqual((await query()).rows, [
      { service_id: ids[0], kg: '11231', encontradas: 1, faltan: 'T001-9999' },
      { service_id: ids[1], kg: '500', encontradas: 1, faltan: null },
    ])
    await db.exec(`UPDATE apt_movements SET peso_kg=600 WHERE documento='T001-00006821'`)
    assert.equal((await query()).rows[1].kg, '600')
    await assert.rejects(db.query('SELECT * FROM get_service_registry_weight($1::uuid[])', [Array(201).fill(ids[0])]), /200 servicios/)
    await db.exec(`UPDATE contract_services SET referral_guide='T001-00006820,6820' WHERE id='${ids[0]}';
      CREATE INDEX apt_movements_guia_key_idx ON apt_movements(apt_guia_key(documento)) WHERE active AND valid AND kind='SALIDA';
      CREATE INDEX apt_movements_guia_num_idx ON apt_movements(split_part(apt_guia_key(documento), '-', 2)) WHERE active AND valid AND kind='SALIDA';
      INSERT INTO apt_movements(documento,peso_kg) SELECT 'T999-'||n,1 FROM generate_series(10000,59999) n;
      INSERT INTO contract_services SELECT ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,NULL FROM generate_series(100,299) n;
      INSERT INTO registry_context SELECT id,'["T001-6820"]'::jsonb FROM contract_services WHERE id>'00000000-0000-0000-0000-000000000099';
      ANALYZE apt_movements;`)
    assert.equal((await query()).rows[0].kg, '11231')
    assert.equal((await query()).rows[0].encontradas, 2)
    const batch = Array.from({length:200},(_,n)=>`00000000-0000-0000-0000-${String(n+100).padStart(12,'0')}`)
    const batchRows = (await db.query('SELECT kg::text FROM get_service_registry_weight($1::uuid[])', [batch])).rows
    assert.equal(batchRows.length,200)
    assert.ok(batchRows.every(r=>r.kg==='11231'))
    const migration = readFileSync('supabase/migrations/20261224140000_servicios_peso_consulta_lote.sql','utf8')
    const queryBody = migration.split('AS $$')[1].split('$$;')[0].replaceAll('p_services','$1::uuid[]')
    const plan = (await db.query('EXPLAIN (ANALYZE, FORMAT JSON) '+queryBody,[batch])).rows[0]['QUERY PLAN'][0].Plan
    const scans=[]
    function visit(node) {
      if(node['Relation Name']==='apt_movements') scans.push(node)
      for(const child of node.Plans||[]) visit(child)
    }
    visit(plan)
    assert.ok(scans.length>0)
    assert.ok(scans.every(node=>node['Actual Loops']<=1), 'SALIDA must not be scanned per service')
    await db.exec(`UPDATE registry_context SET guide_numbers=jsonb_build_array('T999-'||((right(service_id::text,12)::int)-100+10000)) WHERE service_id>'00000000-0000-0000-0000-000000000099'`)
    const distinctRows=(await db.query('SELECT kg::text FROM get_service_registry_weight($1::uuid[])',[batch])).rows
    assert.equal(distinctRows.length,200)
    assert.ok(distinctRows.every(r=>r.kg==='1'))
    scans.length=0
    visit((await db.query('EXPLAIN (ANALYZE, FORMAT JSON) '+queryBody,[batch])).rows[0]['QUERY PLAN'][0].Plan)
    assert.ok(scans.every(node=>node['Node Type']!=='Seq Scan'), 'Distinct guides must use indexed lookups, not full SALIDA scans')
    console.log('PASS: 200 different guides also resolve correctly against 50,000 SALIDA lines')
    console.log('PASS: 200 services sharing a guide resolve APT once with 50,000 unrelated rows; numeric aliases do not double weight')
    console.log('PASS: current APT weight, document-only guides, normalized deduplication, missing guides, service scope and batch limit')
  } finally { await db.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
