// Importación del historial de mantenimiento (scripts/lib/mant-import-core.cjs) con libros sintéticos.
// Ejecutar: node --test scripts/test-mant-import.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')
const XLSX = require('xlsx')
const core = require('./lib/mant-import-core.cjs')

const V5 = ['AÑO', 'MES', 'ACTIVO', 'CLASE_ACTIVO', 'FECHA', 'PROVEEDOR', 'FACTURA', 'KM_HRS', 'PROX_MANTTO', 'FECHA_INGRESO', 'FECHA_SALIDA', 'MONTO', 'COMENTARIOS',
  'TIPO_MANTTO', 'AREA', 'CATEGORIA_COSTO', 'TIPO_ORIGEN', 'AÑO FABRICACIÓN', 'CRITERIO_TIPO_MANTTO', 'OBS_MEDIDOR', 'KM_HRS_VALIDADO', 'DIA_CON_CORRECTIVO']
const row = (o = {}) => {
  const v = (k, d) => (k in o ? o[k] : d)
  return [2025, 3, v('activo', 'UN FORKLIFT 3TN NN01'), v('clase', 'MONTACARGA'), v('fecha', new Date(2025, 2, 3)), v('prov', 'BECERRA DONAYRES MAURO'), v('fac', 'E001-123'),
    v('km', 1500), 1750, v('ing', null), v('sal', null), v('monto', 350.5), v('desc', 'Cambio de aceite y filtros'), v('tipo', 'PREVENTIVO'), 'Distribución', 'MANTENIMIENTO',
    v('origen', 'PREVENTIVO'), 2012, v('criterio', 'Sin cambio'), v('obs', 'OK'), v('kmv', 1500), v('dia', 'NO')]
}
function book(rows, head = V5, extraSheets = {}) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...rows], { cellDates: true }), 'CONSOLIDADO')
  for (const [n, aoa] of Object.entries(extraSheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), n)
  return Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
}

test('formato v5: tipo corregido y original por separado, columnas de calidad y fila original conservada', () => {
  const res = core.analyze(book([row({ desc: 'Reparación de bomba hidráulica', tipo: 'CORRECTIVO', origen: 'PREVENTIVO', criterio: 'Reparación en el comentario' })]))
  assert.deepEqual(res.parsed.missingV5, [])
  const r = res.parsed.rows[0]
  assert.equal(r.tipo, 'CORRECTIVO')
  assert.equal(r.tipo_origen, 'PREVENTIVO')
  assert.equal(r.criterio_tipo, 'Reparación en el comentario')
  assert.equal(r.km_hrs_original, 1500)
  assert.equal(r.km_hrs_validado, 1500)
  assert.equal(r.obs_medidor, 'OK')
  assert.equal(r.dia_con_correctivo, false)
  assert.equal(r.fecha, '2025-03-03')
  assert.equal(r.fila_original.PROVEEDOR, 'BECERRA DONAYRES MAURO')
  assert.equal(r.estado, 'OK')
})

test('no inventa datos: lo vacío queda vacío y se marca; IGV desconocido; sin hora de taller se avisa', () => {
  const res = core.analyze(book([row({ km: null, fac: null, ing: new Date(2025, 2, 3), sal: new Date(2025, 2, 5), kmv: null })]))
  const r = res.parsed.rows[0]
  assert.equal(r.km_hrs_original, null)
  assert.equal(r.factura, null)
  assert.ok(r.faltantes.includes('KM_HRS') && r.faltantes.includes('FACTURA'))
  assert.equal(r.incluye_igv, null, 'IGV desconocido: no se asume')
  assert.equal(r.dias_fuera, 2)
  assert.ok(r.observaciones.some(o => /sin hora/.test(o)))
})

test('rechazados y dudosos con su motivo', () => {
  const res = core.analyze(book([
    row({ activo: null }),
    row({ monto: 'abc' }),
    row({ fecha: 'pronto', fac: 'X1' }),
    row({ tipo: 'PREVENTIVO', origen: 'PREVENTIVO', desc: 'Cambio de motor de arranque', fac: 'X2' }),
    row({ obs: 'RETROCESO', kmv: null, fac: 'X3' }),
  ]))
  const [a, b, c, d, e] = res.parsed.rows
  assert.equal(a.estado, 'RECHAZADO'); assert.match(a.motivos.join(), /Sin ACTIVO/)
  assert.equal(b.estado, 'RECHAZADO'); assert.match(b.motivos.join(), /MONTO no numérico/)
  assert.equal(c.estado, 'DUDOSO'); assert.match(c.motivos.join(), /Sin FECHA/)
  assert.equal(d.estado, 'DUDOSO'); assert.match(d.motivos.join(), /PREVENTIVO con cambio de componente/)
  assert.equal(e.estado, 'DUDOSO'); assert.match(e.motivos.join(), /Medidor: RETROCESO/)
})

