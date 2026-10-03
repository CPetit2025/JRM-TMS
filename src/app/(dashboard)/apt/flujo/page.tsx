'use client'

import { useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeftRight, CalendarClock, Factory, GitMerge, PackageCheck, Recycle, Scale, Timer, Truck, Zap } from 'lucide-react'
import { flowApi } from '@/lib/apt/api'
import { fmtDate, fmtDateTime, fmtDec1, fmtInt, fmtPct, fmtTn } from '@/lib/apt/format'
import { ALMACEN_COLOR } from '@/lib/apt/flowColors'
import type { FlowAlmacen } from '@/lib/apt/flowTypes'
import { useFlowFilters } from '@/lib/apt/useFlowFilters'
import { ChartCard, EmptyState, ErrorBlock, KpiCard, LoadingBlock } from '@/components/apt/ui'
import { ResumenAlmacenCard, useFlowQuery } from '@/components/apt/flow/ResumenShared'
import { ResumenSankey, type SankeyKey } from '@/components/apt/flow/ResumenSankey'
import { ResumenDespachoMensual, ResumenTraspasosMensual } from '@/components/apt/flow/ResumenCharts'

// Resumen ejecutivo del flujo multi-almacén: de la producción (647) a la guía (ST VENTAS), cuánto se trazó,
// cuánto tarda y dónde queda el saldo.

const ORDEN: FlowAlmacen[] = ['647', '540', 'ST']
const lastDay = (mes: string) => {
  const [y, m] = mes.slice(0, 10).split('-').map(Number)
  return `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`
}

