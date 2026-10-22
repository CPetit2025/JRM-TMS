import type { Area, Filters, Kpi, Movement, Settings } from './types'
import { AREA_LABEL } from './types'
import * as E from './engine'
import { completeness, qualityIssues, type Issue } from './quality'
import { ratio } from './stats'
import { comercialRef } from './catalog'
import { addDays, daysBetween } from './normalize'

// Análisis completo para las pantallas: aplica los filtros globales y arma los indicadores con su definición,
// numerador, denominador, exclusiones, cobertura y registros. El FIFO se calcula sobre toda la historia cargada hasta
// la fecha final del filtro (la permanencia de una salida depende de entradas anteriores al período).

export interface Base {
  all: Movement[]
  accepted: Movement[]
  byId: Map<number, Movement>
  transfers: E.TransferKey[]
  minDate: string | null
  maxDate: string | null
  units: string[]
}

export function buildBase(all: Movement[]): Base {
  const accepted = all.filter(E.isAccepted)
  let min: string | null = null, max: string | null = null
  const units = new Map<string, number>()
  for (const m of accepted) {
    if (!min || m.fecha < min) min = m.fecha
    if (!max || m.fecha > max) max = m.fecha
    units.set(m.unidad, (units.get(m.unidad) ?? 0) + 1)
  }
  return { all, accepted, byId: new Map(all.map(m => [m.id, m])), transfers: E.reconcileTransfers(accepted), minDate: min, maxDate: max,
    units: [...units].sort((a, b) => b[1] - a[1]).map(([u]) => u) }
}

/** Fecha de corte: el final del filtro o la última fecha con datos */
export const cutoffOf = (base: Base, f: Filters) => f.to && base.maxDate ? (f.to < base.maxDate ? f.to : base.maxDate) : base.maxDate

export function chartUnit(scope: Movement[], f: Filters, base: Base): string | null {
  if (f.unidad) return f.unidad
  const c = new Map<string, number>()
  for (const m of scope) c.set(m.unidad, (c.get(m.unidad) ?? 0) + 1)
  return [...c].sort((a, b) => b[1] - a[1])[0]?.[0] ?? base.units[0] ?? null
}

export interface Analysis {
  scope: Movement[]
  scopeAll: Movement[]
  unit: string | null
  cutoff: string | null
  fifo: E.FifoResult
  flows: E.UnitFlow[]
  issues: Issue[]
  kpis: Record<string, Kpi>
  transfersInScope: E.TransferKey[]
}

const fmt = (n: number | null | undefined, d = 0) => n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toLocaleString('es-PE', { maximumFractionDigits: d, minimumFractionDigits: d })

