'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Bot, CalendarClock, RefreshCw, Scale } from 'lucide-react'
import { aptApi, clearAptCache } from '@/lib/apt/api'
import { fmtDate, fmtDec1, fmtTn } from '@/lib/apt/format'
import { useOperationalFilters } from '@/lib/apt/useOperationalFilters'
import type { AptOperationalSummary } from '@/lib/apt/types'
import { OperationalReportButton } from '@/components/apt/reports/OperationalReportButton'
import { OperationalFilterBar } from '@/components/apt/OperationalFilterBar'
import { OperationalTrend, WarehouseStock } from '@/components/apt/OperationalCharts'
import { ChartCard, EmptyState, ErrorBlock, KpiCard, LoadingBlock } from '@/components/apt/ui'

export default function AptDashboardPage() {
  const { filters, setFilters, hrefWith, filterKey, legacyFilterKey } = useOperationalFilters()
  const [nonce, setNonce] = useState(0)
  const [response, setResponse] = useState<{ key: string; data: AptOperationalSummary | null; error: string | null } | null>(null)
  const key = `${filterKey}|${nonce}`
  useEffect(() => {
    let alive = true
    aptApi.operationalSummary(filters, 10, 0).then(data => { if (alive) setResponse({ key, data, error: null }) }).catch((error: Error) => { if (alive) setResponse({ key, data: null, error: error.message }) })
    return () => { alive = false }
  }, [filters, key])
  useEffect(() => { const update = () => setNonce(n => n + 1); window.addEventListener('apt:updated', update); return () => window.removeEventListener('apt:updated', update) }, [])
  const current = response?.key === key
  const d = current ? response.data : null
  const askAi = () => {
    window.dispatchEvent(new CustomEvent('jrm:context', { detail: { aptFilters: d ? { ...filters, desde: d.meta.desde || undefined, hasta: d.meta.hasta || undefined, cutoff: d.meta.cutoff || undefined } : filters, aptContext: 'APT operativo; inventario documental reconstruido' } }))
    window.dispatchEvent(new CustomEvent('jrm:open-ai'))
  }
  return <div className="space-y-4">
    {legacyFilterKey && <p className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs text-[#002855]">Este enlace contiene filtros de cohortes FIFO. <Link href={`/apt/clasico/estadia?f=${encodeURIComponent(legacyFilterKey)}`} className="font-bold underline">Abrir la estadía con esos filtros</Link>. El panorama operativo utiliza su propio alcance.</p>}
    <OperationalFilterBar filters={filters} onApply={setFilters} cutoffLabel={d?.meta.cutoff} />
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-bold text-[#002855]">Panorama operativo APT</h2><p className="text-xs text-slate-500">Existencias reconstruidas, movimientos y calidad de información.</p></div><div className="flex flex-wrap gap-2">{d && <OperationalReportButton summary={d} filters={filters} disabled={!d.meta.model_fresh} />}<button type="button" onClick={() => { clearAptCache(); setNonce(n => n + 1) }} aria-label="Actualizar análisis APT" className="rounded-lg border border-slate-200 bg-white p-2.5 text-slate-600"><RefreshCw className="h-4 w-4" /></button><button type="button" onClick={askAi} className="flex items-center gap-2 rounded-lg bg-[#002855] px-3 py-2 text-xs font-semibold text-white"><Bot className="h-4 w-4" /> Analizar con IA</button><Link href={hrefWith('/apt/clasico/operacion')} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-[#002855]">Ver OT y lotes</Link></div></div>
    {!current ? <LoadingBlock label="Calculando el panorama operativo…" className="h-96" /> : response.error ? <ErrorBlock message={response.error} onRetry={() => setNonce(n => n + 1)} /> : !d || d.vacio ? <EmptyState title="Sin información operativa para este alcance"><Link href="/apt/clasico/cargas" className="font-semibold text-[#002855] underline">Revisar cargas y cobertura</Link></EmptyState> : <>
      <div className={`rounded-xl border p-4 text-xs leading-relaxed ${d.meta.model_fresh ? 'border-blue-100 bg-blue-50 text-[#002855]' : 'border-amber-200 bg-amber-50 text-amber-900'}`}><p className="font-bold">{d.meta.model_fresh ? 'Inventario documental reconstruido' : 'Recálculo pendiente: las cifras pueden estar desactualizadas'}</p><p className="mt-1">Corte {fmtDate(d.meta.cutoff)} · Movimientos {fmtDate(d.meta.desde)} – {fmtDate(d.meta.hasta)}. El saldo incluye aperturas inferidas y requiere conciliación con ERP y existencia física.</p>{!d.meta.composition_available && <p className="mt-1">En este corte histórico no está disponible la composición del origen; la antigüedad se muestra como no evaluable.</p>}</div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiCard label="Saldo reconstruido" value={fmtTn(d.kpis.stock_tn)} unit="TN" tone="navy" icon={<Scale className="h-4 w-4" />} hint="Existencia documental al corte" />
        <KpiCard label="Origen desconocido" value={d.kpis.unknown_origin_stock_tn === null ? 'No evaluable' : fmtTn(d.kpis.unknown_origin_stock_tn)} unit={d.kpis.unknown_origin_stock_tn === null ? undefined : 'TN'} tone="warn" hint="Saldo sin fecha de origen; no inventario confirmado" />
        <KpiCard label="Antigüedad ponderada" value={d.kpis.weighted_age_days === null ? 'No evaluable' : fmtDec1(d.kpis.weighted_age_days)} unit={d.kpis.weighted_age_days === null ? undefined : 'd'} icon={<CalendarClock className="h-4 w-4" />} hint="Σ(TN con origen × días) / TN con origen" />
        <KpiCard label="Rotación del período" value={d.kpis.turnover === null ? 'No evaluable' : fmtDec1(d.kpis.turnover)} unit={d.kpis.turnover === null ? undefined : '×'} hint="Salidas ERP / saldo promedio diario reconstruido" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><KpiCard label="Ingreso de producción" value={fmtTn(d.kpis.production_tn)} unit="TN" hint="Durante el período seleccionado" /><KpiCard label="Salidas ERP" value={fmtTn(d.kpis.dispatch_tn)} unit="TN" hint="No acredita entrega conforme" /><KpiCard label="Consumo interno" value={fmtTn(d.kpis.consumption_tn)} unit="TN" hint="Separado del despacho a clientes" /><KpiCard label="Devoluciones" value={fmtTn(d.kpis.returns_tn)} unit="TN" hint="Reingresos durante el período" /></div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2"><ChartCard title="Saldo diario reconstruido" subtitle="Arrastra los extremos inferiores para acercar el período" info="El saldo considera la historia previa al período, incluidos consumos, devoluciones y traspasos. No acredita inventario físico conciliado."><OperationalTrend data={d.series} mode="stock" /></ChartCard><ChartCard title="Producción y salidas ERP" subtitle="Gráficos sincronizados · TN por fecha de movimiento" info="Los traspasos internos no son producción nueva ni entrega al cliente."><OperationalTrend data={d.series} mode="movements" /></ChartCard></div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2"><ChartCard title="Ubicación del saldo" subtitle="Selecciona un almacén para aplicar el filtro a todo el análisis"><WarehouseStock data={d.warehouses} selected={filters.almacen} onSelect={almacen => setFilters({ ...filters, almacen: filters.almacen === almacen ? undefined : almacen })} /></ChartCard><ChartCard title="Calidad de la información" subtitle="Revisar antes de interpretar el resultado"><ul className="space-y-3 text-sm"><li className="flex justify-between gap-4"><span>Registros sin peso</span><b className="text-amber-700">{d.quality.missing_weight_rows}</b></li><li className="flex justify-between gap-4"><span>Anomalías temporales</span><b className="text-amber-700">{d.quality.temporal_anomaly_rows}</b></li><li className="flex justify-between gap-4"><span>Saldos negativos</span><b className="text-red-700">{d.quality.negative_balance_rows}</b></li><li className="flex justify-between gap-4"><span>Apertura inferida del modelo</span><b>{d.kpis.inferred_opening_tn === null ? 'No evaluable' : `${fmtTn(d.kpis.inferred_opening_tn)} TN`}</b></li></ul><p className="mt-4 flex gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-900"><AlertTriangle className="h-4 w-4 shrink-0" /> Un cuadre matemático no certifica la existencia física. Las aperturas inferidas pueden representar movimientos históricos faltantes.</p><Link href="/apt/clasico/calidad" className="mt-4 inline-flex text-xs font-bold text-[#002855] underline">Consultar calidad documental</Link></ChartCard></div>
      <ChartCard title="Cobertura de movimientos" subtitle="Las fuentes pueden tener fechas diferentes; ausencia de filas no demuestra ausencia de operación"><div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="border-b text-slate-500"><th className="py-2">Fuente</th><th>Desde</th><th>Hasta</th><th className="text-right">Registros</th><th className="text-right">Sin peso</th></tr></thead><tbody>{d.coverage.map(row => <tr key={row.kind} className="border-b border-slate-100"><td className="py-2 font-semibold">{row.kind}</td><td>{fmtDate(row.desde)}</td><td>{fmtDate(row.hasta)}</td><td className="text-right tabular-nums">{row.rows}</td><td className="text-right tabular-nums">{row.missing_weight_rows}</td></tr>)}</tbody></table></div></ChartCard>
    </>}
  </div>
}