export default function FlujoResumenPage() {
  const { filters, patchFilters, setFilters, hrefWith, filterKey } = useFlowFilters()
  const router = useRouter()
  const fetcher = useCallback(() => flowApi.summary(filters), [filters])
  const { data: d, error, loading, retry } = useFlowQuery(filterKey, fetcher)

  if (!d && loading) return <LoadingBlock label="Calculando el flujo multi-almacén…" className="h-96" />
  if (error) return <ErrorBlock message={error} onRetry={retry} />
  if (!d) return <LoadingBlock className="h-96" />
  if (d.vacio) {
    return (
      <EmptyState title="Aún no hay datos del flujo multi-almacén">
        Cargue las hojas de producción, traspasos, despachos y consumos para reconstruir el flujo 647 → ST VENTAS → cliente.{' '}
        <Link href="/apt/cargas" className="font-semibold text-[#002855] underline">Ir a Cargas y parámetros</Link>
      </EmptyState>
    )
  }

  const k = d.kpis
  const alm = ORDEN.map(a => d.almacenes.find(x => x.almacen === a)).filter((x): x is NonNullable<typeof x> => !!x)
  const saldoTotal = alm.reduce((s, a) => s + Number(a.saldo_tn || 0), 0)
  const saldoBy = (a: FlowAlmacen) => alm.find(x => x.almacen === a)?.saldo_tn ?? 0
  const inicialDesp = (k.origen_despacho.INICIAL_647 ?? 0) + (k.origen_despacho.INICIAL_540 ?? 0) + (k.origen_despacho.INICIAL_ST ?? 0)
  const hasFilters = Object.keys(filters).some(x => x !== 'almacen')
  const almHref = (a?: FlowAlmacen) => hrefWith('/apt/flujo/almacenes', { almacen: a })

  const onNode = (key: SankeyKey) => {
    if (key === '647' || key === '540') router.push(almHref(key))
    else if (key === 'ST' || key === 'RETORNO') router.push(hrefWith('/apt/flujo/st-ventas'))
    else if (key === 'CLIENTE') router.push(hrefWith('/apt/flujo/etapas'))
    else if (key === 'SALDO') router.push(almHref(undefined))
  }

  if (k.produccion_tn === 0 && k.despacho_tn === 0 && saldoTotal === 0 && hasFilters) {
    return (
      <EmptyState title="Sin movimientos con los filtros aplicados">
        <button onClick={() => setFilters({})} className="mt-1 font-semibold text-[#002855] underline">Quitar filtros</button>
      </EmptyState>
    )
  }

  return (
    <div className={`space-y-4 transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
      {/* Encabezado */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-black uppercase tracking-wide text-slate-900">Resumen del flujo · Producción → 647/540 → ST VENTAS → Cliente</h2>
          <p className="text-xs text-slate-500">
            Periodo {fmtDate(d.desde)} – {fmtDate(d.hasta)} · el periodo se aplica a la fecha de cada movimiento (producción, traspaso o guía).
          </p>
        </div>
        <p className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-500">
          <CalendarClock className="h-3.5 w-3.5 text-slate-400" />
          Datos al corte <b className="text-slate-700">{fmtDate(d.cutoff)}</b>
          <span className="text-slate-300">·</span> desde {fmtDate(d.data_min)}
          <span className="text-slate-300">·</span> recalculado {fmtDateTime(d.rebuilt_at)}
        </p>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <KpiCard label="Producción ingresada" value={fmtTn(k.produccion_tn)} unit="TN" icon={<Factory className="h-4 w-4" />}
          hint={k.devolucion_tn > 0 ? `+ ${fmtTn(k.devolucion_tn)} TN de devoluciones` : 'Ingresos P/E a 647 en el periodo'} />
        <KpiCard label="Despachado" value={fmtTn(k.despacho_tn)} unit="TN" tone="navy" icon={<Truck className="h-4 w-4" />}
          hint={`${fmtInt(k.guias)} guías desde ST VENTAS`} />
        <KpiCard label="% trazado a producción" value={fmtPct(k.trazado_pct)} icon={<GitMerge className="h-4 w-4" />}
          tone={k.trazado_pct === null ? 'default' : k.trazado_pct >= 85 ? 'ok' : k.trazado_pct >= 60 ? 'warn' : 'crit'}
          hint={`Del despacho nace en producción del periodo; ${fmtTn(inicialDesp)} TN salió de stock previo`} />
        <KpiCard label="Lead time prod.→guía" value={fmtDec1(k.dias_total)} unit="d" icon={<Timer className="h-4 w-4" />}
          tone={(k.dias_total ?? 0) > 30 ? 'crit' : (k.dias_total ?? 0) > 15 ? 'warn' : 'default'}
          hint={<span>Días ponderados por TN · <b style={{ color: ALMACEN_COLOR['647'] }}>{fmtDec1(k.dias_previo)} d</b> hasta ST (647/540) +{' '}
            <b style={{ color: ALMACEN_COLOR.ST }}>{fmtDec1(k.dias_final)} d</b> en ST</span>} />
        <KpiCard label="Guiado el mismo día en ST" value={fmtPct(k.st_mismo_dia_pct)} icon={<Zap className="h-4 w-4" />}
          tone={k.st_mismo_dia_pct === null ? 'default' : k.st_mismo_dia_pct >= 90 ? 'ok' : 'warn'}
          hint={`${fmtTn(k.st_detenido_tn)} TN en ST con más de 1 día`} onClick={() => router.push(hrefWith('/apt/flujo/st-ventas'))} />
        <KpiCard label="Saldo total" value={fmtTn(saldoTotal)} unit="TN" icon={<Scale className="h-4 w-4" />}
          onClick={() => router.push(almHref(undefined))}
          hint={<span className="tabular-nums">
            {ORDEN.map((a, i) => <span key={a}>{i > 0 && ' · '}<b style={{ color: ALMACEN_COLOR[a] }}>{a}</b> {fmtTn(saldoBy(a))}</span>)}
          </span>} />
        <KpiCard label="Consumo interno" value={fmtTn(k.consumo_tn)} unit="TN" icon={<PackageCheck className="h-4 w-4" />}
          hint={`Vales V/C · ${fmtTn(k.otro_almacen_tn)} TN a otros almacenes`} />
        <KpiCard label="Retornos ST→647" value={fmtTn(k.retorno_st_tn)} unit="TN" icon={<Recycle className="h-4 w-4" />}
          tone={k.retorno_st_tn > 0 ? 'warn' : 'ok'} onClick={() => router.push(hrefWith('/apt/flujo/st-ventas'))}
          hint="Pasó a ST y no se guió: doble manipuleo" />
      </div>

      {/* Sankey */}
      <ChartCard title="Flujo del material (TN)" subtitle="Fuentes → 647/540 → ST VENTAS → destinos · pase el cursor para ver TN y % · clic en un nodo para ver el detalle"
        info="Los retornos ST→647/540 y los traspasos entre 647 y 540 se muestran como destinos propios para que el diagrama no tenga ciclos. Los movimientos internos 540→540 no se dibujan.">
        <ResumenSankey flujos={d.flujos} onNode={onNode} />
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
          <span className="flex items-center gap-1"><ArrowLeftRight className="h-3 w-3" />Cambio de lote en el traspaso: <b className="tabular-nums text-slate-700">{fmtTn(k.cambio_lote_tn)} TN</b></span>
          <span>Asignación de contrato (adelanto → contrato): <b className="tabular-nums text-slate-700">{fmtTn(k.asignacion_tn)} TN</b>{' '}
            <Link href={hrefWith('/apt/flujo/adelantos')} className="font-semibold text-[#002855] underline">ver adelantos</Link></span>
        </div>
      </ChartCard>

      {/* Almacenes */}
      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-[11px] font-black uppercase tracking-wider text-slate-500">Dónde está el saldo hoy</h3>
          <Link href={almHref(undefined)} className="text-xs font-semibold text-[#002855] hover:underline">Ver stock por almacén →</Link>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {alm.map(a => <ResumenAlmacenCard key={a.almacen} card={a} total={saldoTotal} href={almHref(a.almacen)} />)}
        </div>
      </section>

      {/* Mensual */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Despachado por origen y lead time" subtitle="TN guiadas por mes según su origen raíz · clic en un mes para filtrarlo"
          info="Origen raíz: de dónde vino el material despachado. 'Stock previo' existía antes del primer día cargado y su antigüedad real es desconocida. La línea es el lead time producción→guía ponderado por TN.">
          <ResumenDespachoMensual data={d.mensual} onMes={mes => patchFilters({ desde: mes.slice(0, 10), hasta: lastDay(mes) })} />
        </ChartCard>
        <ChartCard title="Producción vs traspasos a ST" subtitle="Lo producido en 647 y lo que pasa a ST VENTAS para guiarse"
          info="Barras apiladas 647→ST + 540→ST: lo que se llevó a ST para despachar. La línea roja es el sobrante devuelto de ST a 647/540.">
          <ResumenTraspasosMensual data={d.mensual} />
        </ChartCard>
      </div>
    </div>
  )
}
