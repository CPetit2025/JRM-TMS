'use client'

import { useMemo, useState } from 'react'
import { ordenRef, comercialRef } from '@/lib/apt-analitica/catalog'
import { commercialProgress, dailySeries, dwellOfExits, matchesFilters, openStockAge, pareto, stageCycle, transferKeyOf, type FifoResult } from '@/lib/apt-analitica/engine'
import { summarize, bucketize, ratio, type WeightedPoint } from '@/lib/apt-analitica/stats'
import { daysBetween } from '@/lib/apt-analitica/normalize'
import type { Area, Kpi, Movement } from '@/lib/apt-analitica/types'
import { useAnalitica } from './context'
import { BucketBars, ClassBars, DwellHistogram, FlowBars, Heatmap, OpenScatter, ParetoBars } from './charts'
import { CATEGORICAL, Card, Empty, KpiTile, Notice, Segmented, fmtDate, fmtNum, fmtPct } from './ui'

type Dim = 'lote' | 'producto' | 'orden'
const DIM_LABEL: Record<Dim, string> = { lote: 'Lote', producto: 'Producto', orden: 'Referencia de orden (OT/OP)' }
const keyOf = (m: Movement, d: Dim) => d === 'lote' ? m.lote : d === 'producto' ? m.producto : ordenRef(m)

/** Permanencia por dimensión: salidas del alcance agrupadas, con su asignación FIFO */
function dwellByDim(exits: Movement[], fifo: FifoResult, d: Dim) {
  const groups = new Map<string, { key: string; label: string; ids: number[]; points: WeightedPoint[]; qty: number; unmatched: number; noLot: number }>()
  for (const m of exits) {
    if (m.side !== 'S') continue
    const k = keyOf(m, d) ?? '(sin dato)'
    let g = groups.get(k)
    if (!g) { g = { key: k, label: d === 'producto' && m.glosa ? `${k} · ${m.glosa}` : k, ids: [], points: [], qty: 0, unmatched: 0, noLot: 0 }; groups.set(k, g) }
    g.ids.push(m.id); g.qty += m.qty
    if (fifo.emptyLotIds.has(m.id)) { g.noLot += m.qty; continue }
    for (const a of fifo.byExit.get(m.id) ?? []) if (a.days !== null) g.points.push({ value: a.days, weight: a.qty })
    g.unmatched += fifo.unmatchedByExit.get(m.id) ?? 0
  }
  return [...groups.values()].map(g => ({ ...g, s: summarize(g.points) })).sort((a, b) => b.qty - a.qty)
}

function DwellTable({ exits, fifo, unit }: { exits: Movement[]; fifo: FifoResult; unit: string | null }) {
  const { openDrill } = useAnalitica()
  const [dim, setDim] = useState<Dim>('producto')
  const [limit, setLimit] = useState(25)
  const rows = useMemo(() => dwellByDim(exits, fifo, dim), [exits, fifo, dim])
  return <Card title={`Permanencia por ${DIM_LABEL[dim].toLowerCase()} · ${unit ?? ''}`} subtitle="Media ponderada por cantidad, mediana y p90 (FIFO, días calendario). Lote, producto y orden no se igualan entre sí."
    actions={<Segmented label="Agrupar por" value={dim} onChange={setDim} options={(['lote', 'producto', 'orden'] as Dim[]).map(id => ({ id, label: DIM_LABEL[id] }))} />}>
    {rows.length === 0 ? <Empty title="Sin salidas en el alcance" /> : <div className="overflow-x-auto">
      <table className="w-full min-w-[46rem] text-xs">
        <thead><tr className="text-left text-slate-600"><th className="py-1">{DIM_LABEL[dim]}</th><th className="text-right">Salidas</th><th className="text-right">Enlazado</th>
          <th className="text-right">Media (d)</th><th className="text-right">Mediana</th><th className="text-right">p90</th><th className="text-right">Misma fecha</th><th className="text-right">Sin entrada</th><th className="text-right">Sin lote</th></tr></thead>
        <tbody>{rows.slice(0, limit).map(r => <tr key={r.key} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => openDrill(`Salidas de ${r.label}`, r.ids)}>
          <td className="max-w-[18rem] truncate py-1.5 font-medium" title={r.label}>{r.label}</td><td className="text-right tabular-nums">{fmtNum(r.qty)}</td>
          <td className="text-right tabular-nums">{fmtPct(ratio(r.s.weight, r.qty - r.noLot))}</td><td className="text-right font-semibold tabular-nums">{fmtNum(r.s.mean, 2)}</td>
          <td className="text-right tabular-nums">{fmtNum(r.s.median)}</td><td className="text-right tabular-nums">{fmtNum(r.s.p90)}</td><td className="text-right tabular-nums">{fmtPct(r.s.sameDay, 0)}</td>
          <td className={`text-right tabular-nums ${r.unmatched > 0 ? 'text-red-700' : ''}`}>{fmtNum(r.unmatched)}</td><td className="text-right tabular-nums">{fmtNum(r.noLot)}</td></tr>)}</tbody>
      </table>
      {rows.length > limit && <button type="button" onClick={() => setLimit(l => l + 50)} className="mt-2 text-xs font-semibold text-[#002855]">Ver más ({rows.length - limit} restantes)</button>}
    </div>}
  </Card>
}

