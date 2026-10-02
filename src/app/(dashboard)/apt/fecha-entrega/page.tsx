'use client'

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { Bar, BarChart, CartesianGrid, Cell, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { CalendarCheck, ExternalLink, Info } from 'lucide-react'
import { aptApi } from '@/lib/apt/api'
import { APT_COLORS, fmtDate, fmtDec1, fmtDias, fmtInt, fmtPct, fmtTn } from '@/lib/apt/format'
import { exportAptXlsx } from '@/lib/apt/export'
import { loteHref, useAptFilters } from '@/lib/apt/useAptFilters'
import type { AptFeClase, AptFechaEntrega } from '@/lib/apt/types'
import { ChartCard, EmptyState, ErrorBlock, InlineBar, KpiCard, LoadingBlock } from '@/components/apt/ui'
import { AXIS_TICK, ChartTip, ExportButton, SortTh, addDays, diffDays, sortRows, useAptQuery, type SortState } from '@/components/apt/TfcShared'

// FechaEntrega: relación entre la fecha de ingreso a APT / de despacho y la FechaEntrega del ERP.
// Es un análisis separado del aging: los estados describen la relación de fechas sin calificarla.

const CLASES: Array<{ clase: AptFeClase; color: string; help: string }> = [
  { clase: 'Antes de FechaEntrega', color: '#0891b2', help: 'La fecha del movimiento es anterior a la FechaEntrega' },
  { clase: 'En fecha', color: APT_COLORS.navy, help: 'La fecha del movimiento coincide con la FechaEntrega' },
  { clase: 'Después de FechaEntrega', color: '#9333ea', help: 'La fecha del movimiento es posterior a la FechaEntrega' },
  { clase: 'Sin FechaEntrega', color: '#94a3b8', help: 'La capa no trae FechaEntrega en el ERP' },
]

const signedDias = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtDec1(Math.abs(v))} días`

function ClaseCard({ clase, color, help, tn, total, capas, dias, base }: {
  clase: string; color: string; help: string; tn: number; total: number; capas?: number; dias: number | null; base: string
}) {
  const pct = total > 0 ? (tn / total) * 100 : null
  return (
    <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-white p-4 shadow-sm" title={help}>
      <span className="absolute inset-x-0 top-0 h-1" style={{ background: color }} />
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />{clase}
      </p>
      <p className="mt-2 text-2xl font-black tabular-nums tracking-tight text-slate-900">
        {fmtTn(tn)}<span className="ml-1 text-sm font-semibold text-slate-400">TN</span>
      </p>
      <div className="mt-1.5"><InlineBar value={tn} max={total} color={color} /></div>
      <div className="mt-2 space-y-0.5 text-[11px] text-slate-500">
        <p><b className="text-slate-700">{fmtPct(pct)}</b> de las TN{capas !== undefined ? <> · <b className="text-slate-700">{fmtInt(capas)}</b> capas</> : null}</p>
        <p>Diferencia prom. {base}: <b className="text-slate-700">{signedDias(dias)}</b></p>
      </div>
    </div>
  )
}

export default function FechaEntregaPage() {
  const { filters, hrefWith } = useAptFilters()
  const fetcher = useCallback(() => aptApi.fechaEntrega(filters), [filters])
  const { data, error, loading, retry } = useAptQuery<AptFechaEntrega>(fetcher)
  const [sort, setSort] = useState<SortState>({ key: 'tn', desc: true })

  const ing = useMemo(() => CLASES.map(c => {
    const r = data?.ingreso_vs_fe.find(x => x.clase === c.clase)
    return { ...c, capas: r?.capas ?? 0, tn: r?.tn ?? 0, dias: r?.dias_prom ?? null }
  }), [data])
  const sal = useMemo(() => CLASES.map(c => {
    const r = data?.salida_vs_fe.find(x => x.clase === c.clase)
    return { ...c, tn: r?.tn ?? 0, dias: r?.dias_prom ?? null }
  }), [data])
  const totIn = ing.reduce((s, r) => s + r.tn, 0)
  const totOut = sal.reduce((s, r) => s + r.tn, 0)

  const dist = useMemo(() => (data?.distribucion_ingreso ?? []).map(d => ({
    rango: d.rango, ingreso: d.tn, capas: d.capas,
    salida: data?.distribucion_salida.find(s => s.rango === d.rango)?.tn ?? 0,
  })), [data])

  const cutoff = data?.cutoff ?? null
  const top = useMemo(() => sortRows((data?.top_lotes_saldo_vencido ?? []).map(r => ({
    ...r, dias_apt: cutoff ? diffDays(cutoff, r.primer_ingreso) : null,
  })), sort), [data, cutoff, sort])
  const maxTop = Math.max(0, ...top.map(r => r.tn))

  const doExport = () => {
    if (!data) return
    exportAptXlsx('APT_fecha_entrega', {
      'Ingreso vs FechaEntrega': ing.map(r => ({ Clase: r.clase, Capas: r.capas, TN: r.tn, '% TN': totIn ? (r.tn / totIn) * 100 : null, 'Dif. prom. días (ingreso − FE)': r.dias })),
      'Despacho vs FechaEntrega': sal.map(r => ({ Clase: r.clase, TN: r.tn, '% TN': totOut ? (r.tn / totOut) * 100 : null, 'Dif. prom. días (despacho − FE)': r.dias })),
      Distribucion: dist.map(d => ({ 'Diferencia (días)': d.rango, 'TN ingreso': d.ingreso, 'Capas ingreso': d.capas, 'TN despacho': d.salida })),
      'Saldo con FE pasada': top.map(r => ({
        Lote: r.lote, 'TN saldo': r.tn, FechaEntrega: fmtDate(r.fecha_entrega), 'Días desde FE': r.dias_desde_fe,
        'Primer ingreso': fmtDate(r.primer_ingreso), 'Días desde primer ingreso': r.dias_apt,
      })),
    })
  }

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-base font-black text-slate-900">FechaEntrega</h2>
        <p className="text-xs text-slate-500">Relación entre las fechas de ingreso a APT y de despacho con la FechaEntrega del ERP. Análisis separado del aging.</p>
      </div>
      {data && <ExportButton onClick={doExport} />}
    </div>
  )

  if (error && !data) return <div className="space-y-4">{header}<ErrorBlock message={error} onRetry={retry} /></div>
  if (!data) return <div className="space-y-4">{header}<LoadingBlock /></div>
  if (totIn === 0) {
    return <div className="space-y-4">{header}<EmptyState title="Aún no hay movimientos: cargue ENTRADA y SALIDA">No hay capas con los filtros actuales.</EmptyState></div>
  }

  const sv = data.saldo_vencido
  const detalleVencido = cutoff ? hrefWith('/apt/detalle', { solo_saldo: true, entrega_hasta: addDays(cutoff, -1) }) : null

  return (
    <div className={`space-y-4 transition-opacity ${loading ? 'opacity-60' : ''}`}>
      {header}

      <section className="space-y-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Ingreso a APT vs FechaEntrega <span className="font-normal normal-case">· {fmtTn(totIn)} TN ingresadas</span></h3>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {ing.map(r => <ClaseCard key={r.clase} {...r} total={totIn} base="(ingreso − FE)" />)}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Despacho vs FechaEntrega <span className="font-normal normal-case">· {fmtTn(totOut)} TN despachadas de lo ingresado</span></h3>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {sal.map(r => <ClaseCard key={r.clase} {...r} total={totOut} base="(despacho − FE)" />)}
        </div>
      </section>

      <ChartCard title="Distribución de la diferencia en días respecto a la FechaEntrega"
        subtitle="Negativo = antes de la FechaEntrega · 0 = el mismo día · positivo = después. TN por rango de diferencia."
        info="Ingreso: fecha de ingreso a APT − FechaEntrega de la capa. Despacho: fecha de cada salida asignada por FIFO − FechaEntrega de la capa que consume. Capas sin FechaEntrega no se incluyen.">
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={dist} margin={{ top: 20, right: 8, left: 0, bottom: 0 }} barGap={2}>
              <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="rango" tick={AXIS_TICK} axisLine={false} tickLine={false} interval={0}
                tickFormatter={v => (v === '0' ? '0 (FE)' : v)} />
              <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} tickFormatter={v => fmtInt(v)} />
              <Tooltip cursor={{ fill: '#f1f5f9' }} content={
                <ChartTip labelFmt={l => (l === '0' ? 'Mismo día que la FechaEntrega' : `${String(l)} días respecto a la FechaEntrega`)}
                  fmt={v => `${fmtTn(Number(v))} TN`}
                  extra={r => <>{fmtInt(Number(r.capas))} capas ingresadas en este rango</>} />} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine x="0" stroke={APT_COLORS.navy} strokeDasharray="4 3" strokeOpacity={0.5}
                label={{ value: 'FechaEntrega', position: 'top', fontSize: 11, fill: APT_COLORS.navy, fontWeight: 700 }} />
              <Bar dataKey="ingreso" name="Ingreso a APT" fill={APT_COLORS.in} radius={[4, 4, 0, 0]} maxBarSize={36}>
                {dist.map(d => <Cell key={d.rango} fill={d.rango === '0' ? APT_COLORS.navy : APT_COLORS.in} />)}
              </Bar>
              <Bar dataKey="salida" name="Despacho" fill={APT_COLORS.out} radius={[4, 4, 0, 0]} maxBarSize={36}>
                {dist.map(d => <Cell key={d.rango} fill={d.rango === '0' ? '#115e59' : APT_COLORS.out} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>

      <ChartCard title={<><CalendarCheck className="h-4 w-4 text-[#002855]" /> Saldo en APT con FechaEntrega ya pasada</>}
        subtitle={`Saldo cuyo FechaEntrega es anterior al corte (${fmtDate(cutoff)})`}
        actions={detalleVencido ? (
          <Link href={detalleVencido} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-700 hover:border-[#002855] hover:text-[#002855]">
            Ver capas en Detalle <ExternalLink className="h-3 w-3" />
          </Link>
        ) : null}>
        <div className="grid gap-3 sm:grid-cols-3">
          <KpiCard label="TN con FechaEntrega pasada" value={fmtTn(sv.tn)} unit="TN" tone="navy" />
          <KpiCard label="Días prom. desde la FechaEntrega" value={fmtDec1(sv.dias_prom_pond)} unit="días" hint="Ponderado por TN de saldo" />
          <KpiCard label="Saldo sin FechaEntrega" value={fmtTn(sv.tn_sin_fe)} unit="TN" hint="No se puede comparar con la FechaEntrega" />
        </div>
        {top.length ? (
          <div className="mt-4 max-h-[460px] overflow-auto rounded-lg border border-slate-100">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500 shadow-[0_1px_0_#e2e8f0]">
                <tr>
                  <SortTh k="lote" sort={sort} onSort={setSort} right={false}>Lote (NumRel)</SortTh>
                  <SortTh k="tn" sort={sort} onSort={setSort}>TN saldo</SortTh>
                  <th className="px-3 py-2"><span className="sr-only">Proporción</span></th>
                  <SortTh k="fecha_entrega" sort={sort} onSort={setSort}>FechaEntrega</SortTh>
                  <SortTh k="dias_desde_fe" sort={sort} onSort={setSort}>Días desde FE</SortTh>
                  <SortTh k="primer_ingreso" sort={sort} onSort={setSort}>Primer ingreso</SortTh>
                  <SortTh k="dias_apt" sort={sort} onSort={setSort} title="Corte − primer ingreso a APT">Días desde ingreso</SortTh>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {top.map(r => (
                  <tr key={r.lote} className="hover:bg-slate-50">
                    <td className="px-3 py-1.5">
                      <Link href={loteHref(r.lote, filters)} className="font-bold text-[#002855] hover:underline">{r.lote}</Link>
                    </td>
                    <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{fmtTn(r.tn)}</td>
                    <td className="w-32 px-3 py-1.5"><InlineBar value={r.tn} max={maxTop} /></td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtDate(r.fecha_entrega)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtDias(r.dias_desde_fe)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtDate(r.primer_ingreso)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtDias(r.dias_apt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-4 text-sm text-slate-500">No hay saldo con FechaEntrega anterior al corte.</p>
        )}
        {top.length >= 15 && <p className="mt-2 text-[11px] text-slate-400">Se muestran los 15 lotes con más TN; el detalle completo está en “Ver capas en Detalle”.</p>}
      </ChartCard>

      <div className="flex gap-2 rounded-xl border border-slate-200 bg-white p-4 text-xs leading-relaxed text-slate-600 shadow-sm">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
        <p>
          <b>Nota metodológica.</b> La FechaEntrega viene del ERP (hoja ENTRADA) y no reemplaza la fecha de ingreso a APT: la permanencia y el aging se
          calculan siempre desde el ingreso. Las clases “Antes de”, “En fecha” y “Después de FechaEntrega” solo describen la relación entre fechas, sin
          calificarla; la FechaEntrega puede ser una fecha comprometida, estimada o reprogramada. Las diferencias de despacho se miden con las salidas
          asignadas por FIFO a cada capa.
        </p>
      </div>
    </div>
  )
}
