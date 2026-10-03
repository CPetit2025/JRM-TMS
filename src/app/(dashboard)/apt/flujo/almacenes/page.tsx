'use client'

import { useCallback } from 'react'
import Link from 'next/link'
import { CalendarClock, Info } from 'lucide-react'
import { flowApi } from '@/lib/apt/api'
import { fmtDate, fmtTn } from '@/lib/apt/format'
import { ALMACEN_COLOR, FLOW_ALMACENES } from '@/lib/apt/flowColors'
import { ALMACEN_LABEL, type FlowAlmacen } from '@/lib/apt/flowTypes'
import { useFlowFilters } from '@/lib/apt/useFlowFilters'
import { ChartCard, EmptyState, ErrorBlock, LoadingBlock } from '@/components/apt/ui'
import { ResumenAlmacenCard, useFlowQuery } from '@/components/apt/flow/ResumenShared'
import { AlmacenAging, AlmacenMovimientos, AlmacenSerie } from '@/components/apt/flow/AlmacenCharts'
import { AlmacenLotesTable } from '@/components/apt/flow/AlmacenLotesTable'

// Stock por almacén: dónde está el saldo (647 · 540 · ST VENTAS), cómo evolucionó, qué antigüedad tiene y qué lotes lo forman.

export default function FlujoAlmacenesPage() {
  const { filters, patchFilters, setFilters, filterKey } = useFlowFilters()
  const fetcher = useCallback(() => flowApi.stock(filters), [filters])
  const { data: d, error, loading, retry } = useFlowQuery(filterKey, fetcher)
  const sel = filters.almacen
  const pick = (a?: FlowAlmacen) => patchFilters({ almacen: a })

  const tabs = (
    <div className="inline-flex flex-wrap rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm" role="tablist" aria-label="Almacén">
      {([undefined, ...FLOW_ALMACENES] as Array<FlowAlmacen | undefined>).map(a => {
        const on = sel === a
        const saldo = a ? d?.resumen.find(r => r.almacen === a)?.saldo_tn : d?.resumen.reduce((s, r) => s + Number(r.saldo_tn || 0), 0)
        return (
          <button key={a ?? 'todos'} role="tab" aria-selected={on} onClick={() => pick(a)}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold transition-colors ${on ? 'text-white shadow-sm' : 'text-slate-600 hover:bg-slate-50'}`}
            style={on ? { background: a ? ALMACEN_COLOR[a] : '#002855' } : undefined}>
            {a && !on && <span className="h-2 w-2 rounded-full" style={{ background: ALMACEN_COLOR[a] }} />}
            {a ? ALMACEN_LABEL[a] : 'Todos'}
            {saldo !== undefined && <span className={`tabular-nums font-semibold ${on ? 'text-white/80' : 'text-slate-400'}`}>{fmtTn(saldo)}</span>}
          </button>
        )
      })}
    </div>
  )

  if (!d && loading) return <div className="space-y-4">{tabs}<LoadingBlock label="Calculando el stock por almacén…" className="h-96" /></div>
  if (error) return <div className="space-y-4">{tabs}<ErrorBlock message={error} onRetry={retry} /></div>
  if (!d) return <LoadingBlock className="h-96" />
  if (d.vacio) {
    return (
      <EmptyState title="Aún no hay datos del flujo multi-almacén">
        Cargue producción, traspasos, despachos y consumos para reconstruir el saldo de cada almacén.{' '}
        <Link href="/apt/cargas" className="font-semibold text-[#002855] underline">Ir a Cargas y parámetros</Link>
      </EmptyState>
    )
  }

  const total = d.resumen.reduce((s, r) => s + Number(r.saldo_tn || 0), 0)
  const cards = FLOW_ALMACENES.map(a => d.resumen.find(r => r.almacen === a)).filter((x): x is NonNullable<typeof x> => !!x)
  const lotes = sel ? d.lotes.filter(l => l.almacen === sel) : d.lotes
  const movAlm = sel ? [sel] : FLOW_ALMACENES.filter(a => d.movimientos.some(m => m.almacen === a))
  const hasFilters = Object.keys(filters).some(k => k !== 'almacen')

  return (
    <div className={`space-y-4 transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {tabs}
        <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
          <CalendarClock className="h-3.5 w-3.5 text-slate-400" />
          Saldo al corte <b className="text-slate-700">{fmtDate(d.cutoff)}</b> · movimientos {fmtDate(d.desde)} – {fmtDate(d.hasta)} · alerta &gt; {d.alert_days} d
        </p>
      </div>

      {/* Tarjetas */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {cards.map(c => <ResumenAlmacenCard key={c.almacen} card={c} total={total} active={sel === c.almacen} onClick={() => pick(sel === c.almacen ? undefined : c.almacen)} />)}
      </div>
      <p className="flex items-start gap-1.5 text-[11px] text-slate-400">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        Edad = días desde la producción · Días en almacén = desde que llegó a ese almacén (ambos ponderados por TN).
        Stock previo: existía antes del primer día cargado; su antigüedad real es desconocida.
      </p>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <ChartCard className="lg:col-span-7" title="Evolución semanal del saldo" subtitle="TN al cierre de cada semana por almacén"
          info="ST VENTAS debería estar cerca de 0: lo que entra se guía el mismo día. Un área de ST que crece indica material detenido.">
          <AlmacenSerie data={d.serie} active={sel} />
        </ChartCard>
        <ChartCard className="lg:col-span-5" title="Aging del saldo por almacén" subtitle="TN por rango de días desde la producción · clic para elegir el almacén"
          info="El stock inicial (sin fecha) aparece en gris rayado: existía antes del primer día cargado.">
          <AlmacenAging data={d.aging} active={sel} onSelect={a => pick(a)} />
        </ChartCard>
      </div>

      <ChartCard title="Ingresos vs salidas por mes" subtitle="Arriba lo que entra (producción, traspasos recibidos); abajo lo que sale (guías, traspasos enviados, consumo)"
        info="Barras divergentes por almacén. Si las salidas igualan a los ingresos el saldo no crece.">
        <div className={`grid grid-cols-1 gap-4 ${movAlm.length > 1 ? 'xl:grid-cols-3' : ''}`}>
          {movAlm.map(a => (
            <div key={a} className="min-w-0">
              <p className="mb-1 text-[11px] font-black uppercase tracking-wider" style={{ color: ALMACEN_COLOR[a] }}>{ALMACEN_LABEL[a]}</p>
              <AlmacenMovimientos data={d.movimientos} almacen={a} />
            </div>
          ))}
          {!movAlm.length && <p className="py-12 text-center text-sm text-slate-400">Sin movimientos en el periodo.</p>}
        </div>
      </ChartCard>

      <ChartCard title={`Lotes con saldo${sel ? ` · ${ALMACEN_LABEL[sel]}` : ''}`}
        subtitle="Ordenados por TN×Días (los 300 de mayor impacto) · clic en un lote para ver su trazabilidad" bodyClassName="p-0 sm:p-2">
        {lotes.length ? (
          <AlmacenLotesTable key={filterKey} rows={lotes} alertDays={d.alert_days} cutoff={d.cutoff} />
        ) : (
          <div className="p-4">
            <EmptyState title="Sin lotes con saldo">
              {hasFilters && <button onClick={() => setFilters(sel ? { almacen: sel } : {})} className="font-semibold text-[#002855] underline">Quitar filtros</button>}
            </EmptyState>
          </div>
        )}
      </ChartCard>
    </div>
  )
}