/** Remanente abierto agrupado por bodega + producto + lote, con prioridad = cantidad × antigüedad */
function useOpen(areas: Area[], unit: string | null) {
  const { fifo, base, filters, settings } = useAnalitica()
  return useMemo(() => {
    const eff = filters.areas.length ? areas.filter(x => filters.areas.includes(x)) : areas
    const keep = (m: Movement) => m.unidad === unit && !!m.area && eff.includes(m.area) && matchesFilters(m, { ...filters, areas: [], from: null })
    const age = openStockAge(fifo, base.byId, keep, settings.ageBuckets)
    const groups = new Map<string, { key: string; bodega: string; producto: string; glosa: string | null; lote: string | null; qty: number; ageW: number; oldest: string | null; ids: number[] }>()
    for (const l of age.layers) {
      const m = l.movement!
      const g = groups.get(l.key) ?? { key: l.key, bodega: m.bodega, producto: m.producto, glosa: m.glosa, lote: m.lote, qty: 0, ageW: 0, oldest: null, ids: [] }
      g.qty += l.qty; g.ageW += (l.age ?? 0) * l.qty; g.ids.push(m.id)
      if (l.entryDate && (!g.oldest || l.entryDate < g.oldest)) g.oldest = l.entryDate
      groups.set(l.key, g)
    }
    const list = [...groups.values()].map(g => ({ ...g, age: g.qty ? g.ageW / g.qty : 0, score: g.ageW })).sort((a, b) => b.score - a.score)
    const prods = new Map<string, number[]>()
    const bounds = settings.ageBuckets
    const bucketsIdx = (a: number) => { let k = 0; for (let i = 0; i < bounds.length; i++) if (a >= bounds[i]) k = i; return k }
    for (const l of age.layers) {
      const m = l.movement!
      const k = m.glosa ? `${m.producto} · ${m.glosa}` : m.producto
      const v = prods.get(k) ?? bounds.map(() => 0)
      v[bucketsIdx(l.age ?? 0)] += l.qty
      prods.set(k, v)
    }
    const heat = [...prods].map(([label, values]) => ({ label, values })).sort((a, b) => b.values.reduce((x, y) => x + y, 0) - a.values.reduce((x, y) => x + y, 0)).slice(0, 15)
    return { age, list, heat, cols: bucketize([], bounds).map(b => b.label) }
  }, [fifo, base, filters, settings.ageBuckets, unit, areas])
}

