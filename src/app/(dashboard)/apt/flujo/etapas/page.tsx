'use client'

import { Suspense, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CalendarClock, Clock, Gauge, Info, PackageCheck, Search, Timer, Truck, Warehouse } from 'lucide-react'
import { flowApi } from '@/lib/apt/api'
import { exportAptXlsx } from '@/lib/apt/export'
import { fmtDate, fmtInt, fmtPct, fmtTn } from '@/lib/apt/format'
import { traceHref, useFlowFilters } from '@/lib/apt/useFlowFilters'
import type { FlowLeadDim, FlowLeadtime } from '@/lib/apt/flowTypes'
import { ChartCard, EmptyState, ErrorBlock, InlineBar, KpiCard, LoadingBlock } from '@/components/apt/ui'
import { ExportButton, Segmented, SortTh, useAsyncData } from '@/components/apt/PphShared'
import {
  ETAPA_COLOR, EtapasDimChart, EtapasDistribucion, EtapasMensual, EtapasTimeline, fmtD1, mesLabel, type EtapasDimRow,
} from '@/components/apt/flow/EtapasCharts'

// Tiempos por etapa: cuánto tarda lo producido en llegar a la guía, separando el tiempo antes del último almacén
// (casi siempre 647) del tiempo en el último almacén (casi siempre ST VENTAS). Todo ponderado por TN.

const DIMS: Array<{ value: FlowLeadDim; label: string }> = [
  { value: 'cliente', label: 'Cliente' },
  { value: 'ot', label: 'OT' },
  { value: 'lote', label: 'Lote' },
  { value: 'familia', label: 'Familia' },
  { value: 'ruta', label: 'Ruta' },
]
const DIM_HINT: Record<FlowLeadDim, string> = {
  cliente: 'Clic en una fila filtra todo el flujo por ese cliente.',
  ot: 'Clic en una fila filtra todo el flujo por esa OT madre.',
  lote: 'Clic en un lote abre su trazabilidad completa.',
  familia: 'Familia = primera palabra de la glosa del producto.',
  ruta: 'Ruta = almacén previo → último almacén antes de la guía (p. ej. 647→ST).',
}
const TOP_CHART = 15

type SortKey = 'clave' | 'tn' | 'guias' | 'dias_total' | 'dias_previo' | 'dias_final' | 'max_total'

export default function EtapasPage() {
  return <Suspense fallback={<LoadingBlock />}><EtapasView /></Suspense>
}

