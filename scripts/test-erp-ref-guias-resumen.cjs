// erp_ref_guias_resumen por período devuelve lo mismo que la versión de producción que agregaba todas las guías.
const { PGlite } = require('@electric-sql/pglite')
const fs = require('node:fs'), assert = require('node:assert/strict')
;(async () => { const db = new PGlite(); try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE erp_imports(id uuid PRIMARY KEY, kind text, status text, cut_at timestamptz);
  CREATE TABLE erp_guia_fechas(import_id uuid, guia_key text, guia text, fecha date, exacta boolean, PRIMARY KEY(import_id, guia_key));
  CREATE TABLE erp_contract_lines(import_id uuid, nro_documento text, secuencia int, ot text, cliente text);
  CREATE TABLE erp_contract_guias(import_id uuid, nro_documento text, secuencia int, guia text, guia_key text, cantidad numeric);
  CREATE TABLE tms_guias(guia_key text, guia text, fecha date, rutas text, placas text, ot text);
  CREATE FUNCTION erp_active_import(p text) RETURNS uuid LANGUAGE sql STABLE AS $$SELECT id FROM erp_imports WHERE kind=p AND status='ACTIVA'$$;
  CREATE FUNCTION erp_tms_guias(p_from date DEFAULT NULL, p_to date DEFAULT NULL) RETURNS SETOF tms_guias LANGUAGE sql STABLE AS $$SELECT * FROM tms_guias$$;
  CREATE FUNCTION erp_ref_can_view() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
  CREATE FUNCTION is_tms_admin() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
  CREATE FUNCTION is_contract_administrator() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.ca',true)='1'$$;
  CREATE FUNCTION erp_ref_ot_visible(text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT $1 LIKE 'OT1%'$$;`)
  // Definición de erp_ref_guias_erp tal como está en producción (con filtro por claves)
  await db.exec(`CREATE FUNCTION erp_ref_guias_erp(v_c uuid, p_keys text[] DEFAULT NULL)
   RETURNS TABLE(guia_key text, guia text, fecha date, exacta boolean, ots text, docs text, items bigint, cantidad numeric, cliente text) LANGUAGE sql STABLE AS $f$
   SELECT f.guia_key, f.guia, f.fecha, f.exacta, g.ots, g.docs, g.items, g.cantidad, g.cliente FROM erp_guia_fechas f
   JOIN (SELECT g.guia_key, string_agg(DISTINCT l.ot, ', ') AS ots, string_agg(DISTINCT g.nro_documento, ', ') AS docs, count(*) AS items,
     sum(g.cantidad) AS cantidad, max(l.cliente) AS cliente FROM erp_contract_guias g JOIN erp_contract_lines l ON l.import_id = g.import_id
     AND l.nro_documento = g.nro_documento AND l.secuencia = g.secuencia WHERE g.import_id = v_c AND (p_keys IS NULL OR g.guia_key = ANY (p_keys)) GROUP BY g.guia_key) g USING (guia_key)
   WHERE f.import_id = v_c AND (p_keys IS NULL OR f.guia_key = ANY (p_keys))$f$`)
  const strip = sql => sql.replace(/SET search_path TO[^\n]*\n/, '').replace(/SET enable_nestloop TO[^\n]*\n/, '').replace(/SECURITY DEFINER/, '').replace(/public\./g, '')
  await db.exec(strip(fs.readFileSync('scripts/fixtures/erp_ref_guias_resumen_prod_20261111.sql', 'utf8')).replace('FUNCTION erp_ref_guias_resumen(', 'FUNCTION old_resumen('))
  await db.exec(strip(fs.readFileSync('supabase/migrations/20261231170100_erp_ref_guias_resumen_periodo.sql', 'utf8')))
  // Datos: guías solo ERP, solo TMS y en ambos, con fechas dentro y fuera de los períodos y desfases
  const imp = '00000000-0000-4000-8000-000000000001'
  let seed = 7; const rnd = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n
  const day = n => new Date(Date.UTC(2026, 9, 1) + n * 864e5).toISOString().slice(0, 10)
  await db.query(`INSERT INTO erp_imports VALUES($1,'CONTRATOS','ACTIVA',now())`, [imp])
  for (let i = 0; i < 300; i++) {
    const key = `G-${i}`, side = rnd(3) // 0 ERP, 1 TMS, 2 ambos
    if (side !== 1) {
      await db.query(`INSERT INTO erp_guia_fechas VALUES($1,$2,$2,$3,$4)`, [imp, key, day(rnd(60)), rnd(2) === 0])
      if (rnd(10)) for (let s = 0; s <= rnd(3); s++) {
        await db.query(`INSERT INTO erp_contract_lines VALUES($1,$2,$3,$4,$5)`, [imp, `D${i}`, s, `OT${rnd(3)}${i}`, `C${rnd(4)}`])
        await db.query(`INSERT INTO erp_contract_guias VALUES($1,$2,$3,$4,$4,$5)`, [imp, `D${i}`, s, key, rnd(100)])
      }
    }
    if (side !== 0) await db.query(`INSERT INTO tms_guias VALUES($1,$1,$2,'R','P',$3)`, [key, day(rnd(70) - 5), `OT${rnd(3)}`])
  }
  for (const ca of ['0', '1']) { await db.query(`SELECT set_config('test.ca',$1,false)`, [ca])
    for (const p of [{}, { desde: day(0), hasta: day(10) }, { desde: day(20), hasta: day(50), tolerancia: 0, limit: 100 }, { hasta: day(65) }, { desde: day(-20), hasta: day(-1) }]) {
      const q = async f => (await db.query(`SELECT ${f}($1::jsonb) v`, [JSON.stringify(p)])).rows[0].v
      assert.deepEqual(await q('erp_ref_guias_resumen'), await q('old_resumen'), JSON.stringify({ ca, p }))
    } }
  console.log('PASS erp_ref_guias_resumen por período = versión de producción (5 períodos, con y sin cartera)')
} finally { await db.close() } })().catch(e => { console.error(e); process.exit(1) })
