// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción. Catálogo por SKU del ERP: último peso conocido,
// medidas leídas de la descripción y el código, m³ con control de densidad, volumen de la OT y densidad sugerida.
const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const read = f => readFileSync('supabase/migrations/' + f, 'utf8')
function fn(file, name) { const s = read(file), m = new RegExp('CREATE (?:OR REPLACE )?FUNCTION public\\.' + name + '\\(').exec(s); if (!m) throw Error(name); const b = s.indexOf('$$', m.index); return s.slice(m.index, s.indexOf('$$;', b + 2) + 3) }
;(async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE FUNCTION is_active_tms_user() RETURNS bool LANGUAGE sql AS $$SELECT true$$;
      CREATE FUNCTION erp_ref_can_view() RETURNS bool LANGUAGE sql AS $$SELECT true$$;
      CREATE FUNCTION has_tms_permission(text) RETURNS bool LANGUAGE sql AS $$SELECT true$$;
      CREATE TABLE erp_imports(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text, status text, cut_at timestamptz, created_at timestamptz DEFAULT now());
      -- En producción total_volume_m3 es DECIMAL(10,2) DEFAULT 0
      CREATE TABLE contracts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text, total_weight_kg numeric, total_volume_m3 numeric(10,2) DEFAULT 0);
      CREATE TABLE erp_contract_lines(import_id uuid, nro_documento text, secuencia int, cod_producto text, producto text, familia text, unidad text,
        tipo_producto text, cant_contrato numeric, cantidades_ausentes boolean NOT NULL DEFAULT false, peso_unit numeric);
      CREATE TABLE erp_stock_lots(import_id uuid, cod_producto text, producto text, familia text, unidad text, peso_unitario numeric, kg numeric);
      CREATE TABLE inv_movements(producto text, peso_unit numeric, active boolean);
      CREATE TABLE erp_contract_pesos(contract_id uuid PRIMARY KEY, kg numeric, lineas int, lineas_sin_peso int, import_id uuid, updated_at timestamptz);
      CREATE TABLE cubicaje_familias(familia text PRIMARY KEY, kg_por_m3 numeric, notas text, updated_at timestamptz);`)
    await db.exec(fn('20261024120000_erp_contratos_stock.sql', 'erp_active_import'))
    await db.exec(fn('20261026090000_erp_analisis_calidad.sql', 'erp_key'))
    await db.exec(fn('20261028090000_erp_contratos.sql', 'erp_doc_key'))
    await db.exec(read('20261223090000_erp_sku_peso_m3.sql'))  // sin datos aún: la siembra no hace nada
    const q = async (sql, p = []) => (await db.query(sql, p)).rows

    // Medidas de descripciones reales del Actualizable y el Stock
    const med = async (cod, txt) => {
      const r = (await q('SELECT erp_medidas_texto($1, $2) AS d', [cod, txt]))[0].d
      return r && r.map(x => x === null ? null : Number(x))
    }
    assert.deepEqual(await med('E.RARG5.45.0001.3905', 'ANGULO EST 2" X 2" X 4.5 MM P/RIEL GUIA DERECHA X 3.905M C/05 CARTELAS'), [3.905, 0.0508, 0.0508])
    assert.deepEqual(await med('RAPO.20.033.0760', 'POSTE DE RACK OMEGA DE 3 X 3 DE 2mm x 0.76m DE LARGO'), [0.76, 0.0762, 0.0762], '«3 X 3» sin unidad = pulgadas')
    assert.deepEqual(await med('RADIC.16.4025.0601', 'DIAGONAL DE RACK C DE 40mm X 25mm DE 1.6mm x 0.601m DE LARGO'), [0.601, 0.04, 0.025], 'el espesor no cuenta')
    assert.deepEqual(await med('E.VTRVVM.2030.9702', 'VIGA TUBO RECTANGULAR CONEXION VIGA-VIGA DE MEZZANINE 200x300x6.0 x 9.702M'), [9.702, 0.3, 0.2],
      'mm con largo en m (el Excel daba 582.120 m³ por unidad)')
    assert.deepEqual(await med('801.15.5326', 'CUMBRERA 1 DENTADA BLANCO 9003 - 600 X 0.50 X 3 M'), [3, 0.6, 0.0005], 'el color 9003 se ignora')
    assert.deepEqual(await med('.RAAB.20.0080.0120', 'ABRAZADERA P/TUBO Ø 3" 2.0MM'), [0.12, 0.0762, 0.002], 'el largo sale del código')
    assert.deepEqual(await med('MEG08.50100.06040992', 'MALLA ELECTROSOLDADA GALV. 50mm x 100mm, N° 8 DE 0.604m DE ANCHO x 0.992m DE FONDO'), [0.992, 0.604, 0.1])
    assert.deepEqual(await med('PP1D.45.350170.295', 'PROTECTOR CON PERF. DERECHA PARA POSTE DOBLE 5 X 3 X 4.5MM CON PESTAÑA INTERIOR'), [0.127, 0.0762, 0.0045],
      'sección en pulgadas y espesor en mm; sin largo, la densidad lo descarta')
    assert.deepEqual(await med('503.04.555', 'TUERCA HEX ZINC 3/8 GR-5'), null, 'sin medidas')
    assert.deepEqual(await med('.SECD.01.1101.0003', 'DESCARGA DE MATERIAL CAMION PLATAFORMA 12m - 30TN - LIMA'), [12, null, null], 'una sola medida: sin m³')
    assert.deepEqual(await med('X', 'CABLE 3/8" X 20 M'), null, 'más de 15 m: mal leído')

    // Stock 1 trae el peso del ángulo A; el poste B solo tiene peso en el inventario; la viga C no tiene peso; D va en cientos
    await q(`INSERT INTO erp_imports(kind, status) VALUES ('STOCK', 'ACTIVA'), ('CONTRATOS', 'ACTIVA')`)
    await q(`INSERT INTO erp_stock_lots SELECT id, 'E.RARG5.45.0001.3905', 'ANGULO EST 2" X 2" X 4.5 MM P/RIEL GUIA DERECHA X 3.905M C/05 CARTELAS', 'RACKS', 'UND', 14.68, 146.8
      FROM erp_imports WHERE kind = 'STOCK'`)
    await q(`INSERT INTO inv_movements VALUES ('RAPO.20.033.0760', 2.5, true), ('PERNO', 0.05, true)`)
    await q(`INSERT INTO erp_contract_lines SELECT id, v.* FROM erp_imports, (VALUES
      ('16000', 1, 'E.RARG5.45.0001.3905', 'ANGULO EST 2" X 2" X 4.5 MM P/RIEL GUIA DERECHA X 3.905M C/05 CARTELAS', 'RACKS', 'UND', 'PRODUCTO TERMINADO', 10, false, NULL::numeric),
      ('16000', 2, 'RAPO.20.033.0760', 'POSTE DE RACK OMEGA DE 3 X 3 DE 2mm x 0.76m DE LARGO', 'RACKS', 'UND', 'PRODUCTO TERMINADO', 100, false, NULL),
      ('16000', 3, 'E.VTRVVM.2030.9702', 'VIGA TUBO RECTANGULAR 200x300x6.0 x 9.702M', 'VIGAS', 'UND', 'PRODUCTO TERMINADO', 1, false, NULL),
      ('16000', 4, '.SEAR.01', 'SERVICIO DE ARMADO', NULL, 'UND', 'SERVICIO A TERCEROS', 1, false, NULL),
      ('16001', 1, 'RAPO.20.033.0760', 'POSTE DE RACK OMEGA DE 3 X 3 DE 2mm x 0.76m DE LARGO', 'RACKS', 'UND', 'PRODUCTO TERMINADO', 10, false, NULL),
      ('16002', 1, 'PERNO', 'PERNO 3/8 X 1 X 2 X 3 CM', 'PERNOS', 'CIEN', 'MAT.AUX', 1000, false, NULL)) v
      WHERE kind = 'CONTRATOS'`)
    await q(`INSERT INTO contracts(code, total_volume_m3) VALUES ('16000', 0), ('16001', 5), ('16002', 0)`)
    await q('SELECT erp_refresh_peso()')
    const cat = Object.fromEntries((await q('SELECT * FROM erp_sku_medidas')).map(r => [r.cod_producto, r]))
    assert.equal(Number(cat['E.RARG5.45.0001.3905'].peso_unit), 14.68)
    assert.equal(cat['E.RARG5.45.0001.3905'].m3_confiable, true, `ángulo: ${cat['E.RARG5.45.0001.3905'].kg_m3} kg/m³`)
    assert.equal(cat['RAPO.20.033.0760'].m3_confiable, true, 'el poste se valida con el peso del inventario')
    assert.equal(cat['E.VTRVVM.2030.9702'].m3_confiable, false, 'sin peso no se puede validar')
    assert.equal(cat.PERNO.m3_confiable, false, 'en cientos no cuenta')
    assert.ok(Number(cat['E.VTRVVM.2030.9702'].m3_unit) > 0.5 && Number(cat['E.VTRVVM.2030.9702'].m3_unit) < 0.6)

    // Stock 2 ya no trae el ángulo (se despachó todo): su peso sigue saliendo del catálogo
    await q(`UPDATE erp_imports SET status = 'REEMPLAZADA' WHERE kind = 'STOCK'`)
    await q(`INSERT INTO erp_imports(kind, status) VALUES ('STOCK', 'ACTIVA')`)
    await q(`UPDATE erp_contract_lines SET peso_unit = NULL`)
    await q('SELECT erp_refresh_peso()')
    const pu = Object.fromEntries((await q('SELECT cod_producto, peso_unit FROM erp_contract_lines')).map(r => [r.cod_producto, r.peso_unit && Number(r.peso_unit)]))
    assert.equal(pu['E.RARG5.45.0001.3905'], 14.68, 'peso del último Stock con ese SKU')
    assert.equal(pu['RAPO.20.033.0760'], 2.5, 'o del inventario')

    // Volumen de la OT: 10 × 0,01008 + 100 × 0,00441 = 0,54 m³; la viga sin m³ confiable y el servicio no suman
    let r = (await q('SELECT erp_contratos_pesos_core() AS v'))[0].v
    assert.equal(r.success, true)
    const vol = Object.fromEntries((await q('SELECT code, total_volume_m3 FROM contracts')).map(x => [x.code, Number(x.total_volume_m3)]))
    assert.equal(vol['16000'], 0.54); assert.equal(vol['16001'], 5, 'un volumen escrito a mano no se pisa'); assert.equal(vol['16002'], 0)
    const reg = (await q(`SELECT v.* FROM erp_contract_volumenes v JOIN contracts c ON c.id = v.contract_id WHERE c.code = '16000'`))[0]
    assert.equal(reg.lineas, 3); assert.equal(reg.lineas_sin_m3, 1, 'la viga: volumen parcial')
    assert.equal(r.volumen.actualizadas, 1); assert.equal(r.volumen.manuales_conservadas, 1)
    // Cambia el ERP: el volumen que vino del ERP se actualiza
    await q(`UPDATE erp_contract_lines SET cant_contrato = 20 WHERE nro_documento = '16000' AND secuencia = 1`)
    await q('SELECT erp_contratos_pesos_core()')
    assert.equal(Number((await q(`SELECT total_volume_m3 v FROM contracts WHERE code = '16000'`))[0].v), 0.64)

    // Cubicaje: densidad sugerida de RACKS = mediana de los SKU con m³ confiable
    const fam = Object.fromEntries((await q('SELECT cubicaje_familias_lista() AS v'))[0].v.familias.map(f => [f.familia, f]))
    const den = [cat['E.RARG5.45.0001.3905'], cat['RAPO.20.033.0760']].map(x => Number(x.kg_m3)).sort((a, b) => a - b)
    assert.equal(fam.RACKS.skus_medidos, 2); assert.equal(Number(fam.RACKS.kg_por_m3_sugerido), Math.round((den[0] + den[1]) / 2))
    assert.equal(fam.VIGAS.kg_por_m3_sugerido, null)
    console.log('test-erp-sku-medidas OK')
  } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
