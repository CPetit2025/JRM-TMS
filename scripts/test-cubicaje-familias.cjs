// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción. Cubicaje por familia (kg/m³) para armar rutas.
const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const read = f => readFileSync('supabase/migrations/' + f, 'utf8')
function fn(file, name) { const s = read(file), m = new RegExp('CREATE (?:OR REPLACE )?FUNCTION public\\.' + name + '\\(').exec(s); if (!m) throw Error(name); const b = s.indexOf('$$', m.index); return s.slice(m.index, s.indexOf('$$;', b + 2) + 3) }
;(async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT '00000000-0000-4000-8000-000000000001'::uuid$$;
      CREATE FUNCTION is_active_tms_user() RETURNS bool LANGUAGE sql AS $$SELECT true$$;
      CREATE FUNCTION erp_ref_can_view() RETURNS bool LANGUAGE sql AS $$SELECT current_setting('test.scope', true) IS DISTINCT FROM 'none'$$;
      CREATE FUNCTION has_tms_permission(text) RETURNS bool LANGUAGE sql AS $$SELECT current_setting('test.scope', true) IS DISTINCT FROM 'read'$$;
      CREATE FUNCTION erp_ref_ot_visible(text) RETURNS bool LANGUAGE sql AS $$SELECT $1 <> '99999'$$;
      CREATE TABLE erp_imports(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text, status text, cut_at timestamptz, created_at timestamptz DEFAULT now());
      CREATE TABLE erp_contract_lines(import_id uuid, ot text, nro_documento text, secuencia int, cod_producto text, tipo_producto text, familia text, peso_unit numeric, cant_pendiente numeric);
      CREATE TABLE erp_stock_lots(import_id uuid, lote text, cod_producto text, stock numeric, factor numeric DEFAULT 1, kg numeric, familia text);
      INSERT INTO erp_imports(kind, status, cut_at) VALUES ('CONTRATOS', 'ACTIVA', now()), ('STOCK', 'ACTIVA', now() - interval '2 hours');`)
    await db.exec(fn('20261024120000_erp_contratos_stock.sql', 'erp_active_import'))
    await db.exec(fn('20261026090000_erp_analisis_calidad.sql', 'erp_key'))
    await db.exec(`
      -- OT 16037: tubos (2 líneas del mismo documento y SKU, el stock cubre la primera y parte de la segunda) y accesorios sin stock
      INSERT INTO erp_contract_lines SELECT id, v.* FROM erp_imports, (VALUES
        ('16037', '16037', 1, 'T1', 'PRODUCTO', ' TUBOS ', 2.5, 100), ('16037', '16037', 2, 'T1', 'PRODUCTO', 'TUBOS', 2.5, 100),
        ('16037', '16037', 3, 'A1', 'PRODUCTO', 'ACCESORIOS', NULL, 10), ('16037', '16037', 4, 'S1', 'SERVICIO A TERCEROS', 'SERVICIO', 1, 5),
        ('16037', '16037', 5, 'X1', 'PRODUCTO', 'TUBOS', 2.5, -4),
        ('99999', '99999', 1, 'T1', 'PRODUCTO', 'TUBOS', 2.5, 50)) v(a,b,c,d,e,f,g,h) WHERE kind = 'CONTRATOS';
      INSERT INTO erp_stock_lots SELECT id, '16037', 'T1', 150, 1, 375, 'TUBOS' FROM erp_imports WHERE kind = 'STOCK';
      INSERT INTO erp_stock_lots SELECT id, '55555', 'P9', 10, 1, 80, 'PLANCHAS' FROM erp_imports WHERE kind = 'STOCK';`)
    await db.exec(read('20261104100000_cubicaje_familias.sql'))
    const q = async (sql, p = []) => (await db.query(sql, p)).rows[0].v

    const seeded = (await db.query('SELECT familia FROM cubicaje_familias ORDER BY 1')).rows.map(r => r.familia)
    assert.deepEqual(seeded, ['ACCESORIOS', 'PLANCHAS', 'SERVICIO', 'TUBOS'], 'siembra las familias del ERP vigente, sin espacios')

    let r = await q(`SELECT route_cubicaje(ARRAY['16037-S1', '16037', '99999']) AS v`)
    assert.equal(r.ots.length, 1, 'normaliza la OT, quita duplicados y respeta la cartera')
    const fam = Object.fromEntries(r.ots[0].familias.map(f => [f.familia, f]))
    assert.equal(fam.TUBOS.pendiente_kg, 500); assert.equal(fam.TUBOS.listo_kg, 375, 'el stock se reparte por líneas en orden: 100 + 50 unidades')
    assert.equal(fam.TUBOS.m3_listo, null, 'sin densidad la familia queda sin medida'); assert.equal(fam.ACCESORIOS.lineas_sin_peso, 1)
    assert.equal(fam.ACCESORIOS.listo_kg, 0); assert.equal(fam.SERVICIO, undefined, 'los servicios a terceros no son carga')
    assert.ok(r.corte_stock, 'informa el corte de la foto de stock')

    assert.equal((await q(`SELECT cubicaje_familia_guardar('{"familia":"TUBOS","kg_por_m3":"250"}') AS v`)).success, true)
    await assert.rejects(db.query(`SELECT cubicaje_familia_guardar('{"familia":"TUBOS","kg_por_m3":"abc"}')`))
    assert.equal((await q(`SELECT cubicaje_familia_guardar('{"familia":"TUBOS","kg_por_m3":"-1"}') AS v`)).success, false)
    r = await q(`SELECT route_cubicaje(ARRAY['16037']) AS v`)
    assert.equal(r.ots[0].familias.find(f => f.familia === 'TUBOS').m3_listo, 1.5, '375 kg / 250 kg/m³')

    const lista = await q('SELECT cubicaje_familias_lista() AS v')
    assert.equal(lista.puede_editar, true); assert.equal(lista.familias[0].familia, 'TUBOS', 'ordena por peso en stock')
    assert.equal(lista.familias.find(f => f.familia === 'TUBOS').kg_por_m3, 250)

    await db.exec(`SELECT set_config('test.scope', 'read', false)`)
    assert.equal((await q('SELECT cubicaje_familias_lista() AS v')).puede_editar, false)
    assert.equal((await q(`SELECT cubicaje_familia_guardar('{"familia":"TUBOS","kg_por_m3":"1"}') AS v`)).success, false, 'solo lectura no edita')
    await db.exec(`SELECT set_config('test.scope', 'none', false)`)
    assert.equal((await q(`SELECT route_cubicaje(ARRAY['16037']) AS v`)).success, false)
    assert.equal((await q('SELECT cubicaje_familias_lista() AS v')).success, false)
    await db.exec(read('20261104100000_cubicaje_familias.sql'))
    assert.equal((await db.query(`SELECT kg_por_m3 FROM cubicaje_familias WHERE familia = 'TUBOS'`)).rows[0].kg_por_m3, '250.00', 'reaplicar no pisa lo configurado')
    console.log('PASS cubicaje por familia')
  } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
