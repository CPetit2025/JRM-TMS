'use client'
import { DataTable } from '@/components/ui/data-table'

import { useCallback } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, GitBranch, Info, Truck, XCircle } from 'lucide-react'
import { flowApi } from '@/lib/apt/api'
import { fmtDate, fmtDateTime, fmtInt, fmtPct, fmtTn } from '@/lib/apt/format'
import { ALMACEN_COLOR } from '@/lib/apt/flowColors'
import { ALMACEN_LABEL, type FlowQuality } from '@/lib/apt/flowTypes'
import { ChartCard, ErrorBlock, LoadingBlock } from '@/components/apt/ui'
import { useAptQuery } from '@/components/apt/TfcShared'

// Calidad del flujo multi-almacén (647 · 540 · ST): alertas, hojas leídas, cuadre de saldos por almacén, emparejamiento de traspasos,
// cobertura de guías en el TMS y conciliación con la estadía consolidada.

const HOJA_LABEL: Record<string, string> = {
  ENTRADA: 'ENTRADA', SALIDA: 'SALIDA', TRASPASO_SAL: 'Traspasos salidas', TRASPASO_ENT: 'Traspasos entradas', CONSUMO: 'Consumos', DEVOLUCION: 'Devoluciones',
}
const HOJA_ORDEN = ['ENTRADA', 'SALIDA', 'TRASPASO_SAL', 'TRASPASO_ENT', 'CONSUMO', 'DEVOLUCION']

const NIVEL = {
  error: { cls: 'border-red-200 bg-red-50 text-red-900', icon: XCircle, ic: 'text-red-600', label: 'Error' },
  aviso: { cls: 'border-amber-200 bg-amber-50 text-amber-900', icon: AlertTriangle, ic: 'text-amber-600', label: 'Aviso' },
  info: { cls: 'border-sky-200 bg-sky-50 text-sky-900', icon: Info, ic: 'text-sky-600', label: 'Info' },
} as const
const AREA_LABEL: Record<string, string> = { st: 'ST VENTAS', almacenes: 'Almacenes', calidad: 'Calidad', adelantos: 'Adelantos / 540' }
const AREA_HREF: Record<string, string> = { st: '/apt/flujo/st-ventas', almacenes: '/apt/flujo/almacenes', adelantos: '/apt/flujo/adelantos' }

const TOL = 0.001

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2">
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="text-lg font-black tabular-nums text-slate-900">{value}</p>
      {hint && <p className="text-[10px] leading-snug text-slate-500">{hint}</p>}
    </div>
  )
}