export function analyze(base: Base, fifo: E.FifoResult, f: Filters, s: Settings, opts: { unconfirmedAreas: string[]; hasOpenings: boolean; openings: import('./types').OpeningBalance[]; commitments: import('./types').Commitment[]; links: import('./types').Link[]; receipts: import('./types').Receipt[]; areaScope?: Area[] }): Analysis {
  const ff: Filters = opts.areaScope && !f.areas.length ? { ...f, areas: opts.areaScope } : f
  // Población: bodegas con área. Los traspasos de otras bodegas se leen solo para conciliar y trazar, salvo que el
  // filtro pida esa bodega de forma explícita.
  const inPopulation = (m: Movement) => ff.areas.length > 0 || ff.bodegas.length > 0 || m.area !== null
  const scopeAll = base.all.filter(m => inPopulation(m) && (m.status !== 'ACEPTADO' ? E.matchesFilters({ ...m, fecha: m.fecha || '9999-12-31' }, { ...ff, from: null, to: null }) : E.matchesFilters(m, ff)))
  const scope = scopeAll.filter(E.isAccepted)
  const unit = chartUnit(scope, ff, base)
  const cutoff = cutoffOf(base, ff)
  const flows = E.flowsByUnit(scope)
  const ids = new Set(scope.map(m => m.id))
  const transfersInScope = base.transfers.filter(t => t.ids.some(id => ids.has(id)))
  const issues = qualityIssues({ all: scopeAll, accepted: scope, transfers: transfersInScope, fifo, defaultRefDate: s.defaultRefDate,
    unconfirmedAreas: opts.unconfirmedAreas, today: new Date().toISOString().slice(0, 10), hasOpenings: opts.hasOpenings })
  const kpis: Record<string, Kpi> = {}
  const dmy = (d: string | null | undefined) => d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '—'
  const period = `${dmy(ff.from ?? base.minDate)} a ${dmy(cutoff)}`
  const pending = scopeAll.filter(m => m.status === 'REVISION').length
  const rejected = scopeAll.filter(m => m.status === 'RECHAZADO').length
  const baseExcl = [
    ...(pending ? [`${fmt(pending)} fila(s) en revisión no cuentan`] : []),
    ...(rejected ? [`${fmt(rejected)} fila(s) rechazadas no cuentan`] : []),
  ]
  const u = unit
  const inUnit = u ? scope.filter(m => m.unidad === u) : []
  const otherUnits = flows.filter(x => x.unidad !== u).map(x => x.unidad)
  const unitNote = otherUnits.length ? [`Otras unidades (${otherUnits.join(', ')}) se muestran aparte: no se suman`] : []

  const fl = flows.find(x => x.unidad === u)
  kpis.entradas = {
    code: 'entradas', label: 'Entradas', status: fl ? 'CALCULADO' : 'NO_DISPONIBLE', value: fl?.entradas ?? null, unit: u,
    hint: fl ? `${fmt(fl.lineasE)} líneas · ${period}` : undefined,
    definition: 'Suma de cantidades de movimientos de entrada (Cantidad positiva) aceptados en el alcance filtrado. Incluye producción, traspasos recibidos, compras y devoluciones; el detalle por clase está en APT y Distribución.',
    formula: 'Σ cantidad de entradas', exclusions: [...baseExcl, ...unitNote], recordIds: inUnit.filter(m => m.side === 'E').map(m => m.id), issues: ['EN_REVISION', 'LINEAS_IDENTICAS'],
    missing: fl ? undefined : 'No hay entradas en el alcance.',
  }
  const desp = inUnit.filter(m => m.side === 'S' && m.clase === 'DESPACHO_VENTA')
  const despQty = desp.reduce((a, m) => a + m.qty, 0)
  kpis.despachos = {
    code: 'despachos', label: 'Despachos de ventas', status: desp.length ? 'CALCULADO' : 'NO_DISPONIBLE', value: desp.length ? despQty : null, unit: u,
    hint: desp.length ? `${fmt(desp.length)} líneas · ${fmt(new Set(desp.map(m => m.numero)).size)} documentos` : undefined,
    definition: 'Salidas con TipoDocto clasificado como despacho de ventas. Un despacho no es una entrega: la entrega exige recepción del cliente. Los traspasos y consumos no cuentan.',
    formula: 'Σ cantidad de salidas DESPACHO VENTAS', exclusions: [...baseExcl, 'Traspasos internos, consumos y préstamos no son despachos', ...unitNote], recordIds: desp.map(m => m.id),
    issues: ['REF_COMERCIAL_AUSENTE', 'ERROR_CONTRATO'], missing: desp.length ? undefined : 'No hay despachos de ventas en el alcance.',
  }
  kpis.neta = {
    code: 'neta', label: 'Variación neta', status: fl ? 'CALCULADO' : 'NO_DISPONIBLE', value: fl ? fl.neta : null, unit: u,
    hint: fl ? `Entradas ${fmt(fl.entradas)} − salidas ${fmt(fl.salidas)}` : undefined,
    definition: 'Entradas menos salidas del período. No es el inventario final: para eso hace falta el saldo inicial.',
    formula: 'Variación neta = entradas − salidas', numerator: { label: 'Entradas', value: fl?.entradas ?? null }, denominator: undefined,
    exclusions: [...baseExcl, ...unitNote], recordIds: inUnit.map(m => m.id), issues: ['EN_REVISION'],
  }
  const inv = u ? E.inventoryFinal(scope, opts.openings, u, ff.from, ff.bodegas) : { available: false as const, reason: 'Sin unidad.' }
  kpis.inventario = {
    code: 'inventario', label: 'Inventario final', status: inv.available ? 'CALCULADO' : 'NO_DISPONIBLE', value: inv.available ? inv.final : null, unit: u,
    hint: inv.available ? `Saldo inicial al ${dmy(inv.cutoff)}` : 'Se muestra la variación del período',
    definition: 'Saldo inicial + entradas − salidas (los ajustes son movimientos y ya están incluidos). Solo se calcula si hay saldo inicial de todas las bodegas del alcance.',
    formula: 'Inventario final = saldo inicial + entradas − salidas + ajustes', exclusions: [], recordIds: [], issues: ['SIN_SALDO_INICIAL'],
    missing: inv.available ? undefined : inv.reason,
  }
  const dw = E.dwellOfExits(inUnit, fifo, s.ageBuckets)
  kpis.permanencia = {
    code: 'permanencia', label: 'Permanencia estimada', status: dw.linkedQty > 0 ? 'ESTIMADO' : 'NO_DISPONIBLE', value: dw.summary.mean, unit: 'días',
    hint: dw.linkedQty > 0 ? `Mediana ${fmt(dw.summary.median)} · p90 ${fmt(dw.summary.p90)} · ${fmt((dw.linkedShare ?? 0) * 100, 1)} % enlazado` : undefined,
    definition: `Media de días calendario entre la entrada y la salida, ponderada por cantidad, con asignación FIFO por bodega, producto, lote y unidad. Hipótesis del mismo día: ${s.sameDayOrder === 'ENTRADAS_PRIMERO' ? 'las entradas se registran antes que las salidas' : 'las salidas se registran antes que las entradas'}. Sin saldo inicial la asignación es parcial y puede cambiar al cargar más historia. Cero días significa la misma fecha, no atención inmediata.`,
    formula: 'Σ (cantidad asignada × días) ÷ Σ cantidad asignada',
    numerator: { label: 'Cantidad × días', value: dw.points.reduce((a, p) => a + p.value * p.weight, 0) },
    denominator: { label: `Cantidad enlazada (${u ?? ''})`, value: dw.linkedQty },
    exclusions: [...baseExcl, `Salidas sin lote: ${fmt(dw.emptyLotQty)} ${u ?? ''}`, `Sin entrada observable: ${fmt(dw.unmatchedQty)} ${u ?? ''}`,
      ...(dw.openingLinkedQty ? [`Asignado a saldo inicial (sin fecha de ingreso): ${fmt(dw.openingLinkedQty)}`] : [])],
    coverage: dw.linkedShare, recordIds: dw.exitIds, issues: ['SALIDA_SIN_ENTRADA', 'LOTE_VACIO', 'CAMBIO_LOTE_TRASPASO', 'SIN_SALDO_INICIAL'],
    missing: dw.linkedQty > 0 ? undefined : 'No hay salidas con lote enlazadas a una entrada observada.',
  }
  // Capas abiertas: entradas del alcance por dimensiones (también las anteriores al período que siguen abiertas al corte)
  const keep = (m: Movement) => inPopulation(m) && E.matchesFilters(m, { ...ff, from: null })
  const age = E.openStockAge(fifo, base.byId, m => m.unidad === u && keep(m), s.ageBuckets)
  kpis.abiertas = {
    code: 'abiertas', label: 'Cantidades abiertas', status: age.openQty > 0 ? 'ESTIMADO' : 'NO_DISPONIBLE', value: age.openQty > 0 ? age.openQty : null, unit: u,
    hint: age.openQty > 0 ? `Antigüedad ponderada ${fmt(age.summary.mean, 1)} d al ${dmy(cutoff)}` : undefined,
    definition: 'Remanente de entradas observadas que el FIFO todavía no asignó a una salida, al corte. Es una estimación: sin saldo inicial no incluye el stock previo, y con salidas sin entrada observable puede estar sobrestimado.',
    formula: 'Σ remanente de capas FIFO abiertas', exclusions: [...baseExcl, 'Entradas sin lote (sin FIFO)'], recordIds: age.layers.map(l => l.entryId!).filter(x => x !== null),
    issues: ['LOTE_VACIO', 'SALIDA_SIN_ENTRADA', 'SIN_SALDO_INICIAL'], missing: age.openQty > 0 ? undefined : 'No hay remanente de entradas observadas.',
  }
  const cp = E.commercialProgress(opts.commitments, scope, opts.links, opts.receipts)
  const totalCom = cp.lines.filter(l => l.unidad === u).reduce((a, l) => a + l.comprometido, 0)
  const totalDesp = cp.lines.filter(l => l.unidad === u).reduce((a, l) => a + l.despachado - l.devuelto, 0)
  kpis.comercial = {
    code: 'comercial', label: 'Avance comercial', status: cp.available ? 'CALCULADO' : 'NO_DISPONIBLE', value: cp.available ? ratio(totalDesp, totalCom) : null, unit: '%',
    hint: cp.available ? `${cp.orders.filter(o => o.completo).length} de ${cp.orders.length} pedidos completos` : undefined,
    definition: 'Despacho acumulado válido (despachos − devoluciones) ÷ compromiso vigente, por pedido, línea y unidad. Un pedido está completo solo si todas sus líneas lo están. Las sobreentregas se muestran (> 100 %).',
    formula: 'Avance de despacho = despacho acumulado válido ÷ compromiso vigente', numerator: { label: 'Despachado válido', value: cp.available ? totalDesp : null },
    denominator: { label: 'Comprometido vigente', value: cp.available ? totalCom : null }, exclusions: ['Líneas canceladas', 'Versiones anteriores del compromiso'],
    recordIds: cp.lines.flatMap(l => l.despachoIds), issues: ['REF_COMERCIAL_AUSENTE', 'ERROR_CONTRATO'],
    missing: cp.available ? undefined : 'Faltan los compromisos comerciales (pedido, línea, producto, unidad, cantidad comprometida vigente) y su vínculo con los documentos de despacho. Cárguelos en «Cargas» (tipo Compromisos) y registre los vínculos pedido → despacho.',
  }
  const high = issues.filter(i => i.severity === 'ALTA')
  kpis.incidencias = {
    code: 'incidencias', label: 'Incidencias prioritarias', status: 'CALCULADO', value: high.length, unit: null,
    hint: high.slice(0, 2).map(i => i.title).join(' · ') || 'Sin incidencias de prioridad alta',
    definition: 'Controles de calidad de prioridad alta que afectan resultados del alcance (filas rechazadas o en revisión, salidas sin entrada observable, traspasos sin conciliar, ERROR DE CONTRATO).',
    formula: 'Cantidad de controles con prioridad alta', exclusions: [], recordIds: high.flatMap(i => i.ids), issues: high.map(i => i.code),
  }
  const ent = fl?.entradas ?? null, sal = fl?.salidas ?? null
  kpis.flujo = {
    code: 'flujo', label: 'Relación de flujos', status: ratio(sal, ent) === null ? 'NO_DISPONIBLE' : 'CALCULADO', value: ratio(sal, ent), unit: '%',
    definition: 'Salidas del período ÷ entradas del período. Mide flujo, no avance de pedidos: puede superar 100 % si sale stock previo.',
    formula: 'Salidas del período ÷ entradas del período', numerator: { label: 'Salidas', value: sal }, denominator: { label: 'Entradas', value: ent },
    exclusions: [...baseExcl, ...unitNote], recordIds: inUnit.map(m => m.id), issues: [], missing: ent ? undefined : 'Sin entradas en el período: el denominador es cero.',
  }
  const coh = E.cohortExit(inUnit.filter(m => m.side === 'E'), fifo)
  kpis.cohorte = {
    code: 'cohorte', label: 'Salida de cohorte', status: coh.share === null ? 'NO_DISPONIBLE' : 'ESTIMADO', value: coh.share, unit: '%',
    definition: 'De las entradas con lote del período, qué parte ya fue asignada por FIFO a salidas hasta el corte.',
    formula: 'Cantidad de entradas asignada a salidas ÷ cantidad de entradas elegibles', numerator: { label: 'Asignada', value: coh.assigned },
    denominator: { label: 'Entradas elegibles (con lote)', value: coh.eligible }, exclusions: [...baseExcl, 'Entradas sin lote'], recordIds: coh.ids,
    issues: ['LOTE_VACIO'], missing: coh.share === null ? 'No hay entradas con lote en el período.' : undefined,
  }
  kpis.trazabilidad = {
    code: 'trazabilidad', label: 'Tasa de trazabilidad', status: dw.linkedShare === null ? 'NO_DISPONIBLE' : 'ESTIMADO', value: dw.linkedShare, unit: '%',
    definition: 'Parte de las salidas con lote que el FIFO enlazó con una entrada observada (o con el saldo inicial).',
    formula: 'Cantidad de salidas enlazadas ÷ cantidad de salidas con lote', numerator: { label: 'Enlazada', value: dw.linkedQty + dw.openingLinkedQty },
    denominator: { label: 'Salidas con lote', value: dw.exitWithLotQty }, exclusions: [`Salidas sin lote: ${fmt(dw.emptyLotQty)}`], recordIds: dw.unmatchedIds,
    issues: ['SALIDA_SIN_ENTRADA', 'LOTE_VACIO'],
  }
  const withWeight = scope.filter(m => m.pesoUnitario && m.pesoUnitario > 0).length
  kpis.pesos = {
    code: 'pesos', label: 'Cobertura de pesos', status: scope.length ? 'CALCULADO' : 'NO_DISPONIBLE', value: ratio(withWeight, scope.length), unit: '%',
    definition: 'Líneas aceptadas con peso unitario mayor que cero. Los pesos cero no se usan para convertir a kilos.',
    formula: 'Líneas con peso unitario > 0 ÷ líneas', numerator: { label: 'Con peso', value: withWeight }, denominator: { label: 'Líneas', value: scope.length },
    exclusions: [], recordIds: scope.filter(m => !(m.pesoUnitario && m.pesoUnitario > 0)).map(m => m.id), issues: ['PESO_CERO', 'PESO_INCONSISTENTE'],
  }
  const comp = completeness(scope)
  const avg = comp.length ? comp.reduce((a, c) => a + c.filled, 0) / comp.reduce((a, c) => a + c.total, 0) : null
  kpis.completitud = {
    code: 'completitud', label: 'Completitud de datos', status: scope.length ? 'CALCULADO' : 'NO_DISPONIBLE', value: Number.isFinite(avg as number) ? avg : null, unit: '%',
    definition: `Campos clave informados sobre el total de campos clave (${comp.map(c => c.label).join(', ')}), ponderado por número de líneas.`,
    formula: 'Σ campos informados ÷ Σ campos esperados', exclusions: [], recordIds: [], issues: [],
  }
  return { scope, scopeAll, unit, cutoff, fifo, flows, issues, kpis, transfersInScope }
}

/** Comparación con el período anterior de igual duración, solo si la historia cargada lo cubre por completo */
export function previousPeriod(base: Base, f: Filters): { from: string; to: string } | null {
  if (!f.from || !f.to || !base.minDate) return null
  const len = daysBetween(f.from, f.to) + 1
  const pTo = addDays(f.from, -1), pFrom = addDays(f.from, -len)
  return pFrom >= base.minDate ? { from: pFrom, to: pTo } : null
}

export const areaLabel = (a: Area | null) => a ? AREA_LABEL[a] : 'Sin área'
export { comercialRef }
