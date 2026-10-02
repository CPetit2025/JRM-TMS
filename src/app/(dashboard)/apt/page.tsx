'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, CalendarClock, Clock, FileSpreadsheet, Flame, Layers, Package, Scale, Timer } from 'lucide-react'
import { aptApi, cleanFilters } from '@/lib/apt/api'
import { exportAptXlsx } from '@/lib/apt/export'
import { fmtDate, fmtDec1, fmtDias, fmtKg, fmtPct, fmtTn } from '@/lib/apt/format'
import { loteHref, useAptFilters } from '@/lib/apt/useAptFilters'
import type { AptDashboard, AptEstado, AptGrain } from '@/lib/apt/types'
import { ChartCard, EmptyState, ErrorBlock, KpiCard, LoadingBlock } from '@/components/apt/ui'
import { AgingColumns, AgingDonut, EstadosBar, FamiliaBars, FlowChart, LoteBars, ProductoBars, StockChart, fmtAxis } from '@/components/apt/dashCharts'
import { LiberarTable, MiniKpi, RespuestasClave } from '@/components/apt/dashParts'

// Dashboard principal del módulo APT: cuánto material hay, cuánto tiempo lleva y qué liberar primero.

const GRAINS: Array<{ v: AptGrain; label: string }> = [{ v: 'dia', label: 'Día' }, { v: 'semana', label: 'Semana' }, { v: 'mes', label: 'Mes' }]
const SIN_SALIDA: AptEstado[] = ['En APT', 'Sin salida identificada']