export function CalidadFlujo() {
  const fetcher = useCallback(() => flowApi.quality(), [])
  const { data, error, loading, retry } = useAptQuery<FlowQuality>(fetcher)

  const title = (
    <div className="flex flex-wrap items-end justify-between gap-2 border-t border-slate-200 pt-6">
      <div>
        <h2 className="flex items-center gap-2 text-base font-black text-slate-900"><GitBranch className="h-5 w-5 text-[#002855]" /> Flujo multi‑almacén</h2>
        <p className="text-xs text-slate-500">Controles del modelo 647 · 540 · ST VENTAS: traspasos, consumos y su cuadre por almacén.</p>
      </div>
      {data?.cutoff && (
        <p className="text-[11px] text-slate-500">
          Datos {fmtDate(data.data_min)} – {fmtDate(data.cutoff)}{data.rebuilt_at && <> · recalculado {fmtDateTime(data.rebuilt_at)}</>}
        </p>
      )}
    </div>
  )

  if (error && !data) return <section className="space-y-4">{title}<ErrorBlock message={error} onRetry={retry} /></section>
  if (!data) return <section className="space-y-4">{title}<LoadingBlock className="h-40" label="Revisando el flujo multi‑almacén…" /></section>
  if (!data.cutoff) {
    return (
      <section className="space-y-4">{title}
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
          El flujo multi‑almacén aún no se ha calculado. Cargue las hojas de traspasos y consumos en <Link href="/apt/cargas" className="font-semibold text-[#002855] underline">Cargas</Link>.
        </p>
      </section>
    )
  }

  const s = data.stats
  const hojas = [...data.hojas].sort((a, b) => {
    const ia = HOJA_ORDEN.indexOf(a.tipo), ib = HOJA_ORDEN.indexOf(b.tipo)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
  const cuadra = data.almacenes.every(a => Math.abs(a.diferencia_tn) < TOL)
  const emp = s.traspasos_emparejados ?? 0
  const pSal = s.traspasos_sal ? (emp / s.traspasos_sal) * 100 : null
  const pEnt = s.traspasos_ent ? (emp / s.traspasos_ent) * 100 : null
  const tmsPct = data.tms.guias_30d ? (data.tms.en_tms / data.tms.guias_30d) * 100 : null
  const est = data.estadia
  const difEst = est.saldo_estadia_tn - est.saldo_produccion_flujo_tn

  return (
    <section className={`space-y-4 transition-opacity ${loading ? 'opacity-60' : ''}`}>
      {title}

      {data.alertas.length ? (
        <ul className="space-y-2">
          {data.alertas.map((a, i) => {
            const n = NIVEL[a.nivel] || NIVEL.info
            const Icon = n.icon
            const href = AREA_HREF[a.area]
            return (
              <li key={i} className={`flex items-start gap-3 rounded-xl border p-3 text-xs shadow-sm ${n.cls}`}>
                <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${n.ic}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="mb-0.5 text-[10px] font-black uppercase tracking-wider opacity-70">{n.label} · {AREA_LABEL[a.area] || a.area}</p>
                  <p>{a.mensaje}</p>
                </div>
                {href && <Link href={href} className="shrink-0 self-center whitespace-nowrap font-bold underline">Ver detalle</Link>}
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900 shadow-sm">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" /> Sin alertas en el flujo multi‑almacén.
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Hojas cargadas del flujo" subtitle="Filas leídas, válidas y excluidas por hoja" bodyClassName="p-0">
          <div className="overflow-x-auto">
            <DataTable className="w-full min-w-[560px] text-xs">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left font-bold">Hoja</th>
                  <th className="px-3 py-2 text-right font-bold">Filas</th>
                  <th className="px-3 py-2 text-right font-bold">Válidas</th>
                  <th className="px-3 py-2 text-right font-bold">Excluidas</th>
                  <th className="px-3 py-2 text-right font-bold">TN</th>
                  <th className="px-3 py-2 text-right font-bold">Fechas</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {hojas.map(h => (
                  <tr key={h.tipo} className="hover:bg-slate-50">
                    <td className="px-3 py-2 font-semibold text-slate-800">{HOJA_LABEL[h.tipo] || h.tipo}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtInt(h.filas)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtInt(h.validas)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${h.excluidas ? 'font-bold text-amber-700' : 'text-slate-400'}`}>{fmtInt(h.excluidas)}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtTn(h.tn)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-500">{fmtDate(h.desde)} – {fmtDate(h.hasta)}</td>
                  </tr>
                ))}
                {!hojas.length && <tr><td colSpan={6} className="p-4 text-center text-slate-500">Sin hojas cargadas.</td></tr>}
              </tbody>
            </DataTable>
          </div>
        </ChartCard>

        <ChartCard title="Cuadre por almacén" subtitle="Inicial + ingresos − salidas = saldo · la diferencia debe ser 0"
          info="Inicial: stock previo inferido (existía antes del primer día cargado). Traspasos sin pareja: salieron de un almacén APT sin llegada registrada en otro (o al revés)."
          actions={<span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${cuadra ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}`}>{cuadra ? '✓ Cuadra' : 'No cuadra'}</span>}
          bodyClassName="p-0">
          <div className="overflow-x-auto">
            <DataTable className="w-full min-w-[620px] text-xs">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left font-bold">Almacén</th>
                  <th className="px-3 py-2 text-right font-bold">Inicial</th>
                  <th className="px-3 py-2 text-right font-bold">+ Ingresos</th>
                  <th className="px-3 py-2 text-right font-bold">− Salidas</th>
                  <th className="px-3 py-2 text-right font-bold">= Saldo</th>
                  <th className="px-3 py-2 text-right font-bold">Diferencia</th>
                  <th className="px-3 py-2 text-right font-bold" title="Traspasos sin destino / sin origen APT">Sin pareja</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.almacenes.map(a => {
                  const ok = Math.abs(a.diferencia_tn) < TOL
                  return (
                    <tr key={a.almacen} className="hover:bg-slate-50">
                      <td className="whitespace-nowrap px-3 py-2 font-semibold text-slate-800">
                        <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: ALMACEN_COLOR[a.almacen] }} />{ALMACEN_LABEL[a.almacen] || a.almacen}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtTn(a.inicial_tn)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtTn(a.ingresos_tn)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtTn(a.salidas_tn)}</td>
                      <td className="px-3 py-2 text-right font-bold tabular-nums text-slate-900">{fmtTn(a.saldo_tn)}</td>
                      <td className={`px-3 py-2 text-right font-bold tabular-nums ${ok ? 'text-emerald-600' : 'text-red-600'}`}>{ok ? '✓ 0' : fmtTn(a.diferencia_tn)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-500">{fmtTn(a.traspasos_sin_destino_tn)} / {fmtTn(a.traspasos_sin_origen_tn)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </DataTable>
          </div>
        </ChartCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <ChartCard title="Emparejamiento de traspasos" subtitle="Cada salida por traspaso debe tener su entrada en el almacén destino"
          info="Se empareja la hoja de traspasos (salidas) con la de traspasos (entradas) por documento, lote, producto y peso. Lo no emparejado suele ser un traspaso a otros almacenes fuera de APT.">
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Emparejados" value={fmtInt(emp)} hint="Pares salida ↔ entrada" />
            <Stat label="% de salidas" value={fmtPct(pSal)} hint={`${fmtInt(s.traspasos_sal)} salidas`} />
            <Stat label="% de entradas" value={fmtPct(pEnt)} hint={`${fmtInt(s.traspasos_ent)} entradas`} />
            <Stat label="Capas · piezas" value={`${fmtInt(s.capas)} · ${fmtInt(s.piezas)}`} hint={`${fmtInt(s.salidas)} salidas · ${fmtInt(s.rondas)} rondas FIFO`} />
          </div>
        </ChartCard>

        <ChartCard title="Guías en el TMS" subtitle="Guías de los últimos 30 días registradas en el Asistente Documentario">
          <div className="flex items-center gap-3">
            <Truck className="h-8 w-8 shrink-0 text-[#2563eb]" />
            <div className="flex-1">
              <p className="text-2xl font-black tabular-nums text-slate-900">{fmtInt(data.tms.en_tms)} <span className="text-sm font-semibold text-slate-400">de {fmtInt(data.tms.guias_30d)}</span></p>
              <div className="mt-1 h-2 w-full rounded-full bg-slate-100">
                <div className="h-2 rounded-full bg-[#2563eb]" style={{ width: `${Math.min(100, tmsPct ?? 0)}%` }} />
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                {fmtPct(tmsPct)} de cobertura. {tmsPct !== null && tmsPct < 50 ? 'La mayoría de guías aún no se cruzan con un despacho del TMS: el estado del transporte no se verá en la trazabilidad.' : 'Las guías se cruzan con su despacho en la trazabilidad.'}
              </p>
            </div>
          </div>
        </ChartCard>

        <ChartCard title="Estadía vs flujo" subtitle="Saldo de producción según cada modelo">
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Estadía APT" value={`${fmtTn(est.saldo_estadia_tn)} TN`} hint="FIFO de ENTRADA y SALIDA" />
            <Stat label="Flujo (producción)" value={`${fmtTn(est.saldo_produccion_flujo_tn)} TN`} hint="Saldo de producción en 647 · 540 · ST" />
          </div>
          <p className="mt-2 text-xs text-slate-600">
            Diferencia: <b className="tabular-nums">{fmtTn(difEst)} TN</b>. {est.explicacion}
          </p>
        </ChartCard>
      </div>
    </section>
  )
}
