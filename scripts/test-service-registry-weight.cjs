const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { PGlite } = require('@electric-sql/pglite')

async function main() {
  const db = new PGlite()
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE TABLE contract_services(id uuid PRIMARY KEY, referral_guide text);
      CREATE TABLE apt_movements(documento text, peso_kg numeric, active boolean DEFAULT true,
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
    await db.exec(original.match(/CREATE OR REPLACE FUNCTION public\.apt_guias_peso\(p_guias text\)[\s\S]*?\$\$;/)[0])
    await db.exec(readFileSync('supabase/migrations/20261224120000_servicios_peso_actual.sql', 'utf8'))
    const ids = [1, 2, 3, 4].map(n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`)
    const query = () => db.query('SELECT service_id, kg::text, encontradas, faltan FROM get_service_registry_weight($1::uuid[]) ORDER BY service_id', [ids])
    assert.deepEqual((await query()).rows, [
      { service_id: ids[0], kg: '11231', encontradas: 1, faltan: 'T001-9999' },
      { service_id: ids[1], kg: '500', encontradas: 1, faltan: null },
    ])
    await db.exec(`UPDATE apt_movements SET peso_kg=600 WHERE documento='T001-00006821'`)
    assert.equal((await query()).rows[1].kg, '600')
    await assert.rejects(db.query('SELECT * FROM get_service_registry_weight($1::uuid[])', [Array(201).fill(ids[0])]), /200 servicios/)
    console.log('PASS: current APT weight, document-only guides, normalized deduplication, missing guides, service scope and batch limit')
  } finally { await db.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
