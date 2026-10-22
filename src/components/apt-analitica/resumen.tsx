'use client'

import { useMemo } from 'react'
import { dailySeries, matchesFilters, openStockAge, pareto, flowsByUnit } from '@/lib/apt-analitica/engine'
import { completeness } from '@/lib/apt-analitica/quality'
import { previousPeriod } from '@/lib/apt-analitica/analysis'
import { AREA_LABEL, type Area, type Movement } from '@/lib/apt-analitica/types'
import { useAnalitica } from './context'
import { BucketBars, CumLine, FlowBars, ParetoBars } from './charts'
import { Card, KpiTile, Notice, SeverityBadge, fmtDate, fmtNum, fmtPct } from './ui'

export function ResumenTab() {
  const { analysis, base, filters, settings, fifo, setTab } = useAnalitica()
  const { kpis, unit, scope, issues, flows } = analysis
  const series = useMemo(() => unit ? dailySeries(scope, unit, filters.from, analysis.cutoff) : [], [scope, unit, filters.from, analysis.cutoff])
  const inPop = useMemo(() => (m: Movement) => filters.areas.length > 0 || filters.bodegas.length > 0 || m.area !== null, [filters])
  const age = useMemo(() => openStockAge(fifo, base.byId, m => m.unidad === unit && inPop(m) && matchesFilters(m, { ...filters, from: null }), settings.ageBuckets), [fifo, base, unit, filters, settings.ageBuckets, inPop])
  const par = useMemo(() => {
    const by = new Map<string, number>()
    for (const l of age.layers) if (l.movement) { const k = `${l.movement.producto}${l.movement.glosa ? ` · ${l.movement.glosa}` : ''}`; by.set(k, (by.get(k) ?? 0) + l.qty) }
    return pareto([...by].map(([label, value]) => ({ label, value })))
  }, [age])
  const comp = useMemo(() => completeness(scope), [scope])
  const prev = previousPeriod(base, filters)
  const prevFlows = useMemo(() => prev ? flowsByUnit(base.accepted.filter(m => inPop(m) && matchesFilters(m, { ...filters, from: prev.from, to: prev.to }))) : null, [prev, base, filters, inPop])
  const pf = prevFlows?.find(f => f.unidad === unit)
  const byArea = useMemo(() => (['APT', 'APT_LB', 'DIST'] as Area[]).map(a => ({ area: a, flows: flowsByUnit(scope.filter(m => m.area === a)) })), [scope])
  const delta = (cur: number | null | undefined, old: number | undefined) => cur === null || cur === undefined || old === undefined || old === 0 ? null : (cur - old) / old

  if (!base.all.length) return <Notice>No hay datos importados. Cargue los archivos de Entradas y Salidas en la pestaña «Cargas».</Notice>
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile kpi={kpis.entradas} extra={pf && <p className="mt-1 text-[11px] text-slate-600">Período anterior ({fmtDate(prev!.from)}–{fmtDate(prev!.to)}): {fmtNum(pf.entradas)} · {fmtPct(delta(kpis.entradas.value, pf.entradas))}</p>} />
        <KpiTile kpi={kpis.despachos} />
        <KpiTile kpi={kpis.neta} extra={<p className="mt-1 text-[11px] text-slate-600">Inventario final: {kpis.inventario.value === null ? 'no disponible (falta saldo inicial)' : fmtNum(kpis.inventario.value)}</p>} />
        <KpiTile kpi={kpis.permanencia} />
        <KpiTile kpi={kpis.abiertas} />
        <KpiTile kpi={kpis.comercial} />
        <KpiTile kpi={kpis.incidencias} />
        <KpiTile kpi={kpis.cohorte} />
      </div>
      {flows.length > 1 && <Notice>Las cantidades se informan por unidad y no se suman entre sí: {flows.map(f => `${f.unidad}: entradas ${fmtNum(f.entradas)}, salidas ${fmtNum(f.salidas)}`).join(' · ')}.
        Los gráficos usan <b>{unit}</b>; cambie la unidad en los filtros.</Notice>}

      <Card title="Flujo por área" subtitle="Entradas, salidas y variación por área y unidad en el período filtrado">
        <div className="overflow-x-auto"><table className="w-full min-w-[34rem] text-sm">
          <thead><tr className="text-left text-xs text-slate-600"><th className="py-1">Área</th><th>Unidad</th><th className="text-right">Entradas</th><th className="text-right">Salidas</th><th className="text-right">Variación</th><th className="text-right">Líneas E / S</th></tr></thead>
          <tbody>{byArea.flatMap(a => a.flows.length ? a.flows.map((f, i) => <tr key={`${a.area}${f.unidad}`} className="border-t border-slate-100">
            <td className="py-1.5 font-semibold">{i === 0 ? AREA_LABEL[a.area] : ''}</td><td>{f.unidad}</td><td className="text-right tabular-nums">{fmtNum(f.entradas)}</td>
            <td className="text-right tabular-nums">{fmtNum(f.salidas)}</td><td className={`text-right font-semibold tabular-nums ${f.neta < 0 ? 'text-red-700' : 'text-slate-900'}`}>{f.neta > 0 ? '+' : ''}{fmtNum(f.neta)}</td>
            <td className="text-right tabular-nums text-slate-600">{fmtNum(f.lineasE)} / {fmtNum(f.lineasS)}</td></tr>)
            : [<tr key={a.area} className="border-t border-slate-100"><td className="py-1.5 font-semibold">{AREA_LABEL[a.area]}</td><td colSpan={5} className="text-slate-500">Sin movimientos en el alcance</td></tr>])}</tbody>
        </table></div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title={`Entradas y salidas por día · ${unit ?? ''}`} subtitle="Días calendario del período; los días sin movimiento valen cero"><FlowBars data={series} unit={unit} /></Card>
        <Card title={`Evolución acumulada de la variación · ${unit ?? ''}`} subtitle="Σ (entradas − salidas) desde el inicio del período. No es inventario: falta el saldo inicial."><CumLine data={series} unit={unit} /></Card>
        <Card title={`Antigüedad del remanente · ${unit ?? ''}`} subtitle={`Cantidad abierta por días desde su entrada, al ${fmtDate(analysis.cutoff)} (estimación FIFO)`}>
          <BucketBars buckets={age.buckets} unit={unit} label="Cantidad abierta" /></Card>
        <Card title={`Pareto de acumulación · ${unit ?? ''}`} subtitle="Productos con más cantidad abierta (remanente FIFO)"><ParetoBars rows={par} unit={unit} valueLabel="Cantidad abierta" /></Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Calidad: incidencias prioritarias" actions={<button type="button" onClick={() => setTab('calidad')} className="text-xs font-semibold text-[#002855]">Ver todas →</button>}>
          <ul className="space-y-2">{issues.slice(0, 6).map(i => <li key={i.code} className="flex flex-wrap items-start gap-2 text-sm">
            <SeverityBadge severity={i.severity} /><span className="min-w-0 flex-1">{i.title}</span>
            <span className="text-xs tabular-nums text-slate-600">{i.count ? `${i.count.toLocaleString('es-PE')} filas` : i.pending}</span></li>)}</ul>
        </Card>
        <Card title="Cobertura de datos" subtitle="Campos clave informados en las líneas aceptadas del alcance">
          <ul className="space-y-2">{comp.map(c => <li key={c.label} className="text-xs">
            <div className="flex justify-between"><span>{c.label}</span><span className="tabular-nums">{fmtPct(c.share)} · {fmtNum(c.filled)} de {fmtNum(c.total)}</span></div>
            <div className="mt-0.5 h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-[#2a78d6]" style={{ width: `${(c.share ?? 0) * 100}%` }} /></div></li>)}</ul>
          <div className="mt-3 grid grid-cols-2 gap-2"><KpiTile kpi={kpis.trazabilidad} /><KpiTile kpi={kpis.pesos} /></div>
        </Card>
      </div>
    </div>
  )
}
