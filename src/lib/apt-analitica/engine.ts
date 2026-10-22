import type { Area, Commitment, Filters, Link, Movement, OpeningBalance, Receipt, Settings, UnitConversion } from './types'
import { comercialRef, hasErrorContrato, ordenRef } from './catalog'
import { daysBetween } from './normalize'
import { bucketize, ratio, summarize, type WeightedPoint } from './stats'

// Motor de cálculo. Funciones puras sobre los movimientos normalizados. Reglas:
//  - Solo cuentan los movimientos ACEPTADOS de cargas vigentes (los EN REVISIÓN, RECHAZADOS y DESCARTADOS no).
//  - Nunca se suman unidades distintas: todo resultado de cantidad va por unidad.
//  - Sin denominador (ausente o cero) el resultado es null («no disponible»), nunca cero.
//  - La permanencia FIFO es una estimación: depende del orden supuesto dentro de una misma fecha y de la historia cargada.

export interface Dataset {
  movements: Movement[]
  openings: OpeningBalance[]
  links: Link[]
  commitments: Commitment[]
  receipts: Receipt[]
  conversions: UnitConversion[]
  settings: Settings
}

const EPS = 1e-9
export const isAccepted = (m: Movement) => m.status === 'ACEPTADO'
export const hasLot = (m: Movement) => !!m.lote && m.lote.trim() !== ''

// ---------------------------------------------------------------------------------------------------------------
// Filtros
// ---------------------------------------------------------------------------------------------------------------
export function matchesFilters(m: Movement, f: Filters, opt: { ignoreDate?: boolean; ignoreUnit?: boolean } = {}): boolean {
  if (!opt.ignoreDate) {
    if (f.from && m.fecha < f.from) return false
    if (f.to && m.fecha > f.to) return false
  }
  if (!opt.ignoreUnit && f.unidad && m.unidad !== f.unidad) return false
  if (f.areas.length && (!m.area || !f.areas.includes(m.area))) return false
  if (f.bodegas.length && !f.bodegas.includes(m.bodega)) return false
  if (f.clientes.length && (!m.razonSocial || !f.clientes.includes(m.razonSocial))) return false
  if (f.productos.length && !f.productos.includes(m.producto)) return false
  if (f.lotes.length && (!m.lote || !f.lotes.includes(m.lote))) return false
  if (f.otop.length) { const o = ordenRef(m); if (!o || !f.otop.includes(o)) return false }
  if (f.contratos.length) {
    const c = comercialRef(m)
    if (!((m.contrato && f.contratos.includes(m.contrato)) || (c && f.contratos.includes(c)))) return false
  }
  if (f.documentos.length && (!m.numero || !f.documentos.includes(m.numero))) return false
  if (f.text) {
    const q = f.text.trim().toUpperCase()
    if (q && ![m.numero, m.producto, m.glosa, m.lote, m.numRel, m.contrato, m.razonSocial, m.tipo, m.bodega].some(v => v && v.toUpperCase().includes(q))) return false
  }
  return true
}

/** ¿La consulta limita la población (además de fechas y unidad)? Sirve para advertir que un resultado es parcial. */
export const hasDimensionFilters = (f: Filters) => !!(f.areas.length || f.bodegas.length || f.clientes.length || f.productos.length
  || f.lotes.length || f.otop.length || f.contratos.length || f.documentos.length || f.text.trim())

// ---------------------------------------------------------------------------------------------------------------
// Flujos y variación
// ---------------------------------------------------------------------------------------------------------------
export interface UnitFlow { unidad: string; entradas: number; salidas: number; neta: number; lineasE: number; lineasS: number }

export function flowsByUnit(movs: Movement[]): UnitFlow[] {
  const map = new Map<string, UnitFlow>()
  for (const m of movs) {
    let u = map.get(m.unidad)
    if (!u) { u = { unidad: m.unidad, entradas: 0, salidas: 0, neta: 0, lineasE: 0, lineasS: 0 }; map.set(m.unidad, u) }
    if (m.side === 'E') { u.entradas += m.qty; u.lineasE++ } else { u.salidas += m.qty; u.lineasS++ }
  }
  for (const u of map.values()) u.neta = u.entradas - u.salidas
  return [...map.values()].sort((a, b) => (b.lineasE + b.lineasS) - (a.lineasE + a.lineasS))
}

