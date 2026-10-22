// Motor de la analítica APT y Distribución (src/lib/apt-analitica): importación, calidad, flujos, traspasos, FIFO,
// permanencia, avance y filtros, con casos sintéticos. Ejecutar: node --test scripts/test-apt-analitica.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')
const XLSX = require('xlsx')
const load = require('./lib/load-ts.cjs')
const N = load('lib/apt-analitica/normalize.ts')
const W = load('lib/apt-analitica/workbook.ts')
const D = load('lib/apt-analitica/dataset.ts')
const C = load('lib/apt-analitica/catalog.ts')
const E = load('lib/apt-analitica/engine.ts')
const Q = load('lib/apt-analitica/quality.ts')
const S = load('lib/apt-analitica/stats.ts')
const { EMPTY_FILTERS } = load('lib/apt-analitica/types.ts')

const CAT = { areas: C.DEFAULT_AREAS, classes: {} }
let nextId = 1
/** Movimiento sintético: side E/S, fecha, cantidad positiva */
function mv(side, fecha, qty, o = {}) {
  return D.fromNorm({ side, tipo: o.tipo ?? (side === 'E' ? 'P/E PRODUCCION ACT.' : 'DESPACHO VENTAS'), bodegaRaw: o.bodega ?? '647-04  ALM PT',
    bodega: N.bodegaKey(o.bodega ?? '647-04  ALM PT'), numero: o.numero ?? `D${nextId}`, fecha, producto: o.producto ?? 'P1', cantidad: side === 'E' ? qty : -qty,
    unidad: o.unidad ?? 'UND', lote: o.lote === undefined ? 'L1' : o.lote, docRel: o.docRel ?? null, numRel: o.numRel ?? null, contrato: o.contrato ?? null,
    razonSocial: o.cliente ?? null, refFecha: o.refFecha ?? null, pesoUnitario: o.peso ?? null },
  { id: o.id ?? nextId++, importId: 'i1', sheet: 'H', row: nextId, status: o.status ?? 'ACEPTADO', reasons: [], dup: o.dup ?? 1 }, CAT)
}
const fifoOf = (ms, openings = [], order = 'ENTRADAS_PRIMERO', upTo = null) => E.runFifo(ms.filter(E.isAccepted), openings, { sameDayOrder: order }, upTo)

const HEAD = ['', 'TipoDocto', 'Bodega', 'Numero', 'Fecha', 'CodLegal', 'RazonSocial', 'Producto', 'GLOSA', 'Cantidad', 'UNIDAD', 'DocRel', 'NumRel',
  'FechaEntrega', 'Contrato', 'RefTipoDocto', 'RefCorrelativo', 'RefNumero', 'RefFecha', 'Lote', 'Color', 'Comentario', 'PesoUnitario',
  'PesoTotalxProducir', 'PesoTotalProduccido', 'CCostoJRM']
function book(aoa) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa, { cellDates: true }), 'Hoja1')
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
}
const line = (o = {}) => {
  const v = (k, d) => (k in o ? o[k] : d)
  return [null, v('tipo', 'DESPACHO VENTAS'), v('bodega', 'ST-VENTAS-IMD'), v('numero', 'ND98-00000800'), v('fecha', new Date(2026, 9, 9)),
    20263322496, 'NESTLE PERU S A', v('producto', '00605.02.909'), 'BARRA', v('cantidad', -22), 'UND', 'CONTRATO DE VENTAS', '16339-S001', null, null, null, 0, 0,
    v('refFecha', new Date(2020, 2, 22)), v('lote', '016339-S001'), null, null, 0, 0, 0, null]
}

// ---------------------------------------------------------------------------------------------------------------
test('importación: ignora la columna inicial vacía, conserva identificadores como texto y convierte fechas', () => {
  const p = W.parseWorkbook(book([HEAD, line(), line({ fecha: 46304, numero: 'ND98-00000801' }), line({ fecha: '10/10/2026', numero: 'ND98-00000802' })]), 'SALIDAS', { today: '2026-10-21' })
  assert.equal(p.sheets.length, 1)
  const s = p.sheets[0]
  assert.equal(s.header.columns[0].ignored, 'vacia')
  assert.equal(s.counts.ACEPTADO, 3)
  const [a, b, c] = s.rows
  assert.equal(a.norm.producto, '00605.02.909')
  assert.equal(a.norm.lote, '016339-S001')
  assert.equal(a.norm.fecha, '2026-10-09')
  assert.equal(b.norm.fecha, '2026-10-09', 'fecha serial de Excel')
  assert.equal(c.norm.fecha, '2026-10-10', 'fecha de texto dd/mm/aaaa')
  assert.equal(a.norm.side, 'S')
  assert.equal(a.norm.cantidad, -22)
  assert.equal(a.raw.Bodega, 'ST-VENTAS-IMD', 'la fila original se conserva')
  assert.equal(s.periodFrom, '2026-10-09')
  assert.equal(s.periodTo, '2026-10-10')
})