function PriorityTable({ rows, unit }: { rows: ReturnType<typeof useOpen>['list']; unit: string | null }) {
  const { openDrill, setRawRow } = useAnalitica()
  const [limit, setLimit] = useState(20)
  if (!rows.length) return <Empty title="Sin existencias abiertas en el alcance" />
  return <div className="overflow-x-auto"><table className="w-full min-w-[44rem] text-xs">
    <thead><tr className="text-left text-slate-600"><th className="py-1">Prioridad</th><th>Bodega</th><th>Producto</th><th>Lote</th><th className="text-right">Abierto ({unit})</th>
      <th className="text-right">Antigüedad pond. (d)</th><th className="text-right">Entrada más antigua</th><th>Registros</th></tr></thead>
    <tbody>{rows.slice(0, limit).map((r, i) => <tr key={r.key} className="border-t border-slate-100">
      <td className="py-1.5 font-bold tabular-nums">{i + 1}</td><td>{r.bodega}</td><td className="max-w-[16rem] truncate" title={`${r.producto} · ${r.glosa ?? ''}`}>{r.producto}<span className="block truncate text-[10px] text-slate-500">{r.glosa}</span></td>
      <td>{r.lote}</td><td className="text-right font-semibold tabular-nums">{fmtNum(r.qty)}</td><td className="text-right tabular-nums">{fmtNum(r.age, 1)}</td><td className="text-right">{fmtDate(r.oldest)}</td>
      <td className="whitespace-nowrap"><button type="button" className="font-semibold text-[#002855]" onClick={() => openDrill(`Entradas abiertas de ${r.producto} · lote ${r.lote}`, r.ids)}>Ver ({r.ids.length})</button>
        {r.ids[0] !== undefined && <button type="button" className="ml-2 text-slate-600 underline" onClick={() => setRawRow(r.ids[0])}>fila original</button>}</td></tr>)}</tbody>
  </table>
  {rows.length > limit && <button type="button" onClick={() => setLimit(l => l + 40)} className="mt-2 text-xs font-semibold text-[#002855]">Ver más</button>}</div>
}

function simpleKpi(code: string, label: string, value: number | null, unit: string | null, definition: string, ids: number[], extra: Partial<Kpi> = {}): Kpi {
  return { code, label, value, unit, status: value === null ? 'NO_DISPONIBLE' : 'CALCULADO', definition, formula: extra.formula ?? definition, exclusions: [], recordIds: ids, issues: [], ...extra }
}