function EtapasView() {
  const { filters, filterKey, patchFilters } = useFlowFilters()
  const router = useRouter()
  const [dim, setDim] = useState<FlowLeadDim>('cliente')
  const q = useAsyncData(`${dim}|${filterKey}`, () => flowApi.leadtime(filters, dim))
  const d = q.data

  if (q.error && !d) return <ErrorBlock message={q.error} onRetry={q.reload} />
  if (!d) return <LoadingBlock />
  if (d.vacio || (!d.kpis.tn && !d.kpis.sin_traza_tn)) {
    return <EmptyState title="Sin despachos en el periodo">Cargue las hojas de SALIDA y traspasos en “Cargas y parámetros” o amplíe el periodo.</EmptyState>
  }
  const k = d.kpis
  const totalDesp = k.tn + k.sin_traza_tn
  const pctTraza = totalDesp > 0 ? (100 * k.tn) / totalDesp : null
  const onSelect = (clave: string) => {
    if (dim === 'cliente') patchFilters({ clientes: [clave] })
    else if (dim === 'ot') patchFilters({ ot: clave })
    else if (dim === 'lote') router.push(traceHref(clave))
  }
  const clickable = dim === 'cliente' || dim === 'ot' || dim === 'lote'

  return (
    <div className={`space-y-4 transition-opacity ${q.loading ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-black text-[#002855]">Tiempos por etapa · producción → guía</h2>
          <p className="text-xs text-slate-500">
            Despachos del {fmtDate(d.desde)} al {fmtDate(d.hasta)} · días ponderados por TN (Σ TN×días / Σ TN)
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <KpiCard label="TN trazadas" value={fmtTn(k.tn)} unit="TN" tone="navy" icon={<PackageCheck className="h-4 w-4" />}
          hint={`${fmtInt(k.guias)} guías · ${fmtPct(pctTraza)} de lo despachado`} />
        <KpiCard label="Producción → guía" value={fmtD1(k.dias_total)} tone="navy" icon={<Timer className="h-4 w-4" />}
          hint="Días ponderados por TN desde la producción hasta la guía" />
        <KpiCard label="P50 / P90" value={<>{fmtD1(k.p50)} <span className="text-base text-slate-400">/</span> {fmtD1(k.p90)}</>}
          icon={<Gauge className="h-4 w-4" />} hint="La mitad de la TN sale en ≤ P50; el 90 % en ≤ P90" />
        <KpiCard label="Antes del último almacén" value={fmtD1(k.dias_previo)} icon={<Warehouse className="h-4 w-4" />}
          hint={<><Dot c={ETAPA_COLOR.previo} />Casi siempre 647: producción → llegada a ST</>} />
        <KpiCard label="En el último almacén" value={fmtD1(k.dias_final)} icon={<Clock className="h-4 w-4" />}
          tone={(k.dias_final ?? 0) > 1 ? 'warn' : 'ok'} hint={<><Dot c={ETAPA_COLOR.final} />Casi siempre ST VENTAS: llegada → guía</>} />
        <KpiCard label="% mismo día" value={fmtPct(k.mismo_dia_pct)} icon={<Truck className="h-4 w-4" />}
          tone={(k.mismo_dia_pct ?? 0) >= 80 ? 'ok' : 'warn'} hint="TN guiada el mismo día que llegó al último almacén" />
        <KpiCard label="Sin trazabilidad completa" value={fmtTn(k.sin_traza_tn)} unit="TN" tone={k.sin_traza_tn > 0 ? 'warn' : 'default'}
          icon={<CalendarClock className="h-4 w-4" />}
          hint="Stock previo al periodo: existía antes del primer día cargado; su antigüedad real es desconocida y no entra al promedio" />
        <KpiCard label="Peso del tramo 647" icon={<Info className="h-4 w-4" />}
          value={fmtPct(k.dias_total ? (100 * (k.dias_previo ?? 0)) / k.dias_total : null)}
          hint="Parte del tiempo total que se espera antes de pasar a ST; ahí está la palanca de mejora" />
      </div>

      <ChartCard title="Línea de etapas" subtitle="Producción → 647 → ST VENTAS → guía, proporcional a los días ponderados"
        info="Cada tramo es el promedio de días ponderado por TN: Σ(TN × días) / Σ TN. Un lote de 30 TN pesa 30 veces más que uno de 1 TN. El tramo corto se dibuja con un ancho mínimo para que se lea.">
        <EtapasTimeline k={k} />
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Distribución producción → guía" subtitle="TN despachada por rango de días totales"
          info="Muestra si el promedio esconde colas largas: una barra alta en los rangos altos indica lotes que esperan semanas en 647.">
          <EtapasDistribucion data={d.distribucion.total} tipo="total" />
        </ChartCard>
        <ChartCard title="Días en el último almacén" subtitle="TN por días entre la llegada a ST (u otro último almacén) y la guía"
          info="ST VENTAS debería guiar el mismo día. Lo que pasa de 1 día es material detenido en la zona de despacho.">
          <EtapasDistribucion data={d.distribucion.final} tipo="final" />
        </ChartCard>
      </div>

      <ChartCard title="Tendencia mensual" subtitle="Días previo + final apilados (etiqueta = total) y % despachado el mismo día"
        info="Mes de la guía. Si sube la barra navy, el material espera más en 647; si sube la teal, se queda más en ST.">
        <EtapasMensual data={d.mensual} />
      </ChartCard>

      <DimSection key={dim} dim={dim} setDim={setDim} rows={d.por_dim} clickable={clickable} onSelect={onSelect}
        exportar={() => exportAptXlsx(`APT_flujo_tiempos_${dim}_${new Date().toISOString().slice(0, 10)}`, {
          [DIMS.find(x => x.value === dim)?.label || dim]: d.por_dim.map(r => ({
            [DIMS.find(x => x.value === dim)?.label || 'Clave']: r.clave, TN: r.tn, Guías: r.guias, 'Días total (pond.)': r.dias_total,
            'Días antes del último almacén': r.dias_previo, 'Días en el último almacén': r.dias_final, 'Días máximo': r.max_total,
          })),
          Mensual: d.mensual.map(m => ({
            Mes: mesLabel(m.mes), TN: m.tn, 'Días total': m.dias_total, 'Días previo': m.dias_previo, 'Días final': m.dias_final, '% mismo día': m.mismo_dia_pct,
          })),
          'Dist. total': d.distribucion.total.map(r => ({ Rango: r.rango, TN: r.tn })),
          'Dist. último almacén': d.distribucion.final.map(r => ({ Rango: r.rango, TN: r.tn })),
        })} />

      <div className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#002855]" />
        <p>
          <b>Cómo leer:</b> los días son <b>ponderados por TN</b> (Σ TN×días / Σ TN), así los lotes grandes pesan más que los retazos.
          “Antes del último almacén” va de la producción a la llegada al almacén desde el que se guía (normalmente 647 → ST);
          “En el último almacén” va de esa llegada a la guía. Lo despachado desde stock previo al periodo no tiene fecha de producción
          y se informa aparte como <b>sin trazabilidad completa</b>.
        </p>
      </div>
    </div>
  )
}

function Dot({ c }: { c: string }) {
  return <span className="mr-1 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: c }} />
}

function DimSection({ dim, setDim, rows, clickable, onSelect, exportar }: {
  dim: FlowLeadDim; setDim: (d: FlowLeadDim) => void; rows: FlowLeadtime['por_dim']
  clickable: boolean; onSelect: (k: string) => void; exportar: () => void
}) {
  const [sort, setSort] = useState<SortKey>('tn')
  const [desc, setDesc] = useState(true)
  const [search, setSearch] = useState('')
  const [chartBy, setChartBy] = useState<'tn' | 'dias'>('tn')
  const all: EtapasDimRow[] = useMemo(() => rows.map(r => ({ ...r, label: dim === 'ot' ? `OT ${r.clave}` : r.clave })), [rows, dim])
  const totalTn = all.reduce((s, r) => s + r.tn, 0)
  const maxTn = Math.max(0, ...all.map(r => r.tn))

  const shown = useMemo(() => {
    const s = search.trim().toLowerCase()
    const f = s ? all.filter(r => r.clave.toLowerCase().includes(s)) : all
    return [...f].sort((a, b) => {
      const x = a[sort], y = b[sort]
      if (x === y) return 0
      if (x === null) return 1
      if (y === null) return -1
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'es')
      return desc ? -c : c
    })
  }, [all, search, sort, desc])

  const chartRows = useMemo(() => {
    // Por días: solo claves con al menos 1 % de la TN para no rankear retazos
    const base = chartBy === 'tn' ? all : all.filter(r => r.tn >= totalTn * 0.01)
    return [...base].sort((a, b) => chartBy === 'tn' ? b.tn - a.tn : (b.dias_total ?? 0) - (a.dias_total ?? 0)).slice(0, TOP_CHART)
  }, [all, chartBy, totalTn])

  const onSort = (key: string) => {
    if (key === sort) setDesc(v => !v)
    else { setSort(key as SortKey); setDesc(key !== 'clave') }
  }
  const dimLabel = DIMS.find(x => x.value === dim)?.label || dim

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <Segmented value={dim} options={DIMS} onChange={setDim} label="Desglose por" />
        <p className="text-xs text-slate-500">{DIM_HINT[dim]}</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        <ChartCard className="xl:col-span-2" title={`Top ${TOP_CHART} por ${chartBy === 'tn' ? 'TN' : 'días'} · ${dimLabel}`}
          subtitle="Barra = días ponderados (navy antes del último almacén, teal en el último)"
          info="Ordenado por días se omiten las claves con menos de 1 % de la TN trazada."
          actions={<Segmented value={chartBy} options={[{ value: 'tn', label: 'TN' }, { value: 'dias', label: 'Días' }]} onChange={setChartBy} />}>
          <EtapasDimChart rows={chartRows} onSelect={clickable ? onSelect : undefined} />
        </ChartCard>

        <ChartCard className="xl:col-span-3" title={`Ranking por ${dimLabel.toLowerCase()}`} subtitle={`${fmtInt(shown.length)} de ${fmtInt(all.length)} · ${fmtTn(totalTn)} TN`}
          bodyClassName="p-0"
          actions={<>
            <label className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar…"
                className="h-8 w-40 rounded-lg border border-slate-200 pl-7 pr-2 text-xs outline-none focus:border-[#002855]" />
            </label>
            <ExportButton onClick={exportar} disabled={!all.length} />
          </>}>
          <div className="max-h-[560px] overflow-auto">
            <table className="w-full min-w-[640px] text-xs">
              <thead>
                <tr>
                  <SortTh label={dimLabel} k="clave" sort={sort} desc={desc} onSort={onSort} align="left" />
                  <SortTh label="TN" k="tn" sort={sort} desc={desc} onSort={onSort} />
                  <SortTh label="Guías" k="guias" sort={sort} desc={desc} onSort={onSort} />
                  <SortTh label="Días total" k="dias_total" sort={sort} desc={desc} onSort={onSort} title="Producción → guía, ponderado por TN" />
                  <SortTh label="Previo" k="dias_previo" sort={sort} desc={desc} onSort={onSort} title="Producción → llegada al último almacén" />
                  <SortTh label="Final" k="dias_final" sort={sort} desc={desc} onSort={onSort} title="Llegada al último almacén → guía" />
                  <SortTh label="Máx." k="max_total" sort={sort} desc={desc} onSort={onSort} title="Días producción → guía del caso más largo" />
                </tr>
              </thead>
              <tbody>
                {shown.map(r => (
                  <tr key={r.clave} onClick={clickable && dim !== 'lote' ? () => onSelect(r.clave) : undefined}
                    className={`border-b border-slate-100 hover:bg-slate-50 ${clickable && dim !== 'lote' ? 'cursor-pointer' : ''}`}>
                    <td className="max-w-[280px] px-3 py-2">
                      {dim === 'lote'
                        ? <Link href={traceHref(r.clave)} className="font-bold text-[#002855] hover:text-[#cf152d] hover:underline">{r.clave}</Link>
                        : <span className="block truncate font-semibold text-slate-800" title={r.label}>{r.label}</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex min-w-[90px] flex-col items-end gap-1">
                        <span className="font-bold tabular-nums text-[#002855]">{fmtTn(r.tn)}</span>
                        <InlineBar value={r.tn} max={maxTn} />
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtInt(r.guias)}</td>
                    <td className="px-3 py-2 text-right"><DiasChip v={r.dias_total} /></td>
                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: ETAPA_COLOR.previo }}>{fmtD1(r.dias_previo)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums font-semibold ${(r.dias_final ?? 0) > 3 ? 'text-red-600' : (r.dias_final ?? 0) >= 1 ? 'text-amber-600' : ''}`}
                      style={(r.dias_final ?? 0) < 1 ? { color: ETAPA_COLOR.final } : undefined}>{fmtD1(r.dias_final)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmtD1(r.max_total)}</td>
                  </tr>
                ))}
                {!shown.length && <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">Sin coincidencias</td></tr>}
              </tbody>
            </table>
          </div>
        </ChartCard>
      </div>
    </div>
  )
}

function DiasChip({ v }: { v: number | null }) {
  const cls = v === null ? 'border-slate-200 bg-slate-50 text-slate-400'
    : v > 30 ? 'border-red-200 bg-red-50 text-red-700' : v > 15 ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'
  return <span className={`inline-flex min-w-[3.5rem] justify-center rounded-md border px-1.5 py-0.5 font-bold tabular-nums ${cls}`}>{fmtD1(v)}</span>
}