test('importación: rechaza obligatorios y fechas inválidas, revisa signos y cantidad cero, sin convertir vacíos en cero', () => {
  const p = W.parseWorkbook(book([HEAD,
    line({ producto: null }),
    line({ fecha: 'mañana' }),
    line({ fecha: new Date(1990, 0, 1) }),
    line({ cantidad: 5 }),
    line({ cantidad: 0 }),
    line({ cantidad: 'abc' }),
  ]), 'SALIDAS', { today: '2026-10-21' })
  const r = p.sheets[0].rows
  assert.equal(r[0].status, 'RECHAZADO'); assert.match(r[0].reasons.join(), /Falta Producto/)
  assert.equal(r[1].status, 'RECHAZADO'); assert.match(r[1].reasons.join(), /Fecha no válida/)
  assert.equal(r[2].status, 'RECHAZADO'); assert.match(r[2].reasons.join(), /fuera de rango/)
  assert.equal(r[3].status, 'REVISION'); assert.match(r[3].reasons.join(), /positiva en un archivo de Salidas/)
  assert.equal(r[4].status, 'REVISION'); assert.match(r[4].reasons.join(), /Cantidad cero/)
  assert.equal(r[5].status, 'RECHAZADO')
  assert.equal(r[3].norm.fechaEntrega, null, 'FechaEntrega vacía queda sin dato')
})

test('duplicados aparentes: las líneas idénticas del archivo se conservan y se numeran; la huella no depende de la fila', () => {
  const p = W.parseWorkbook(book([HEAD, line(), line(), line({ numero: 'ND98-1' })]), 'SALIDAS', { today: '2026-10-21' })
  const r = p.sheets[0].rows
  assert.equal(r.length, 3)
  assert.deepEqual(r.map(x => x.status), ['ACEPTADO', 'ACEPTADO', 'ACEPTADO'])
  assert.deepEqual(r.map(x => x.dup), [1, 2, 1])
  assert.equal(r[0].fingerprint, r[1].fingerprint)
  assert.notEqual(r[0].fingerprint, r[2].fingerprint)
  const ms = D.rowsToMovements(r, 'i', CAT)
  const issues = Q.qualityIssues({ all: ms, accepted: ms, transfers: [], fifo: fifoOf(ms), defaultRefDate: '2020-03-22', unconfirmedAreas: [], today: '2026-10-21', hasOpenings: false })
  assert.equal(issues.find(i => i.code === 'LINEAS_IDENTICAS').count, 1)
  assert.equal(E.flowsByUnit(ms)[0].lineasS, 3, 'las tres líneas cuentan hasta que una regla confirme la duplicación')
})

test('FIFO: salida parcial con múltiples entradas, sin reutilizar entradas y con remanente', () => {
  const e1 = mv('E', '2026-10-01', 10), e2 = mv('E', '2026-10-03', 10)
  const s1 = mv('S', '2026-10-04', 15), s2 = mv('S', '2026-10-06', 3)
  const f = fifoOf([e1, e2, s1, s2])
  assert.deepEqual(f.byExit.get(s1.id).map(a => [a.entryId, a.qty, a.days]), [[e1.id, 10, 3], [e2.id, 5, 1]])
  assert.deepEqual(f.byExit.get(s2.id).map(a => [a.entryId, a.qty, a.days]), [[e2.id, 3, 3]])
  assert.equal(f.openByEntry.get(e2.id), 2)
  assert.equal(f.openByEntry.has(e1.id), false)
  const d = E.dwellOfExits([s1, s2], f, [0, 1, 3])
  assert.equal(d.linkedQty, 18)
  assert.ok(Math.abs(d.summary.mean - (10 * 3 + 5 * 1 + 3 * 3) / 18) < 1e-9, 'media ponderada por cantidad')
  assert.equal(d.summary.median, 3)
  const age = E.openStockAge(f, new Map([[e2.id, e2]]), () => true, [0, 7])
  assert.equal(age.openQty, 2)
})

