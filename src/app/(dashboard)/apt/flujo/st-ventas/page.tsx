'use client'

import { Suspense } from 'react'
import { useRouter } from 'next/navigation'
import { AlarmClock, CalendarCheck2, Hourglass, Info, PackageX, RotateCcw, Truck, Warehouse } from 'lucide-react'
import { flowApi } from '@/lib/apt/api'
import { fmtDate, fmtInt, fmtPct, fmtTn } from '@/lib/apt/format'
import { FLOW_COLOR } from '@/lib/apt/flowColors'
import { traceHref, useFlowFilters } from '@/lib/apt/useFlowFilters'
import { ChartCard, EmptyState, ErrorBlock, KpiCard, LoadingBlock } from '@/components/apt/ui'
import { RankBars, useAsyncData } from '@/components/apt/PphShared'
import { StMensualChart, StSaldoGauge, fmtDiasSt, stSaldoTone } from '@/components/apt/flow/StCharts'
import { StDetenidoTable, StRetornosTable } from '@/components/apt/flow/StTables'

// Control de ST VENTAS: almacén de paso que solo debería tener lo que se guía hoy (saldo ideal 0).
// Mide la rapidez del guiado desde ST, el material detenido y los retornos a 647/540.

export default function StVentasPage() {
  return <Suspense fallback={<LoadingBlock />}><StVentasView /></Suspense>
}

function StVentasView() {
  const { filters, filterKey } = useFlowFilters()
  const router = useRouter()
  const q = useAsyncData(filterKey, () => flowApi.st(filters))
  const d = q.data

  if (q.error && !d) return <ErrorBlock message={q.error} onRetry={q.reload} />
  if (!d) return <LoadingBlock />
  if (d.vacio) return <EmptyState title="Sin movimientos de ST VENTAS">Cargue las hojas de traspasos y SALIDA en “Cargas y parámetros” o amplíe el periodo.</EmptyState>

  const k = d.kpis
  const tone = stSaldoTone(k.saldo_tn)
  const detenidoOrden = [...d.detenido].sort((a, b) => (b.dias ?? -1) - (a.dias ?? -1))
  const topRet = [...d.retornos_lotes].sort((a, b) => b.tn - a.tn).slice(0, 15).map(r => ({
    key: r.lote, label: r.lote, sub: r.cliente, value: r.tn, color: FLOW_COLOR.RETORNO,
    extra: [['Veces devuelto', fmtInt(r.veces)], ['Días en ST (pond.)', fmtDiasSt(r.dias_st)]] as Array<[string, string]>,
  }))

  return (
    <div className={`space-y-4 transition-opacity ${q.loading ? 'opacity-60' : ''}`}>
      <div>
        <h2 className="text-lg font-black text-[#0d9488]">ST VENTAS · zona de despacho</h2>
        <p className="text-xs text-slate-500">
          Movimientos del {fmtDate(d.desde)} al {fmtDate(d.hasta)} · saldo al corte {fmtDate(d.cutoff)}. Meta: guiar el mismo día y dejar ST en 0.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <KpiCard label="Despachado desde ST" value={fmtTn(k.despacho_tn)} unit="TN" tone="navy" icon={<Truck className="h-4 w-4" />}
          hint={`Días ponderados en ST: ${fmtDiasSt(k.dias_pond)}`} />
        <KpiCard label="% mismo día" value={fmtPct(k.mismo_dia_pct)} tone={(k.mismo_dia_pct ?? 0) >= 80 ? 'ok' : 'warn'}
          icon={<CalendarCheck2 className="h-4 w-4" />} hint="TN guiada el mismo día que llegó a ST" />
        <KpiCard label="% 1–3 días" value={fmtPct(k.d1_3_pct)} tone="warn" icon={<AlarmClock className="h-4 w-4" />}
          hint="Esperó en ST entre 1 y 3 días antes de la guía" />
        <KpiCard label="% > 3 días" value={fmtPct(k.mas3_pct)} tone={(k.mas3_pct ?? 0) > 5 ? 'crit' : 'warn'} icon={<Hourglass className="h-4 w-4" />}
          hint="Material que no debió pasar a ST tan pronto" />
        <KpiCard label="Saldo ST" value={fmtTn(k.saldo_tn)} unit="TN" tone={tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'crit'}
          icon={<Warehouse className="h-4 w-4" />} hint="Ideal: 0 TN al cierre de cada día" />
        <KpiCard label="Detenido > 1 día" value={fmtTn(k.detenido_tn)} unit="TN" tone={k.detenido_tn > 0 ? 'crit' : 'ok'}
          icon={<PackageX className="h-4 w-4" />} hint={`${fmtInt(k.detenido_lotes)} lotes · ver tabla abajo`} />
        <KpiCard label="Retornos a almacén" value={fmtTn(k.retorno_tn)} unit="TN" tone={k.retorno_tn > 0 ? 'warn' : 'ok'}
          icon={<RotateCcw className="h-4 w-4" />} hint={`${fmtInt(k.retorno_filas)} movimientos ST → 647/540: doble manipuleo`} />
        <KpiCard label="Días en ST antes del retorno" value={fmtDiasSt(k.retorno_dias_pond)} icon={<Info className="h-4 w-4" />}
          hint="Ponderado por TN: cuánto esperó lo que al final no se guió" />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <ChartCard title="Saldo ideal 0" subtitle="Semáforo del stock actual en ST VENTAS"
          info="ST VENTAS es un almacén de paso: solo debería tener lo que se guía hoy. Lo que sobra se devuelve a 647/540.">
          <StSaldoGauge saldo={k.saldo_tn} detenido={k.detenido_tn} lotes={k.detenido_lotes} />
        </ChartCard>
        <ChartCard className="xl:col-span-2" title="Guiado mensual desde ST por días de permanencia"
          subtitle="TN guiadas por días en ST (barras apiladas), retornos (barra roja) y % mismo día (línea)"
          info="Mes de la guía. Una barra mayormente teal indica un ST sano; el ámbar y el rojo son material que esperó en la zona de despacho.">
          <StMensualChart data={d.mensual} />
        </ChartCard>
      </div>

      <StDetenidoTable rows={detenidoOrden} />

      <div className="grid gap-4 xl:grid-cols-5">
        <ChartCard className="xl:col-span-2" title="Lotes con más retornos" subtitle="Top 15 por TN devuelta de ST a 647/540 · clic abre la trazabilidad"
          info="Lotes que se pasaron a ST y volvieron: suelen ser despachos reprogramados o mal planificados.">
          <RankBars items={topRet} format={v => `${fmtTn(v)} TN`} color={FLOW_COLOR.RETORNO} labelWidth={110}
            onSelect={lote => router.push(traceHref(lote))} />
        </ChartCard>
        <div className="xl:col-span-3">
          <StRetornosTable rows={d.retornos} />
        </div>
      </div>
    </div>
  )
}