export interface GroupFlow { key: string; label: string; entradas: number; salidas: number; neta: number; lineas: number; ids: number[] }

/** Entradas, salidas y variación por una dimensión, en UNA unidad */
export function flowsBy(movs: Movement[], unidad: string, keyOf: (m: Movement) => string | null, labelOf?: (m: Movement) => string): GroupFlow[] {
  const map = new Map<string, GroupFlow>()
  for (const m of movs) {
    if (m.unidad !== unidad) continue
    const k = keyOf(m) ?? '(sin dato)'
    let g = map.get(k)
    if (!g) { g = { key: k, label: labelOf ? labelOf(m) : k, entradas: 0, salidas: 0, neta: 0, lineas: 0, ids: [] }; map.set(k, g) }
    if (m.side === 'E') g.entradas += m.qty; else g.salidas += m.qty
    g.lineas++
    g.ids.push(m.id)
  }
  for (const g of map.values()) g.neta = g.entradas - g.salidas
  return [...map.values()]
}

export interface DayPoint { fecha: string; entradas: number; salidas: number; neta: number; acumulada: number }

/** Serie diaria en una unidad. Los días sin movimientos dentro del rango cubierto valen 0 (hubo carga y no hubo movimiento). */
export function dailySeries(movs: Movement[], unidad: string, from: string | null, to: string | null): DayPoint[] {
  const by = new Map<string, { e: number; s: number }>()
  let min: string | null = null, max: string | null = null
  for (const m of movs) {
    if (m.unidad !== unidad) continue
    const d = by.get(m.fecha) ?? { e: 0, s: 0 }
    if (m.side === 'E') d.e += m.qty; else d.s += m.qty
    by.set(m.fecha, d)
    if (!min || m.fecha < min) min = m.fecha
    if (!max || m.fecha > max) max = m.fecha
  }
  const start = from && min ? (from > min ? from : min) : min
  const end = to && max ? (to < max ? to : max) : max
  if (!start || !end) return []
  const out: DayPoint[] = []
  let acc = 0
  for (let d = start; d <= end; d = nextDay(d)) {
    const v = by.get(d) ?? { e: 0, s: 0 }
    acc += v.e - v.s
    out.push({ fecha: d, entradas: v.e, salidas: v.s, neta: v.e - v.s, acumulada: acc })
    if (out.length > 4000) break
  }
  return out
}
const nextDay = (d: string) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10) }

/** Inventario final = saldo inicial + entradas − salidas. Solo si hay saldo inicial para TODAS las bodegas del alcance. */
export function inventoryFinal(scope: Movement[], openings: OpeningBalance[], unidad: string, from: string | null, bodegas: string[]):
  { available: false; reason: string } | { available: true; inicial: number; entradas: number; salidas: number; final: number; cutoff: string } {
  const bods = bodegas.length ? bodegas : [...new Set(scope.map(m => m.bodega))]
  if (!bods.length) return { available: false, reason: 'No hay movimientos en el alcance.' }
  const ob = openings.filter(o => o.unidad === unidad && bods.includes(o.bodega))
  const missing = bods.filter(b => !ob.some(o => o.bodega === b))
  if (missing.length) return { available: false, reason: `Falta el saldo inicial de ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` y ${missing.length - 3} más` : ''}: se muestra solo la variación del período.` }
  const cutoff = ob.map(o => o.cutoff).sort().at(-1)!
  if (ob.some(o => o.cutoff !== cutoff)) return { available: false, reason: 'Los saldos iniciales tienen fechas de corte distintas.' }
  if (from && from <= cutoff) return { available: false, reason: `El período empieza el ${from} y el saldo inicial es al ${cutoff}: elija un inicio posterior al corte.` }
  const inicial = ob.reduce((s, o) => s + o.cantidad, 0)
  let e = 0, s = 0
  for (const m of scope) { if (m.unidad !== unidad || m.fecha <= cutoff) continue; if (m.side === 'E') e += m.qty; else s += m.qty }
  return { available: true, inicial, entradas: e, salidas: s, final: inicial + e - s, cutoff }
}