test('FIFO: misma fecha — entradas antes que salidas (o al revés según la hipótesis) y cero días no se convierte en horas', () => {
  const e = mv('E', '2026-10-05', 5), s = mv('S', '2026-10-05', 5)
  const a = fifoOf([s, e])
  assert.equal(a.byExit.get(s.id)[0].days, 0)
  assert.equal(E.dwellOfExits([s], a, [0]).summary.sameDay, 1)
  const b = fifoOf([s, e], [], 'SALIDAS_PRIMERO')
  assert.equal(b.byExit.has(s.id), false)
  assert.equal(b.unmatchedByExit.get(s.id), 5, 'con salidas primero, la salida no tiene entrada observable')
})

test('FIFO: lotes vacíos se excluyen; cambio de lote en traspaso no se enlaza; sin saldo inicial queda sin entrada observable', () => {
  const noLot = mv('S', '2026-10-02', 4, { lote: null })
  const e = mv('E', '2026-10-01', 4, { lote: 'A' })
  const s = mv('S', '2026-10-02', 4, { lote: 'B' })
  const f = fifoOf([noLot, e, s])
  assert.ok(f.emptyLotIds.has(noLot.id))
  assert.equal(f.unmatchedByExit.get(s.id), 4, 'otro lote: no se compensa')
  const d = E.dwellOfExits([noLot, s], f, [0])
  assert.equal(d.emptyLotQty, 4)
  assert.equal(d.linkedShare, 0)
  const defs = E.deficits([noLot, e, s].filter(E.isAccepted), [], { sameDayOrder: 'ENTRADAS_PRIMERO' }, null)
  assert.deepEqual(defs.map(x => [x.lote, x.minBalance]).sort(), [[null, -4], ['B', -4]], 'déficit por producto–lote–bodega–unidad, sin compensar')
})

test('saldo inicial: con foto de corte el FIFO arranca del saldo y el inventario final se calcula; sin ella no está disponible', () => {
  const s = mv('S', '2026-10-10', 6)
  const e = mv('E', '2026-10-11', 2)
  const scope = [s, e]
  const no = E.inventoryFinal(scope, [], 'UND', '2026-10-09', [])
  assert.equal(no.available, false)
  const ob = [{ bodega: '647-04 ALM PT', producto: 'P1', lote: 'L1', unidad: 'UND', cantidad: 10, cutoff: '2026-10-08' }]
  const yes = E.inventoryFinal(scope, ob, 'UND', '2026-10-09', [])
  assert.equal(yes.available, true)
  assert.equal(yes.final, 6)
  const f = fifoOf(scope, ob)
  assert.equal(f.byExit.get(s.id)[0].entryId, null, 'consume el saldo inicial')
  assert.equal(f.byExit.get(s.id)[0].days, null, 'sin fecha de ingreso: no entra en la media de permanencia')
  assert.equal(E.dwellOfExits([s], f, [0]).openingLinkedQty, 6)
})

test('unidades incompatibles no se suman; la conversión exige equivalencia verificada', () => {
  const a = mv('E', '2026-10-01', 10, { unidad: 'UND' }), b = mv('E', '2026-10-01', 2.5, { unidad: 'CIEN' })
  const flows = E.flowsByUnit([a, b])
  assert.deepEqual(flows.map(u => [u.unidad, u.entradas]).sort(), [['CIEN', 2.5], ['UND', 10]])
  assert.equal(E.convertQty(b, 'UND', [{ producto: null, fromUnit: 'CIEN', toUnit: 'UND', factor: 100, verified: false }]), null)
  assert.equal(E.convertQty(b, 'UND', [{ producto: null, fromUnit: 'CIEN', toUnit: 'UND', factor: 100, verified: true }]), 250)
})

test('traspasos: claves conciliadas, diferencias, un solo lado y cambio de lote', () => {
  const T = { tipo: 'TRASPASO DE ALMACEN APT', numero: 'T1', producto: 'P9' }
  const ms = [
    mv('S', '2026-10-02', 10, { ...T, bodega: '647-04  ALM PT', lote: 'A' }), mv('E', '2026-10-02', 10, { ...T, bodega: 'ST-VENTAS-IMD', lote: 'A' }),
    mv('S', '2026-10-02', 5, { ...T, numero: 'T2', bodega: '647-04  ALM PT', lote: 'A' }), mv('E', '2026-10-02', 5, { ...T, numero: 'T2', bodega: 'ST-VENTAS-IMD', lote: 'X-S001' }),
    mv('S', '2026-10-02', 7, { ...T, numero: 'T3' }), mv('E', '2026-10-02', 6, { ...T, numero: 'T3', bodega: 'ST-VENTAS-IMD' }),
    mv('S', '2026-10-02', 1, { ...T, numero: 'T4' }),
  ]
  const tr = E.reconcileTransfers(ms)
  const by = Object.fromEntries(tr.map(t => [t.numero, t]))
  assert.equal(by.T1.status, 'CONCILIADA'); assert.equal(by.T1.lotChange, false)
  assert.equal(by.T2.status, 'CONCILIADA'); assert.equal(by.T2.lotChange, true)
  assert.equal(by.T3.status, 'DIFERENCIA')
  assert.equal(by.T4.status, 'SOLO_SALIDA')
  assert.equal(ms[0].clase, 'TRASPASO')
  assert.equal(ms[1].area, 'DIST')
})