// ---------------------------------------------------------------------------------------------------------------
export function AptTab() {
  const { analyzeFor, fifo, base, openDrill, filters: { areas: filtersAreas } } = useAnalitica()
  const areas: Area[] = useMemo(() => ['APT', 'APT_LB'], [])
  const a = analyzeFor(areas)
  const unit = a.unit
  const inUnit = useMemo(() => a.scope.filter(m => m.unidad === unit), [a.scope, unit])
  const byDay = useMemo(() => {
    const days = dailySeries(inUnit, unit ?? '', null, a.cutoff).map(d => d.fecha)
    const rows = new Map(days.map(d => [d, { fecha: d, prod: 0, trE: 0, otE: 0, trS: 0, desp: 0, otS: 0 } as Record<string, number | string>]))
    for (const m of inUnit) {
      const r = rows.get(m.fecha); if (!r) continue
      const k = m.side === 'E' ? (m.clase === 'PRODUCCION' ? 'prod' : m.clase === 'TRASPASO' ? 'trE' : 'otE') : (m.clase === 'TRASPASO' ? 'trS' : m.clase === 'DESPACHO_VENTA' ? 'desp' : 'otS')
      r[k] = Number(r[k]) + m.qty
    }
    return [...rows.values()]
  }, [inUnit, unit, a.cutoff])
  const tByKey = useMemo(() => new Map(base.transfers.map(t => [t.key, t])), [base])
  const prod = inUnit.filter(m => m.side === 'E' && m.clase === 'PRODUCCION')
  const toDist = inUnit.filter(m => m.side === 'S' && m.clase === 'TRASPASO' && tByKey.get(transferKeyOf(m))?.areasE.includes('DIST'))
  const returns = inUnit.filter(m => m.side === 'E' && m.clase === 'TRASPASO' && tByKey.get(transferKeyOf(m))?.areasS.includes('DIST'))
  // Sin líneas de esa clase el resultado es cero calculado (hay datos del área y no hubo movimiento)
  const sum = (xs: Movement[]) => xs.reduce((s, m) => s + m.qty, 0)
  const dw = useMemo(() => dwellOfExits(inUnit, fifo, [0]), [inUnit, fifo])
  const open = useOpen(areas, unit)
  const scatter = open.list.slice(0, 300).map(r => ({ age: Math.round(r.age * 10) / 10, qty: r.qty, label: `${r.producto} · lote ${r.lote}`, id: r.ids[0] }))
  if (!a.scope.length) return <Notice>No hay movimientos de APT en el alcance filtrado{filtersAreas.length ? ' (el filtro de área no incluye APT principal ni APT LB)' : ''}.</Notice>
  return <div className="space-y-4">
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <KpiTile kpi={simpleKpi('prod', 'Producción ingresada a APT', sum(prod), unit, 'Entradas con TipoDocto de producción (P/E) en las bodegas APT. Los traspasos recibidos no son producción nueva.', prod.map(m => m.id), { hint: `${prod.length} líneas` })} />
      <KpiTile kpi={simpleKpi('todist', 'Transferencias a Distribución', sum(toDist), unit, 'Salidas por traspaso desde APT cuya clave (tipo, número, fecha, producto, unidad) tiene la entrada en una bodega de Distribución. No son ventas.', toDist.map(m => m.id), { hint: `${toDist.length} líneas` })} />
      <KpiTile kpi={simpleKpi('ret', 'Retornos desde Distribución', sum(returns), unit, 'Entradas por traspaso a APT cuya salida está en Distribución.', returns.map(m => m.id), { hint: `${returns.length} líneas` })} />
      <KpiTile kpi={a.kpis.permanencia} />
      <KpiTile kpi={a.kpis.abiertas} />
      <KpiTile kpi={a.kpis.flujo} />
      <KpiTile kpi={a.kpis.cohorte} />
      <KpiTile kpi={a.kpis.trazabilidad} />
    </div>
    <Card title={`Producción recibida y transferencias por día · ${unit ?? ''}`} subtitle="Entradas (pila izquierda) y salidas (pila derecha) por clase de movimiento">
      <ClassBars data={byDay} unit={unit} series={[
        { key: 'prod', label: 'Producción recibida', color: CATEGORICAL[0], stack: 'E' }, { key: 'trE', label: 'Traspasos recibidos', color: CATEGORICAL[2], stack: 'E' },
        { key: 'otE', label: 'Otras entradas', color: '#94a3b8', stack: 'E' }, { key: 'trS', label: 'Traspasos enviados', color: CATEGORICAL[1], stack: 'S' },
        { key: 'desp', label: 'Despachos de ventas', color: CATEGORICAL[6], stack: 'S' }, { key: 'otS', label: 'Otras salidas', color: '#cbd5e1', stack: 'S' }]} /></Card>
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title={`Histograma ponderado de permanencia · ${unit ?? ''}`} subtitle={`Cantidad que salió según días en bodega. ${fmtPct(dw.summary.sameDay)} salió la misma fecha de su entrada.`}><DwellHistogram points={dw.points} unit={unit} /></Card>
      <Card title={`Mapa de calor de antigüedad · ${unit ?? ''}`} subtitle="Cantidad abierta por producto y rango de días (15 productos con más remanente)">
        <Heatmap rows={open.heat} cols={open.cols} unit={unit} onCell={(r) => {
          const label = open.heat[r].label.split(' · ')[0]
          openDrill(`Entradas abiertas de ${label}`, open.list.filter(x => x.producto === label).flatMap(x => x.ids))
        }} /></Card>
    </div>
    <DwellTable exits={inUnit} fifo={fifo} unit={unit} />
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title={`Cantidad abierta frente a antigüedad · ${unit ?? ''}`} subtitle="Cada punto es un producto + lote + bodega con remanente"><OpenScatter points={scatter} unit={unit} onPoint={id => openDrill('Entrada abierta', [id])} /></Card>
      <Card title="Tabla de prioridades" subtitle="Ordenada por cantidad × días abiertos"><PriorityTable rows={open.list} unit={unit} /></Card>
    </div>
  </div>
}