// ---------------------------------------------------------------------------------------------------------------
// Conciliación de traspasos: clave = tipo + número + fecha + producto + unidad
// ---------------------------------------------------------------------------------------------------------------
export type TransferStatus = 'CONCILIADA' | 'DIFERENCIA' | 'SOLO_SALIDA' | 'SOLO_ENTRADA'
export interface TransferKey {
  key: string; tipo: string; numero: string; fecha: string; producto: string; unidad: string
  qtyS: number; qtyE: number; lotsS: string[]; lotsE: string[]; bodegasS: string[]; bodegasE: string[]
  areasS: Array<Area | null>; areasE: Array<Area | null>
  status: TransferStatus; lotChange: boolean; ids: number[]
}

export function transferKeyOf(m: Movement) { return [m.tipo, m.numero ?? '', m.fecha, m.producto, m.unidad].join('\u0001') }

export function reconcileTransfers(accepted: Movement[]): TransferKey[] {
  const map = new Map<string, TransferKey & { _ls: Set<string>; _le: Set<string>; _bs: Set<string>; _be: Set<string> }>()
  for (const m of accepted) {
    if (m.clase !== 'TRASPASO') continue
    const k = transferKeyOf(m)
    let t = map.get(k)
    if (!t) {
      t = { key: k, tipo: m.tipo, numero: m.numero ?? '', fecha: m.fecha, producto: m.producto, unidad: m.unidad, qtyS: 0, qtyE: 0,
        lotsS: [], lotsE: [], bodegasS: [], bodegasE: [], areasS: [], areasE: [], status: 'CONCILIADA', lotChange: false, ids: [],
        _ls: new Set(), _le: new Set(), _bs: new Set(), _be: new Set() }
      map.set(k, t)
    }
    t.ids.push(m.id)
    const lot = m.lote ?? '(sin lote)'
    if (m.side === 'S') { t.qtyS += m.qty; t._ls.add(lot); t._bs.add(m.bodega); if (!t.areasS.includes(m.area)) t.areasS.push(m.area) }
    else { t.qtyE += m.qty; t._le.add(lot); t._be.add(m.bodega); if (!t.areasE.includes(m.area)) t.areasE.push(m.area) }
  }
  const out: TransferKey[] = []
  for (const t of map.values()) {
    const { _ls, _le, _bs, _be, ...rest } = t
    rest.lotsS = [..._ls].sort(); rest.lotsE = [..._le].sort(); rest.bodegasS = [..._bs].sort(); rest.bodegasE = [..._be].sort()
    rest.status = rest.qtyS > EPS && rest.qtyE > EPS ? (Math.abs(rest.qtyS - rest.qtyE) <= 1e-6 ? 'CONCILIADA' : 'DIFERENCIA') : rest.qtyS > EPS ? 'SOLO_SALIDA' : 'SOLO_ENTRADA'
    rest.lotChange = rest.qtyS > EPS && rest.qtyE > EPS && rest.lotsS.join('|') !== rest.lotsE.join('|')
    out.push(rest)
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// FIFO por bodega + producto + lote + unidad
// ---------------------------------------------------------------------------------------------------------------
export interface Allocation { exitId: number; entryId: number | null; qty: number; days: number | null; entryDate: string | null; exitDate: string }
export interface OpenLayer { key: string; entryId: number | null; qty: number; entryDate: string | null; age: number | null }
export interface FifoResult {
  upTo: string | null
  allocations: Allocation[]
  unmatched: Array<{ exitId: number; qty: number }>
  open: OpenLayer[]
  byExit: Map<number, Allocation[]>
  byEntry: Map<number, Allocation[]>
  unmatchedByExit: Map<number, number>
  openByEntry: Map<number, number>
  /** Salidas excluidas por no tener lote */
  emptyLotIds: Set<number>
  /** Movimientos anteriores al corte de un saldo inicial (ya están en el saldo) */
  beforeOpeningIds: Set<number>
  hasOpenings: boolean
  sameDayOrder: Settings['sameDayOrder']
}

export const fifoKey = (bodega: string, producto: string, lote: string | null, unidad: string) => [bodega, producto, lote ?? '', unidad].join('\u0001')

export function runFifo(accepted: Movement[], openings: OpeningBalance[], settings: Pick<Settings, 'sameDayOrder'>, upTo: string | null): FifoResult {
  const res: FifoResult = { upTo, allocations: [], unmatched: [], open: [], byExit: new Map(), byEntry: new Map(), unmatchedByExit: new Map(),
    openByEntry: new Map(), emptyLotIds: new Set(), beforeOpeningIds: new Set(), hasOpenings: openings.length > 0, sameDayOrder: settings.sameDayOrder }
  const groups = new Map<string, Movement[]>()
  for (const m of accepted) {
    if (upTo && m.fecha > upTo) continue
    if (!hasLot(m)) { res.emptyLotIds.add(m.id); continue }
    const k = fifoKey(m.bodega, m.producto, m.lote, m.unidad)
    const g = groups.get(k); if (g) g.push(m); else groups.set(k, [m])
  }
  const openingByKey = new Map<string, OpeningBalance>()
  for (const o of openings) if (o.lote) openingByKey.set(fifoKey(o.bodega, o.producto, o.lote, o.unidad), o)
  const firstSide = settings.sameDayOrder === 'SALIDAS_PRIMERO' ? 'S' : 'E'
  const keys = new Set([...groups.keys(), ...openingByKey.keys()])
  for (const k of keys) {
    const list = (groups.get(k) ?? []).slice().sort((a, b) => a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1
      : a.side !== b.side ? (a.side === firstSide ? -1 : 1) : a.id - b.id)
    const queue: Array<{ entryId: number | null; date: string | null; qty: number }> = []
    const ob = openingByKey.get(k)
    if (ob && ob.cantidad > EPS) queue.push({ entryId: null, date: null, qty: ob.cantidad })
    let head = 0
    for (const m of list) {
      if (ob && m.fecha <= ob.cutoff) { res.beforeOpeningIds.add(m.id); continue }
      if (m.side === 'E') { queue.push({ entryId: m.id, date: m.fecha, qty: m.qty }); continue }
      let rem = m.qty
      const allocs: Allocation[] = []
      while (rem > EPS && head < queue.length) {
        const layer = queue[head]
        const take = Math.min(rem, layer.qty)
        const a: Allocation = { exitId: m.id, entryId: layer.entryId, qty: take, days: layer.date ? daysBetween(layer.date, m.fecha) : null, entryDate: layer.date, exitDate: m.fecha }
        allocs.push(a); res.allocations.push(a)
        if (layer.entryId !== null) { const l = res.byEntry.get(layer.entryId); if (l) l.push(a); else res.byEntry.set(layer.entryId, [a]) }
        layer.qty -= take; rem -= take
        if (layer.qty <= EPS) head++
      }
      if (allocs.length) res.byExit.set(m.id, allocs)
      if (rem > EPS) { res.unmatched.push({ exitId: m.id, qty: rem }); res.unmatchedByExit.set(m.id, rem) }
    }
    for (let i = head; i < queue.length; i++) {
      const l = queue[i]
      if (l.qty <= EPS) continue
      res.open.push({ key: k, entryId: l.entryId, qty: l.qty, entryDate: l.date, age: l.date && upTo ? daysBetween(l.date, upTo) : null })
      if (l.entryId !== null) res.openByEntry.set(l.entryId, l.qty)
    }
  }
  return res
}

// ---------------------------------------------------------------------------------------------------------------
// Permanencia (salidas) y antigüedad (remanente)
// ---------------------------------------------------------------------------------------------------------------
export interface DwellResult {
  exitQty: number
  exitWithLotQty: number
  emptyLotQty: number
  linkedQty: number
  openingLinkedQty: number
  unmatchedQty: number
  linkedShare: number | null
  points: WeightedPoint[]
  summary: ReturnType<typeof summarize>
  buckets: ReturnType<typeof bucketize>
  exitIds: number[]
  unmatchedIds: number[]
}

/** Permanencia estimada por FIFO de las salidas del alcance (`exits` ya filtradas), en una unidad */
export function dwellOfExits(exits: Movement[], fifo: FifoResult, bounds: number[]): DwellResult {
  let exitQty = 0, withLot = 0, empty = 0, linked = 0, openingLinked = 0, unmatched = 0
  const points: WeightedPoint[] = []
  const unmatchedIds: number[] = []
  for (const m of exits) {
    if (m.side !== 'S') continue
    exitQty += m.qty
    if (fifo.emptyLotIds.has(m.id)) { empty += m.qty; continue }
    if (fifo.beforeOpeningIds.has(m.id)) continue
    withLot += m.qty
    for (const a of fifo.byExit.get(m.id) ?? []) {
      if (a.days === null) { openingLinked += a.qty; continue }
      linked += a.qty
      points.push({ value: a.days, weight: a.qty })
    }
    const u = fifo.unmatchedByExit.get(m.id)
    if (u) { unmatched += u; unmatchedIds.push(m.id) }
  }
  return { exitQty, exitWithLotQty: withLot, emptyLotQty: empty, linkedQty: linked, openingLinkedQty: openingLinked, unmatchedQty: unmatched,
    linkedShare: ratio(linked + openingLinked, withLot), points, summary: summarize(points), buckets: bucketize(points, bounds),
    exitIds: exits.filter(m => m.side === 'S').map(m => m.id), unmatchedIds }
}

export interface AgeResult { openQty: number; points: WeightedPoint[]; summary: ReturnType<typeof summarize>; buckets: ReturnType<typeof bucketize>; layers: Array<OpenLayer & { movement: Movement | null }>; unknownAgeQty: number }

/** Remanente de entradas observadas (capas abiertas) cuyo movimiento de entrada cumple el filtro */
export function openStockAge(fifo: FifoResult, byId: Map<number, Movement>, keep: (m: Movement) => boolean, bounds: number[]): AgeResult {
  const points: WeightedPoint[] = []
  const layers: AgeResult['layers'] = []
  let openQty = 0, unknown = 0
  for (const l of fifo.open) {
    const m = l.entryId !== null ? byId.get(l.entryId) ?? null : null
    if (!m || !keep(m)) continue
    openQty += l.qty
    layers.push({ ...l, movement: m })
    if (l.age === null) unknown += l.qty; else points.push({ value: l.age, weight: l.qty })
  }
  return { openQty, points, summary: summarize(points), buckets: bucketize(points, bounds), layers, unknownAgeQty: unknown }
}

/** Salida de cohorte: de las entradas del período (con lote), qué cantidad ya fue asignada a salidas */
export function cohortExit(entries: Movement[], fifo: FifoResult) {
  let eligible = 0, assigned = 0
  const ids: number[] = []
  for (const m of entries) {
    if (m.side !== 'E' || fifo.emptyLotIds.has(m.id) || fifo.beforeOpeningIds.has(m.id)) continue
    eligible += m.qty
    ids.push(m.id)
    for (const a of fifo.byEntry.get(m.id) ?? []) assigned += a.qty
  }
  return { eligible, assigned, share: ratio(assigned, eligible), ids }
}

// ---------------------------------------------------------------------------------------------------------------
// Ciclo completo entre etapas (p. ej. APT principal → Distribución → despacho), solo con cantidades trazables
// ---------------------------------------------------------------------------------------------------------------
/**
 * Para cada salida final (p. ej. despacho de Distribución) se sigue su capa FIFO hasta la entrada por traspaso y, por la
 * clave del traspaso conciliada y sin cambio de lote, hasta las capas FIFO de la bodega de origen. Solo cuenta la cantidad
 * trazable en todas las etapas; los días son desde la entrada a la primera etapa hasta la salida final.
 */
export function stageCycle(finalExits: Movement[], fifo: FifoResult, transfers: TransferKey[], byId: Map<number, Movement>, originArea: Area) {
  const tByKey = new Map(transfers.map(t => [t.key, t]))
  const exitsByKey = new Map<string, Movement[]>()
  for (const t of transfers) {
    if (t.status !== 'CONCILIADA' || t.lotChange) continue
    const list: Movement[] = []
    for (const id of t.ids) { const m = byId.get(id); if (m && m.side === 'S' && m.area === originArea) list.push(m) }
    if (list.length) exitsByKey.set(t.key, list)
  }
  const points: WeightedPoint[] = []
  let finalQty = 0, traced = 0
  for (const d of finalExits) {
    if (d.side !== 'S') continue
    finalQty += d.qty
    for (const a of fifo.byExit.get(d.id) ?? []) {
      if (a.entryId === null) continue
      const entry = byId.get(a.entryId)
      if (!entry || entry.clase !== 'TRASPASO') continue
      const tk = transferKeyOf(entry)
      const t = tByKey.get(tk)
      const originExits = exitsByKey.get(tk)
      if (!t || !originExits) continue
      // La cantidad de la capa se reparte en proporción a lo que cada salida de origen tiene asignado por FIFO
      for (const ox of originExits) {
        for (const oa of fifo.byExit.get(ox.id) ?? []) {
          if (oa.entryDate === null) continue
          const share = a.qty * (oa.qty / t.qtyS)
          if (share <= EPS) continue
          traced += share
          points.push({ value: daysBetween(oa.entryDate, d.fecha), weight: share })
        }
      }
    }
  }
  return { finalQty, tracedQty: traced, share: ratio(traced, finalQty), points, summary: summarize(points) }
}

// ---------------------------------------------------------------------------------------------------------------
// Déficit acumulado por producto + lote + bodega + unidad (sin compensar entre productos)
// ---------------------------------------------------------------------------------------------------------------
export interface Deficit { key: string; bodega: string; producto: string; lote: string | null; unidad: string; entradas: number; salidas: number; minBalance: number; firstNegative: string; ids: number[] }

export function deficits(accepted: Movement[], openings: OpeningBalance[], settings: Pick<Settings, 'sameDayOrder'>, upTo: string | null): Deficit[] {
  const groups = new Map<string, Movement[]>()
  for (const m of accepted) {
    if (upTo && m.fecha > upTo) continue
    const k = fifoKey(m.bodega, m.producto, m.lote, m.unidad)
    const g = groups.get(k); if (g) g.push(m); else groups.set(k, [m])
  }
  const ob = new Map(openings.map(o => [fifoKey(o.bodega, o.producto, o.lote, o.unidad), o]))
  const firstSide = settings.sameDayOrder === 'SALIDAS_PRIMERO' ? 'S' : 'E'
  const out: Deficit[] = []
  for (const [k, list] of groups) {
    list.sort((a, b) => a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.side !== b.side ? (a.side === firstSide ? -1 : 1) : a.id - b.id)
    const o = ob.get(k)
    let bal = o?.cantidad ?? 0, min = Infinity, first: string | null = null, e = 0, s = 0
    for (const m of list) {
      if (o && m.fecha <= o.cutoff) continue
      if (m.side === 'E') { bal += m.qty; e += m.qty } else { bal -= m.qty; s += m.qty }
      if (bal < min) min = bal
      if (bal < -EPS && !first) first = m.fecha
    }
    if (first) {
      const m0 = list[0]
      out.push({ key: k, bodega: m0.bodega, producto: m0.producto, lote: m0.lote, unidad: m0.unidad, entradas: e, salidas: s, minBalance: min, firstNegative: first, ids: list.map(m => m.id) })
    }
  }
  return out.sort((a, b) => a.minBalance - b.minBalance)
}

// ---------------------------------------------------------------------------------------------------------------
// Avance: relación de flujos, salida de cohorte (arriba) y cumplimiento comercial (por pedido, línea y unidad)
// ---------------------------------------------------------------------------------------------------------------
export interface CommitmentLine {
  pedido: string; linea: string; producto: string; unidad: string; comprometido: number; version: number
  despachado: number; devuelto: number; recibido: number | null; avanceDespacho: number | null; avanceEntrega: number | null
  exceso: number; pendiente: number; fechaCompromiso: string | null; despachoIds: number[]
}
export interface OrderProgress { pedido: string; lineas: number; lineasCompletas: number; completo: boolean; unidades: string[] }

/**
 * Cumplimiento comercial. El despacho de una línea solo se reconoce por un vínculo explícito (tabla de equivalencias)
 * pedido[#línea] → documento de despacho, del mismo producto y unidad. Sin compromisos cargados el resultado no está disponible.
 */
export function commercialProgress(commitments: Commitment[], accepted: Movement[], links: Link[], receipts: Receipt[]) {
  const vigentes = new Map<string, Commitment>()
  for (const c of commitments) {
    const k = `${c.pedido}\u0001${c.linea}`
    const prev = vigentes.get(k)
    if (!prev || c.version > prev.version) vigentes.set(k, c)
  }
  const lines: CommitmentLine[] = []
  const active = links.filter(l => l.status === 'VIGENTE')
  for (const c of vigentes.values()) {
    if (c.estado === 'CANCELADO') continue
    const docs = new Set(active.filter(l => l.toKind === 'DESPACHO' && l.fromKind === 'PEDIDO'
      && (l.fromRef === c.pedido || l.fromRef === `${c.pedido}#${c.linea}`)).map(l => l.toRef))
    let desp = 0, dev = 0
    const ids: number[] = []
    for (const m of accepted) {
      if (!m.numero || !docs.has(m.numero) || m.producto !== c.producto || m.unidad !== c.unidad) continue
      if (m.clase === 'DESPACHO_VENTA' && m.side === 'S') { desp += m.qty; ids.push(m.id) }
      if (m.clase === 'DEVOLUCION' && m.side === 'E') { dev += m.qty; ids.push(m.id) }
    }
    const rec = receipts.filter(r => r.producto === c.producto && r.unidad === c.unidad
      && ((r.pedido === c.pedido && (!r.linea || r.linea === c.linea)) || (!r.pedido && docs.has(r.despacho))))
    const recibido = rec.length ? rec.reduce((s, r) => s + r.aceptada, 0) : null
    const valido = desp - dev
    lines.push({ pedido: c.pedido, linea: c.linea, producto: c.producto, unidad: c.unidad, comprometido: c.cantidad, version: c.version,
      despachado: desp, devuelto: dev, recibido, avanceDespacho: ratio(valido, c.cantidad), avanceEntrega: ratio(recibido, c.cantidad),
      exceso: Math.max(0, valido - c.cantidad), pendiente: Math.max(0, c.cantidad - valido), fechaCompromiso: c.fechaCompromiso, despachoIds: ids })
  }
  const orders = new Map<string, OrderProgress>()
  for (const l of lines) {
    const o = orders.get(l.pedido) ?? { pedido: l.pedido, lineas: 0, lineasCompletas: 0, completo: false, unidades: [] }
    o.lineas++
    if (l.pendiente <= EPS) o.lineasCompletas++
    if (!o.unidades.includes(l.unidad)) o.unidades.push(l.unidad)
    orders.set(l.pedido, o)
  }
  for (const o of orders.values()) o.completo = o.lineas > 0 && o.lineasCompletas === o.lineas
  return { available: lines.length > 0, lines, orders: [...orders.values()] }
}

// ---------------------------------------------------------------------------------------------------------------
// Conversión de unidades (solo equivalencias verificadas)
// ---------------------------------------------------------------------------------------------------------------
export function convertQty(m: Pick<Movement, 'producto' | 'unidad' | 'qty'>, toUnit: string, conversions: UnitConversion[]): number | null {
  if (m.unidad === toUnit) return m.qty
  const c = conversions.find(x => x.verified && x.fromUnit === m.unidad && x.toUnit === toUnit && (x.producto === m.producto))
    ?? conversions.find(x => x.verified && x.fromUnit === m.unidad && x.toUnit === toUnit && x.producto === null)
  return c ? m.qty * c.factor : null
}

// ---------------------------------------------------------------------------------------------------------------
// Utilidades de presentación de dimensiones
// ---------------------------------------------------------------------------------------------------------------
export const dims = {
  ordenRef, comercialRef, hasErrorContrato,
}

/** Pareto: ordena de mayor a menor y agrega el % acumulado */
export function pareto<T extends { value: number }>(rows: T[]): Array<T & { share: number; cumShare: number }> {
  const sorted = rows.filter(r => r.value > EPS).sort((a, b) => b.value - a.value)
  const total = sorted.reduce((s, r) => s + r.value, 0)
  let acc = 0
  return sorted.map(r => { acc += r.value; return { ...r, share: total ? r.value / total : 0, cumShare: total ? acc / total : 0 } })
}