export default function AptDashboardPage() {
  const { filters, patchFilters, setFilters, filterKey } = useAptFilters()
  const router = useRouter()
  const [grain, setGrain] = useState<AptGrain>('semana')
  const [nonce, setNonce] = useState(0)
  const reqKey = `${filterKey}|${grain}|${nonce}`
  const [res, setRes] = useState<{ key: string; data: AptDashboard | null; error: string | null } | null>(null)

  useEffect(() => {
    let alive = true
    aptApi.dashboard(filters, grain)
      .then(data => { if (alive) setRes({ key: reqKey, data, error: null }) })
      .catch((e: Error) => { if (alive) setRes(prev => ({ key: reqKey, data: prev?.data ?? null, error: e.message })) })
    return () => { alive = false }
  }, [filters, grain, reqKey])

  const loading = res?.key !== reqKey
  const d = res?.data
  if (!res && loading) return <LoadingBlock label="Calculando el inventario en APT…" className="h-96" />
  if (res?.error && !loading) return <ErrorBlock message={res.error} onRetry={() => setNonce(n => n + 1)} />
  if (!d) return <LoadingBlock className="h-96" />

  const k = d.kpis
  const hasFilters = Object.keys(cleanFilters(filters)).length > 0
  if (k.tn_ingresadas === 0) {
    return hasFilters ? (
      <EmptyState title="Sin movimientos con los filtros aplicados">
        <button onClick={() => setFilters({})} className="mt-1 font-semibold text-[#002855] underline">Quitar filtros</button>
      </EmptyState>
    ) : (
      <EmptyState title="Aún no hay movimientos: cargue ENTRADA y SALIDA">
        Las cifras del dashboard se calculan desde las hojas ENTRADA (P/E Producción) y SALIDA (Despacho Ventas).{' '}
        <Link href="/apt/cargas" className="font-semibold text-[#002855] underline">Ir a Cargas y parámetros</Link>
      </EmptyState>
    )
  }

  const alert = d.alert_days
  const toLote = (lote: string) => router.push(loteHref(lote, filters))
  const filterRango = (rango: string) => patchFilters({ rangos: [rango], solo_saldo: true })
  const isDmin = (n: number) => filters.dias_min === n && !!filters.solo_saldo
  const sameEstados = (e: AptEstado[]) => (filters.estados || []).length === e.length && e.every(x => filters.estados?.includes(x))
  const toggle = (active: boolean, patch: Parameters<typeof patchFilters>[0], clear: Parameters<typeof patchFilters>[0]) =>
    patchFilters(active ? clear : patch)
  const grainButtons = (
    <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5" role="group" aria-label="Agrupar por">
      {GRAINS.map(g => (
        <button key={g.v} onClick={() => setGrain(g.v)}
          className={`rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors ${grain === g.v ? 'bg-white text-[#002855] shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
          {g.label}
        </button>
      ))}
    </div>
  )
  const exportLiberar = () => exportAptXlsx(`APT_liberar_primero_${d.cutoff || ''}`, {
    'Qué liberar primero': [...d.top_lotes_txd].sort((a, b) => b.tn_dias - a.tn_dias).map((r, i) => ({
      Prioridad: i + 1, Lote: r.lote, Tipo: r.tipo, 'Glosa principal': r.glosa, Productos: r.productos, 'Saldo TN': r.tn_saldo,
      'Días del saldo': r.dias, 'Aging ponderado': r.aging_pond, 'TN×Días': r.tn_dias, Estado: r.estado, Rango: r.rango,
      'Ingreso más antiguo con saldo': r.fecha_saldo, FechaEntrega: r.fecha_entrega,
    })),
  })

  return (
    <div className={`space-y-4 transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
      {/* KPI principales */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <KpiCard label="TN en APT" value={fmtTn(k.tn_saldo)} tone="navy" icon={<Scale className="h-4 w-4" />} hint={`${fmtKg(k.kg_saldo)} kg`} />
        <KpiCard label="NumRel activos" value={fmtDias(k.lotes_activos)} icon={<Layers className="h-4 w-4" />}
          hint={`con saldo de ${fmtDias(k.lotes_total)} lotes`} onClick={() => patchFilters({ solo_saldo: !filters.solo_saldo })}
          active={!!filters.solo_saldo} />
        <KpiCard label="Productos" value={fmtDias(k.productos_apt)} icon={<Package className="h-4 w-4" />} hint={`${fmtDias(k.capas_abiertas)} capas abiertas`} />
        <KpiCard label="Días promedio" value={fmtDec1(k.dias_prom)} unit="d" icon={<Clock className="h-4 w-4" />} hint={`Mediana ${fmtDias(k.dias_mediana)} d · máx. ${fmtDias(k.dias_max)} d`} />
        <KpiCard label="Aging ponderado" value={fmtDec1(k.aging_pond)} unit="d" tone={k.aging_pond !== null && k.aging_pond > 30 ? 'warn' : 'default'}
          icon={<Timer className="h-4 w-4" />} hint="Σ(TN×días) / Σ TN" />
        <KpiCard label="TN > 15 días" value={fmtTn(k.tn_gt15)} tone="warn" hint={`${fmtPct(k.pct_gt15)} del saldo`}
          onClick={() => toggle(isDmin(16), { dias_min: 16, solo_saldo: true }, { dias_min: undefined })} active={isDmin(16)} />
        <KpiCard label="TN > 30 días" value={fmtTn(k.tn_gt30)} tone="crit" icon={<AlertTriangle className="h-4 w-4" />} hint={`${fmtPct(k.pct_gt30)} del saldo`}
          onClick={() => toggle(isDmin(31), { dias_min: 31, solo_saldo: true }, { dias_min: undefined })} active={isDmin(31)} />
        <KpiCard label="TN×Días" value={fmtAxis(k.tn_dias)} tone="crit" icon={<Flame className="h-4 w-4" />} hint={`${fmtTn(k.tn_dias)} · impacto acumulado`} />
      </div>

      {/* Indicadores complementarios */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
        <MiniKpi label="TN ingresadas" value={fmtTn(k.tn_ingresadas)} hint="Entradas del periodo cargado" />
        <MiniKpi label="TN despachadas" value={fmtTn(k.tn_despachadas)} tone="ok" hint={`${fmtPct(k.pct_despachado)} despachado`} />
        <MiniKpi label={`Lotes críticos > ${alert} d`} value={fmtDias(k.lotes_criticos)} tone="crit" hint={`${fmtTn(k.tn_gt_alerta)} TN`}
          onClick={() => toggle(isDmin(alert + 1), { dias_min: alert + 1, solo_saldo: true }, { dias_min: undefined })} active={isDmin(alert + 1)} />
        <MiniKpi label="Lotes sin salida" value={fmtDias(k.lotes_sin_salida)} tone="warn" hint="Con saldo y ningún despacho"
          onClick={() => toggle(sameEstados(SIN_SALIDA), { estados: SIN_SALIDA, solo_saldo: true }, { estados: undefined })} active={sameEstados(SIN_SALIDA)} />
        <MiniKpi label="Salida parcial" value={fmtDias(k.lotes_parciales)} hint="Lotes con despacho incompleto"
          onClick={() => toggle(sameEstados(['Salida parcial']), { estados: ['Salida parcial'] }, { estados: undefined })} active={sameEstados(['Salida parcial'])} />
        <MiniKpi label="Estadía despachado" value={`${fmtDec1(k.dias_despacho_pond)} d`} hint="Días ponderados hasta la salida" />
        <MiniKpi label="Ingreso más antiguo" value={fmtDate(k.fecha_mas_antigua)} hint="Con saldo en APT" />
      </div>

      {/* Respuestas clave + aging */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <ChartCard className="lg:col-span-5" title="Respuestas clave" subtitle="Lectura automática del inventario con los filtros actuales" bodyClassName="py-1">
          <RespuestasClave d={d} filters={filters} grain={grain} onProducto={p => patchFilters({ producto: p })} />
        </ChartCard>
        <ChartCard className="lg:col-span-7" title="TN por rango de aging" subtitle="Saldo en APT según los días que lleva almacenado · clic en una barra para filtrar"
          info="Antigüedad de cada capa (FIFO) con saldo a la fecha de corte. Los rangos se configuran en Cargas y parámetros.">
          <AgingColumns data={d.aging} onSelect={filterRango} active={filters.rangos} />
        </ChartCard>
      </div>

      {/* Prioridad de liberación (bloque destacado) */}
      <section className="rounded-2xl border-2 border-[#cf152d]/25 bg-gradient-to-br from-red-50/60 to-white p-3 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-1">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#cf152d] text-white"><Flame className="h-4 w-4" /></span>
            <div>
              <h2 className="text-sm font-black uppercase tracking-wide text-slate-900">¿Qué liberar primero?</h2>
              <p className="text-xs text-slate-500">Ranking por TN×Días: cuánto material y cuánto tiempo lleva retenido. El color indica la antigüedad del saldo.</p>
            </div>
          </div>
          <button onClick={exportLiberar} className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
            <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600" /> Exportar Excel
          </button>
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
          <ChartCard className="lg:col-span-5" title="TOP 10 NumRel por TN×Días" subtitle="Clic en una barra para abrir la ficha del lote"
            info="TN×Días = saldo TN × días del saldo. Prioriza lotes grandes y antiguos.">
            <LoteBars data={d.top_lotes_txd} metric="tn_dias" aging={d.aging} onSelect={toLote} />
          </ChartCard>
          <ChartCard className="lg:col-span-7" title="Lotes a liberar" subtitle={`Saldo, días y estado de los ${d.top_lotes_txd.length} lotes de mayor impacto`} bodyClassName="p-0 sm:p-2">
            <LiberarTable rows={d.top_lotes_txd} aging={d.aging} alert={alert} filters={filters} />
          </ChartCard>
        </div>
      </section>

      {/* Volumen por lote y producto */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <ChartCard className="lg:col-span-6" title="TOP 10 NumRel por TN almacenadas" subtitle="Clic en una barra para abrir la ficha del lote">
          <LoteBars data={d.top_lotes_tn} metric="tn_saldo" aging={d.aging} onSelect={toLote} />
        </ChartCard>
        <ChartCard className="lg:col-span-6" title="TOP productos por TN almacenadas" subtitle="Clic para filtrar el producto en todo el módulo">
          <ProductoBars data={d.top_productos} onSelect={p => patchFilters({ producto: p })} />
        </ChartCard>
      </div>

      {/* Evolución */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <ChartCard className="lg:col-span-6" title="Entradas vs salidas" actions={grainButtons}
          subtitle={<span className="flex items-center gap-3">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-[#2563eb]" />TN entrada</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-[#0d9488]" />TN salida</span>
          </span>}>
          <FlowChart data={d.trend} grain={grain} />
        </ChartCard>
        <ChartCard className="lg:col-span-6" title="Inventario acumulado y aging" actions={grainButtons}
          subtitle={<span className="flex items-center gap-3">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-[#002855]" />Saldo TN</span>
            <span className="flex items-center gap-1"><span className="h-0.5 w-3 bg-[#cf152d]" />Aging ponderado (días, eje der.)</span>
          </span>}>
          <StockChart data={d.trend} grain={grain} />
          <p className="mt-2 flex items-start gap-1.5 text-[11px] text-slate-400">
            <CalendarClock className="mt-0.5 h-3 w-3 shrink-0" />
            Inventario reconstruido desde las entradas del periodo; no incluye stock anterior al primer ingreso cargado.
          </p>
        </ChartCard>
      </div>

      {/* Distribución, estados y familias */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <ChartCard className="lg:col-span-4" title="Distribución por aging" subtitle="% de las TN en APT por rango">
          <AgingDonut data={d.aging} total={k.tn_saldo} onSelect={filterRango} />
        </ChartCard>
        <ChartCard className="lg:col-span-4" title="Estados del inventario" subtitle="TN ingresadas por estado de la capa · clic para filtrar"
          info="En APT: sin salidas dentro del plazo · Salida parcial: queda saldo · Despachado: dentro de la tolerancia · Sin salida identificada: supera la alerta · Problema de información: sin peso o salida antes del ingreso.">
          <EstadosBar data={d.estados} active={filters.estados}
            onSelect={e => toggle(sameEstados([e]), { estados: [e] }, { estados: undefined })} />
        </ChartCard>
        <ChartCard className="lg:col-span-4" title="Familias por TN" subtitle="Saldo y aging ponderado · clic para filtrar">
          <FamiliaBars data={d.top_familias} onSelect={f => patchFilters({ familias: [f] })} />
        </ChartCard>
      </div>
    </div>
  )
}