// ---------------------------------------------------------------------------------------------------------------
export function DistTab() {
  const { analyzeFor, fifo, base, openDrill, meta, filters: { areas: filtersAreas } } = useAnalitica()
  const areas: Area[] = useMemo(() => ['DIST'], [])
  const a = analyzeFor(areas)
  const unit = a.unit
  const inUnit = useMemo(() => a.scope.filter(m => m.unidad === unit), [a.scope, unit])
  const desp = useMemo(() => inUnit.filter(m => m.side === 'S' && m.clase === 'DESPACHO_VENTA'), [inUnit])
  const series = useMemo(() => {
    const d = dailySeries(inUnit, unit ?? '', null, a.cutoff)
    const by = new Map(d.map(x => [x.fecha, { fecha: x.fecha, entradas: 0, salidas: 0 }]))
    for (const m of inUnit) { const r = by.get(m.fecha); if (!r) continue; if (m.side === 'E') r.entradas += m.qty; else if (m.clase === 'DESPACHO_VENTA') r.salidas += m.qty }
    return [...by.values()]
  }, [inUnit, unit, a.cutoff])
  const cycle = useMemo(() => stageCycle(desp, fifo, base.transfers, base.byId, 'APT'), [desp, fifo, base])
  const clients = useMemo(() => {
    const by = new Map<string, number>()
    for (const m of desp) by.set(m.razonSocial ?? '(sin cliente)', (by.get(m.razonSocial ?? '(sin cliente)') ?? 0) + m.qty)
    return pareto([...by].map(([label, value]) => ({ label, value })))
  }, [desp])
  const refs = useMemo(() => {
    const by = new Map<string, { ref: string; cliente: string; docs: Set<string>; lineas: number; qty: number; first: string; last: string; ids: number[] }>()
    for (const m of desp) {
      const r = comercialRef(m) ?? m.contrato ?? '(sin referencia)'
      const g = by.get(r) ?? { ref: r, cliente: m.razonSocial ?? '', docs: new Set(), lineas: 0, qty: 0, first: m.fecha, last: m.fecha, ids: [] }
      if (m.numero) g.docs.add(m.numero)
      g.lineas++; g.qty += m.qty; g.ids.push(m.id)
      if (m.fecha < g.first) g.first = m.fecha
      if (m.fecha > g.last) g.last = m.fecha
      by.set(r, g)
    }
    return [...by.values()].sort((x, y) => y.qty - x.qty)
  }, [desp])
  const fe = useMemo(() => {
    const pts: WeightedPoint[] = []
    for (const m of desp) if (m.fechaEntrega) pts.push({ value: daysBetween(m.fechaEntrega, m.fecha), weight: m.qty })
    const n = desp.filter(m => m.fechaEntrega).length
    return { pts, n, s: summarize(pts), after: ratio(pts.filter(p => p.value > 0).reduce((s, p) => s + p.weight, 0), pts.reduce((s, p) => s + p.weight, 0)) }
  }, [desp])
  const cp = useMemo(() => commercialProgress((meta?.commitments ?? []).map(c => ({ ...c, cantidad: Number(c.cantidad) })), a.scope, meta?.links ?? [],
    (meta?.receipts ?? []).map(r => ({ ...r, aceptada: Number(r.aceptada) }))), [meta, a.scope])
  const open = useOpen(areas, unit)
  const [limit, setLimit] = useState(20)
  if (!a.scope.length) return <Notice>No hay movimientos de Distribución en el alcance filtrado{filtersAreas.length ? ' (el filtro de área no incluye Distribución)' : ''}.</Notice>
  const unconfirmed = (meta?.areas ?? []).filter(x => x.area === 'DIST' && !x.confirmed)
  return <div className="space-y-4">
    {unconfirmed.length > 0 && <Notice tone="warn">La asociación de {unconfirmed.map(x => x.bodega).join(', ')} con Distribución está <b>pendiente de confirmación del negocio</b>. Las cifras de esta pestaña dependen de esa decisión.</Notice>}
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <KpiTile kpi={a.kpis.entradas} />
      <KpiTile kpi={a.kpis.despachos} />
      <KpiTile kpi={a.kpis.permanencia} />
      <KpiTile kpi={{ code: 'ciclo', label: 'Ciclo APT → despacho', status: cycle.tracedQty > 0 ? 'ESTIMADO' : 'NO_DISPONIBLE', value: cycle.summary.mean, unit: 'días',
        hint: cycle.tracedQty > 0 ? `Sobre ${fmtNum(cycle.tracedQty)} ${unit} trazables (${fmtPct(cycle.share)} de lo despachado)` : undefined,
        definition: 'Días desde la entrada a APT principal hasta el despacho de Distribución, solo para la cantidad trazable en todas las etapas: FIFO en Distribución hasta la entrada por traspaso, clave de traspaso conciliada y sin cambio de lote, y FIFO en APT hasta su entrada. No es la suma de las medias de cada etapa.',
        formula: 'Σ (cantidad trazable × días totales) ÷ Σ cantidad trazable', numerator: { label: 'Cantidad trazable', value: cycle.tracedQty }, denominator: { label: 'Despachado', value: cycle.finalQty },
        coverage: cycle.share, exclusions: ['Traspasos con cambio de lote o sin conciliar', 'Salidas sin entrada observable en alguna etapa'], recordIds: desp.map(m => m.id),
        issues: ['CAMBIO_LOTE_TRASPASO', 'TRASPASO_SIN_CONCILIAR', 'SALIDA_SIN_ENTRADA'], missing: cycle.tracedQty > 0 ? undefined : 'No hay cantidades trazables por las dos etapas.' }} />
      <KpiTile kpi={a.kpis.abiertas} />
      <KpiTile kpi={a.kpis.trazabilidad} />
      <KpiTile kpi={a.kpis.comercial} />
      <KpiTile kpi={a.kpis.flujo} />
    </div>
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title={`Recepciones frente a despachos · ${unit ?? ''}`} subtitle="Recepciones = todas las entradas de Distribución (traspasos y otras). Despachos = salidas DESPACHO VENTAS.">
        <FlowBars data={series} unit={unit} labels={['Recepciones', 'Despachos']} /></Card>
      <Card title={`Antigüedad de cantidades abiertas · ${unit ?? ''}`} subtitle={`Remanente FIFO al ${fmtDate(a.cutoff)}`}><BucketBars buckets={open.age.buckets} unit={unit} label="Cantidad abierta" /></Card>
      <Card title={`Concentración por cliente · ${unit ?? ''}`} subtitle="Pareto de despachos de ventas"><ParetoBars rows={clients} unit={unit} valueLabel="Despachado" /></Card>
      <Card title="Diagnóstico frente a FechaEntrega" subtitle="FechaEntrega aún no está confirmada como compromiso contractual: esto es un diagnóstico, no cumplimiento.">
        {fe.n === 0 ? <Empty title="Los despachos no traen FechaEntrega" /> : <div className="space-y-2 text-sm">
          <p>{fmtNum(fe.n)} de {fmtNum(desp.length)} líneas de despacho traen FechaEntrega. Diferencia ponderada (fecha de despacho − FechaEntrega): media <b>{fmtNum(fe.s.mean, 1)} d</b>, mediana {fmtNum(fe.s.median)} d, p90 {fmtNum(fe.s.p90)} d.</p>
          <p>Cantidad despachada después de FechaEntrega: <b>{fmtPct(fe.after)}</b>.</p>
          <BucketBars buckets={bucketize(fe.pts.map(p => ({ value: p.value, weight: p.weight })), [-30, -7, -1, 0, 1, 8, 31])} unit={unit} label="Despachado" color="#64748b" />
        </div>}
      </Card>
    </div>
    <Card title="Despachos por referencia comercial" subtitle="Contrato, subcontrato o pedido (DocRel/NumRel/Contrato). Varios documentos para una misma referencia indican fragmentación.">
      {refs.length === 0 ? <Empty title="Sin despachos" /> : <div className="overflow-x-auto"><table className="w-full min-w-[46rem] text-xs">
        <thead><tr className="text-left text-slate-600"><th className="py-1">Referencia</th><th>Cliente</th><th className="text-right">Documentos</th><th className="text-right">Líneas</th>
          <th className="text-right">Despachado ({unit})</th><th className="text-right">Primer</th><th className="text-right">Último</th></tr></thead>
        <tbody>{refs.slice(0, limit).map(r => <tr key={r.ref} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => openDrill(`Despachos de ${r.ref}`, r.ids)}>
          <td className="py-1.5 font-medium">{r.ref}</td><td className="max-w-[16rem] truncate" title={r.cliente}>{r.cliente}</td><td className="text-right tabular-nums">{r.docs.size}</td>
          <td className="text-right tabular-nums">{r.lineas}</td><td className="text-right font-semibold tabular-nums">{fmtNum(r.qty)}</td><td className="text-right">{fmtDate(r.first)}</td><td className="text-right">{fmtDate(r.last)}</td></tr>)}</tbody>
      </table>{refs.length > limit && <button type="button" onClick={() => setLimit(l => l + 40)} className="mt-2 text-xs font-semibold text-[#002855]">Ver más</button>}</div>}
    </Card>
    <Card title="Entregas parciales y cumplimiento" subtitle="Por pedido, línea y unidad. Requiere compromisos comerciales y, para la entrega, recepciones.">
      {!cp.available ? <Notice>No disponible: faltan los compromisos comerciales (pedido, línea, cantidad vigente) y las recepciones o constancias de entrega. Cárguelos en «Cargas»
        (tipos Compromisos y Recepciones) y registre los vínculos pedido → despacho en «Configuración». Sin esa información no se calcula entrega a tiempo, entrega completa ni OTIF.</Notice>
        : <div className="overflow-x-auto"><table className="w-full min-w-[46rem] text-xs">
          <thead><tr className="text-left text-slate-600"><th className="py-1">Pedido</th><th>Línea</th><th>Producto</th><th>Unidad</th><th className="text-right">Comprometido</th><th className="text-right">Despachado válido</th>
            <th className="text-right">Avance</th><th className="text-right">Exceso</th><th className="text-right">Pendiente</th><th className="text-right">Recibido</th></tr></thead>
          <tbody>{cp.lines.map(l => <tr key={`${l.pedido}-${l.linea}`} className="border-t border-slate-100"><td className="py-1.5 font-medium">{l.pedido}</td><td>{l.linea}</td><td>{l.producto}</td><td>{l.unidad}</td>
            <td className="text-right tabular-nums">{fmtNum(l.comprometido)}</td><td className="text-right tabular-nums">{fmtNum(l.despachado - l.devuelto)}</td>
            <td className={`text-right font-semibold tabular-nums ${(l.avanceDespacho ?? 0) > 1 ? 'text-amber-700' : ''}`}>{fmtPct(l.avanceDespacho)}</td><td className="text-right tabular-nums">{fmtNum(l.exceso)}</td>
            <td className="text-right tabular-nums">{fmtNum(l.pendiente)}</td><td className="text-right tabular-nums">{l.recibido === null ? 'Sin recepción' : fmtNum(l.recibido)}</td></tr>)}</tbody>
        </table><p className="mt-2 text-xs text-slate-600">Pedidos completos: {cp.orders.filter(o => o.completo).length} de {cp.orders.length}. Un pedido con alguna línea pendiente no está completo aunque la suma global llegue a 100 %.</p></div>}
    </Card>
    <Card title="Cantidades abiertas en Distribución" subtitle="Ordenadas por cantidad × días abiertos"><PriorityTable rows={open.list} unit={unit} /></Card>
  </div>
}