test('clave natural estable y líneas idénticas legítimas numeradas (idempotencia)', () => {
  const buf = book([row(), row(), row({ fac: 'E001-999' })])
  const a = core.analyze(buf).parsed.rows, b = core.analyze(buf).parsed.rows
  assert.deepEqual(a.map(r => r.clave_natural), b.map(r => r.clave_natural), 'misma entrada → mismas claves')
  assert.equal(new Set(a.map(r => r.clave_natural)).size, 3, 'las dos líneas idénticas no colisionan')
  assert.match(a[1].clave_natural, /\|2$/)
  assert.ok(a[1].observaciones.some(o => /idéntica/.test(o)))
  const c = core.analyze(book([row({ prov: 'otro proveedor' })])).parsed.rows[0]
  assert.equal(c.clave_natural, a[0].clave_natural, 'el proveedor no forma parte de la clave: corregir su nombre no duplica')
})

test('regla de tipo: reparación o cambio de componente nunca es preventivo; consumibles sí', () => {
  assert.equal(core.tipoViolacion('PREVENTIVO', 'Cambio de aceite, filtro de aire y engrase'), null)
  assert.equal(core.tipoViolacion('PREVENTIVO', 'Cambio de llantas delanteras'), null)
  assert.ok(core.tipoViolacion('PREVENTIVO', 'Reparación de fuga en cilindro'))
  assert.ok(core.tipoViolacion('PREVENTIVA', 'CAMBIO DE MOTOR'))
  assert.ok(core.tipoViolacion('PREVENTIVO', 'cambio de batería de tracción'))
  assert.equal(core.tipoViolacion('CORRECTIVO', 'Reparación de motor'), null)
})

test('proveedores: equivalencias propuestas (tildes, forma societaria y errores de digitación) y equivalencias revisadas', () => {
  const g = core.groupProviders(['BECERRA DONAYRES MAURO', 'BECERRA DONAIRES MAURO', 'BECERRA DONAIRES MAURO', 'DERCOCENTER SAC', 'DERCOCENTER', 'ACME', 'ACMA'])
  const becerra = g.find(x => x.miembros.includes('BECERRA DONAYRES MAURO'))
  assert.equal(becerra.canonico, 'BECERRA DONAIRES MAURO', 'el nombre más frecuente es el canónico')
  assert.equal(becerra.fuente, 'similitud (revisar)')
  assert.equal(g.find(x => x.miembros.includes('DERCOCENTER')).miembros.length, 2)
  assert.equal(g.filter(x => x.miembros.includes('ACME') || x.miembros.includes('ACMA')).length, 2, 'nombres cortos no se agrupan por similitud')
  const ov = core.groupProviders(['ACME', 'ACMA'], { ACMA: 'ACME' })
  assert.equal(ov.find(x => x.canonico === 'ACME').miembros.length, 2)
})

test('cuadre: totales por clase y año, ventana jul-2024–jun-2026 y % correctivo de equipos', () => {
  const res = core.analyze(book([
    row({ clase: 'MONTACARGA', fecha: new Date(2024, 6, 1), monto: 100, tipo: 'CORRECTIVO', fac: 'A' }),
    row({ clase: 'EQUIPO DE ELEVACIÓN', fecha: new Date(2026, 5, 30), monto: 300, tipo: 'PREVENTIVO', fac: 'B' }),
    row({ clase: 'UNIDAD VEHICULAR', fecha: new Date(2025, 0, 10), monto: 50, tipo: 'CORRECTIVO', fac: 'C' }),
    row({ clase: 'MONTACARGA', fecha: new Date(2024, 5, 30), monto: 1000, tipo: 'CORRECTIVO', fac: 'D' }),
  ]))
  const t = res.totales
  assert.equal(t.registros, 4)
  assert.equal(t.monto, 1450)
  assert.deepEqual(t.ventana_2024_07_2026_06, { registros: 3, monto: 450 })
  assert.equal(t.equipos_ventana.registros, 2)
  assert.equal(t.equipos_ventana.pct_correctivo, 25)
  assert.equal(t.por_anio['2024'].registros, 2)
  assert.equal(t.por_clase['MONTACARGA'].monto, 1100)
  const ctl = core.controles(t)
  assert.equal(ctl.find(c => c.id === 'registros').ok, false, 'controles comparan contra el Excel v5 de referencia')
})

test('formato anterior al v5: TIPO_MANTTO pasa a tipo de origen y el tipo corregido queda vacío y marcado', () => {
  const OLD = ['AÑO', 'MES', 'ACTIVO', 'CLASE_ACTIVO', 'FECHA', 'PROVEEDOR', 'FACTURA', 'KM_HRS', 'PROX_MANTTO', 'FECHA_INGRESO', 'FECHA_SALIDA', 'MONTO', 'COMENTARIOS', 'TIPO_MANTTO']
  const res = core.analyze(book([row().slice(0, OLD.length)], OLD))
  assert.ok(res.parsed.missingV5.includes('OBS_MEDIDOR'))
  const r = res.parsed.rows[0]
  assert.equal(r.tipo, null)
  assert.equal(r.tipo_origen, 'PREVENTIVO')
  assert.ok(r.faltantes.includes('TIPO_MANTTO (corregido)'))
  assert.equal(res.totales.equipos_ventana.pct_correctivo, null)
  const md = core.markdownReport(res, { archivo: 'x.xlsx' })
  assert.match(md, /Formato anterior al v5/)
})