test('ciclo entre etapas: solo cantidad trazable por traspaso conciliado sin cambio de lote', () => {
  const T = { tipo: 'TRASPASO DE ALMACEN APT', numero: 'T7', producto: 'P7', lote: 'L7' }
  const prod = mv('E', '2026-10-01', 10, { producto: 'P7', lote: 'L7' })
  const tS = mv('S', '2026-10-03', 10, { ...T })
  const tE = mv('E', '2026-10-03', 10, { ...T, bodega: 'ST-VENTAS-IMD' })
  const desp = mv('S', '2026-10-05', 4, { producto: 'P7', lote: 'L7', bodega: 'ST-VENTAS-IMD' })
  const ms = [prod, tS, tE, desp]
  const f = fifoOf(ms)
  const c = E.stageCycle([desp], f, E.reconcileTransfers(ms), new Map(ms.map(m => [m.id, m])), 'APT')
  assert.equal(c.tracedQty, 4)
  assert.equal(c.summary.mean, 4, '4 días desde el ingreso a APT hasta el despacho (no la suma de medias por etapa)')
})

test('avance: relación de flujos, salida de cohorte y denominador cero = no disponible', () => {
  const e = mv('E', '2026-10-01', 10), s = mv('S', '2026-10-02', 4)
  const f = fifoOf([e, s])
  const c = E.cohortExit([e], f)
  assert.equal(c.share, 0.4)
  assert.equal(S.ratio(4, 0), null)
  assert.equal(S.ratio(null, 5), null)
  assert.equal(E.cohortExit([], f).share, null)
  assert.equal(S.weightedMean([]), null)
})

test('cumplimiento comercial: por pedido, línea y unidad; devoluciones, cancelaciones, sobreentrega y líneas pendientes', () => {
  const d1 = mv('S', '2026-10-02', 8, { numero: 'G1', producto: 'A' })
  const d2 = mv('S', '2026-10-03', 6, { numero: 'G1', producto: 'B' })
  const dev = mv('E', '2026-10-04', 1, { numero: 'G1', producto: 'A', tipo: 'G/DEV INDIRECTO' })
  const commitments = [
    { pedido: 'P1', linea: '1', producto: 'A', unidad: 'UND', cantidad: 5, fechaCompromiso: null, version: 1, estado: 'VIGENTE' },
    { pedido: 'P1', linea: '1', producto: 'A', unidad: 'UND', cantidad: 6, fechaCompromiso: null, version: 2, estado: 'VIGENTE' },
    { pedido: 'P1', linea: '2', producto: 'B', unidad: 'UND', cantidad: 10, fechaCompromiso: null, version: 1, estado: 'VIGENTE' },
    { pedido: 'P1', linea: '3', producto: 'C', unidad: 'UND', cantidad: 3, fechaCompromiso: null, version: 1, estado: 'CANCELADO' },
  ]
  const links = [{ id: 'k', fromKind: 'PEDIDO', fromRef: 'P1', toKind: 'DESPACHO', toRef: 'G1', qty: null, unidad: null, origin: 'MANUAL', note: null, status: 'VIGENTE' }]
  const r = E.commercialProgress(commitments, [d1, d2, dev], links, [])
  const l1 = r.lines.find(l => l.linea === '1'), l2 = r.lines.find(l => l.linea === '2')
  assert.equal(r.lines.length, 2, 'la línea cancelada sale del denominador')
  assert.equal(l1.comprometido, 6, 'versión vigente del compromiso')
  assert.ok(Math.abs(l1.avanceDespacho - 7 / 6) < 1e-9, 'sobreentrega visible (> 100 %)')
  assert.equal(l1.exceso, 1)
  assert.equal(l2.pendiente, 4)
  assert.equal(r.orders[0].completo, false, 'no se completa por una suma global: tiene una línea pendiente')
  assert.equal(l1.avanceEntrega, null, 'sin recepciones no hay avance de entrega')
  assert.equal(E.commercialProgress([], [d1], [], []).available, false)
})

