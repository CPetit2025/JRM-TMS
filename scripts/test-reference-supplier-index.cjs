const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { PGlite } = require('@electric-sql/pglite')

async function main() {
  const db = new PGlite()
  await db.exec(`CREATE TABLE public.suppliers(id uuid PRIMARY KEY);
    CREATE TABLE public.transport_requests(
      id uuid PRIMARY KEY,
      reference_supplier_id uuid REFERENCES public.suppliers(id)
    );
    CREATE INDEX transport_requests_reference_supplier_idx
      ON public.transport_requests(reference_supplier_id)
      WHERE reference_supplier_id IS NOT NULL;`)
  await db.exec(readFileSync('supabase/migrations/20261209120000_indice_completo_proveedor_referencia.sql', 'utf8'))
  const { rows } = await db.query(`SELECT c.convalidated, i.indisvalid, i.indpred IS NULL AS full_index,
      (i.indkey::smallint[])[0:cardinality(c.conkey)-1] @> c.conkey AS covers_fk
    FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_index i ON i.indrelid=c.conrelid AND i.indexrelid='public.transport_requests_reference_supplier_idx'::regclass
    WHERE n.nspname='public' AND t.relname='transport_requests' AND c.contype='f'
      AND c.conname='transport_requests_reference_supplier_id_fkey'`)
  assert.deepEqual(rows, [{ convalidated: true, indisvalid: true, full_index: true, covers_fk: true }])
  await db.close()
  console.log('PASS: reference supplier FK is validated and covered by a valid full index (C55 rule).')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
