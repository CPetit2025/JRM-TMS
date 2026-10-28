// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción. Vigencia de la foto de stock para programar rutas.
const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const read = f => readFileSync('supabase/migrations/' + f, 'utf8')
function fn(file, name) { const s = read(file), m = new RegExp('CREATE (?:OR REPLACE )?FUNCTION public\\.' + name + '\\(').exec(s); if (!m) throw Error(name); const b = s.indexOf('$$', m.index); return s.slice(m.index, s.indexOf('$$;', b + 2) + 3) }
;(async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE TABLE erp_imports(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text, status text, cut_at timestamptz, applied_at timestamptz, created_at timestamptz DEFAULT now());
      CREATE TABLE erp_contract_settings(id int, corte_max_horas int);
      CREATE FUNCTION erp_ref_can_view() RETURNS bool LANGUAGE sql AS $$SELECT current_setting('test.scope', true) IS DISTINCT FROM 'none'$$;`)
    await db.exec(fn('20261024120000_erp_contratos_stock.sql', 'erp_active_import'))
    await db.exec(read('20261104090000_erp_stock_corte_despacho.sql'))
    const v = async () => (await db.query('SELECT erp_stock_corte() AS v')).rows[0].v

    assert.equal((await v()).estado, 'SIN_CARGA', 'sin foto activa')
    await db.exec(`INSERT INTO erp_imports(kind, status, cut_at, applied_at) VALUES ('STOCK', 'ACTIVA', now() - interval '3 hours', now() - interval '2 hours'),
      ('STOCK', 'REEMPLAZADA', now() - interval '1 hour', now()), ('CONTRATOS', 'ACTIVA', now(), now())`)
    let r = await v()
    assert.equal(r.estado, 'VIGENTE'); assert.equal(Math.round(r.horas), 3, 'usa el corte de la foto ACTIVA de stock, no el de contratos ni el reemplazado'); assert.equal(r.max_horas, 48)
    await db.exec(`INSERT INTO erp_contract_settings VALUES (1, 2)`)
    r = await v(); assert.equal(r.estado, 'DESACTUALIZADO', 'respeta el umbral configurado'); assert.equal(r.max_horas, 2)
    await db.exec(`UPDATE erp_imports SET cut_at = NULL WHERE kind = 'STOCK' AND status = 'ACTIVA'`)
    r = await v(); assert.equal(r.estado, 'DESACTUALIZADO', 'sin hora de corte no se presenta como vigente'); assert.equal(r.horas, null)
    await db.exec(`SELECT set_config('test.scope', 'none', false)`)
    r = await v(); assert.equal(r.success, false); assert.equal(r.cut_at, undefined, 'sin acceso no expone datos')
    console.log('PASS erp_stock_corte')
  } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
