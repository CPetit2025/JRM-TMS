const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { PGlite } = require('@electric-sql/pglite')

async function main() {
  const db = new PGlite()
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE FUNCTION apt_can_view() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION has_tms_permission(text) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
      CREATE FUNCTION apt_flow_tms(text[]) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
      CREATE TABLE apt_movements(id serial PRIMARY KEY, active boolean DEFAULT true, valid boolean DEFAULT true,
        kind text DEFAULT 'SALIDA', documento text, fecha date, cliente text, ruc text, bodega text,
        peso_kg numeric DEFAULT 10, lote text, docrel text, unidad text, cantidad numeric,
        producto text, glosa text, familia text, peso_unitario numeric, numrel text, fecha_entrega date);
      CREATE TABLE apt_flow_pieces(exit_id int, fecha_origen date, fecha_salida date, kg numeric, origen text);
      INSERT INTO apt_movements(documento, producto, glosa) VALUES
        ('T001-00006820', 'ORIGINAL', 'Descripción original'),
        ('T001-00006820', 'RECUPERAR', NULL),
        ('T001-00006820', 'ESPACIOS', '   '),
        ('T001-00006820', 'AMBIGUO', NULL),
        ('T001-00006820', 'SIN-DATOS', NULL),
        ('T001-00006820', 'SOLO-INACTIVO', NULL),
        ('T001-00006820', 'SOLO-INVALIDO', NULL);
      INSERT INTO apt_movements(kind, producto, glosa) VALUES
        ('ENTRADA', 'ORIGINAL', 'Otro texto que no debe reemplazar el original'),
        ('ENTRADA', 'RECUPERAR', 'Descripción recuperada'),
        ('ENTRADA', 'RECUPERAR', ' Descripción recuperada '),
        ('ENTRADA', 'ESPACIOS', 'Descripción para espacios'),
        ('ENTRADA', 'AMBIGUO', 'Descripción A'),
        ('ENTRADA', 'AMBIGUO', 'Descripción B');
      INSERT INTO apt_movements(producto, glosa, active, valid) VALUES
        ('SOLO-INACTIVO', 'Texto obsoleto', false, true),
        ('SOLO-INVALIDO', 'Texto inválido', true, false);
    `)
    await db.exec(readFileSync('supabase/migrations/20261003140000_guia_detalle_skus.sql', 'utf8'))
    await db.exec(readFileSync('supabase/migrations/20261224130000_guias_descripciones_productos.sql', 'utf8'))
    const read = async () => (await db.query("SELECT apt_guia_detalle('T001-6820') AS detalle")).rows[0].detalle
    const result = await read()
    assert.equal(result.success, true)
    const guide = result.guias[0]
    const items = Object.fromEntries(guide.items.map(item => [item.producto, item]))
    assert.equal(items.ORIGINAL.glosa, 'Descripción original')
    assert.equal(items.ORIGINAL.glosa_recuperada, false)
    assert.equal(items.RECUPERAR.glosa, 'Descripción recuperada')
    assert.equal(items.RECUPERAR.glosa_recuperada, true)
    assert.equal(items.ESPACIOS.glosa, 'Descripción para espacios')
    for (const code of ['AMBIGUO', 'SIN-DATOS', 'SOLO-INACTIVO', 'SOLO-INVALIDO']) {
      assert.equal(items[code].glosa, null)
      assert.equal(items[code].glosa_recuperada, false)
    }
    assert.equal(guide.lineas, 7)
    assert.equal(Number(guide.tn), 0.07)
    assert.equal((await db.query("SELECT glosa FROM apt_movements WHERE producto='RECUPERAR' AND documento IS NOT NULL")).rows[0].glosa, null)
    await db.exec(`CREATE OR REPLACE FUNCTION apt_can_view() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$`)
    assert.equal((await read()).success, false)
    console.log('PASS: original descriptions, unique SKU recovery, blanks, ambiguous/missing descriptions, active/valid sources, unchanged rows/weight and access control')
  } finally { await db.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