test('filtros: los totales filtrados reconcilian con el total y los movimientos en revisión no cuentan', () => {
  const ms = [mv('E', '2026-10-01', 10, { cliente: 'A' }), mv('E', '2026-10-02', 5, { cliente: 'B' }), mv('S', '2026-10-03', 3, { cliente: 'A' }),
    mv('E', '2026-10-03', 99, { cliente: 'A', status: 'REVISION' }), mv('E', '2026-10-09', 7, { cliente: 'A', bodega: 'ST-VENTAS-IMD' })]
  const acc = ms.filter(E.isAccepted)
  const total = E.flowsByUnit(acc)[0]
  const fa = E.flowsByUnit(acc.filter(m => E.matchesFilters(m, { ...EMPTY_FILTERS, clientes: ['A'] })))[0]
  const fb = E.flowsByUnit(acc.filter(m => E.matchesFilters(m, { ...EMPTY_FILTERS, clientes: ['B'] })))[0]
  assert.equal(fa.entradas + fb.entradas, total.entradas)
  assert.equal(total.entradas, 22, 'la fila en revisión no suma')
  const byDate = acc.filter(m => E.matchesFilters(m, { ...EMPTY_FILTERS, from: '2026-10-02', to: '2026-10-03' }))
  assert.equal(byDate.length, 2)
  const byArea = acc.filter(m => E.matchesFilters(m, { ...EMPTY_FILTERS, areas: ['DIST'] }))
  assert.equal(byArea.length, 1)
  const series = E.dailySeries(acc, 'UND', null, null)
  assert.equal(series.at(-1).acumulada, total.neta, 'la variación acumulada cierra con la variación del período')
})

test('estadística ponderada: mediana, percentiles y rangos de antigüedad', () => {
  const pts = [{ value: 0, weight: 50 }, { value: 2, weight: 30 }, { value: 10, weight: 20 }]
  assert.equal(S.weightedQuantile(pts, 0.5), 0)
  assert.equal(S.weightedQuantile(pts, 0.9), 10)
  assert.ok(Math.abs(S.weightedMean(pts) - 2.6) < 1e-9)
  const b = S.bucketize(pts, [0, 1, 3, 7])
  assert.deepEqual(b.map(x => [x.label, x.weight]), [['0 d', 50], ['1–2 d', 30], ['3–6 d', 0], ['≥ 7 d', 20]])
})

test('calidad: ERROR DE CONTRATO, RefFecha predeterminada, pesos y nombres de bodega', () => {
  const ms = [mv('S', '2026-10-01', 1, { docRel: 'ERROR DE CONTRATO', refFecha: '2020-03-22', peso: 0 }), mv('S', '2026-10-01', 1, { docRel: 'CONTRATO DE VENTAS', numRel: '16339' })]
  const issues = Q.qualityIssues({ all: ms, accepted: ms, transfers: [], fifo: fifoOf(ms), defaultRefDate: '2020-03-22', unconfirmedAreas: ['ST-VENTAS-IMD'], today: '2026-10-21', hasOpenings: false })
  const codes = issues.map(i => i.code)
  for (const c of ['ERROR_CONTRATO', 'REFFECHA_PREDETERMINADA', 'PESO_CERO', 'BODEGA_NOMBRES', 'AREA_PENDIENTE', 'SIN_SALDO_INICIAL', 'SALIDA_SIN_ENTRADA']) assert.ok(codes.includes(c), c)
  assert.equal(C.comercialRef(ms[0]), null)
  assert.equal(C.comercialRef(ms[1]), '16339')
  assert.equal(C.ordenRef({ docRel: 'ORDEN DE PRODUCCION', numRel: '2893-002' }), '2893-002')
})

test('importaciones repetidas y períodos superpuestos: la huella del contenido es estable', () => {
  const r1 = W.parseWorkbook(book([HEAD, line()]), 'SALIDAS', { today: '2026-10-21' }).sheets[0].rows[0]
  const r2 = W.parseWorkbook(book([HEAD, line({ numero: 'ND98-00000800' })]), 'SALIDAS', { today: '2026-10-21' }).sheets[0].rows[0]
  assert.equal(r1.fingerprint, r2.fingerprint, 'misma línea en otra carga → misma huella (la base la marca para revisión)')
  assert.equal(N.excelSerialToIso(46304), '2026-10-09')
  assert.equal(N.excelSerialToIso(61), '1900-03-01')
})
