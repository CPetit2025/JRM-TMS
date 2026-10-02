'use client'

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import {
  Area, Bar, BarChart, Brush, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { ArrowDownRight, ArrowUpRight, ExternalLink, Minus, TrendingDown, TrendingUp } from 'lucide-react'
import { aptApi } from '@/lib/apt/api'
import { APT_COLORS, fmtDate, fmtDec1, fmtDias, fmtInt, fmtPct, fmtTn } from '@/lib/apt/format'
import { exportAptXlsx } from '@/lib/apt/export'
import { useAptFilters } from '@/lib/apt/useAptFilters'
import type { AptGrain, AptTrendPoint } from '@/lib/apt/types'
import { ChartCard, EmptyState, ErrorBlock, KpiCard, LoadingBlock } from '@/components/apt/ui'
import {
  AXIS_TICK, ChartTip, ExportButton, Segmented, SortTh, addDays, sortRows, useAptQuery, type SortState,
} from '@/components/apt/TfcShared'

// Tendencias: evolución de ingresos, despachos, saldo y aging ponderado por día, semana o mes

const GRAINS: Array<{ value: AptGrain; label: string }> = [
  { value: 'dia', label: 'Día' }, { value: 'semana', label: 'Semana' }, { value: 'mes', label: 'Mes' },
]
const GRAIN_NOUN: Record<AptGrain, string> = { dia: 'día', semana: 'semana', mes: 'mes' }
const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Set', 'Oct', 'Nov', 'Dic']

function periodLabel(grain: AptGrain, iso: string, long = false) {
  const [y, m, d] = iso.slice(0, 10).split('-')
  if (grain === 'mes') return `${MESES[Number(m) - 1]} ${y}`
  if (grain === 'semana') return `Sem. ${d}/${m}`
  return long ? fmtDate(iso) : `${d}/${m}`
}

// Fin natural del periodo (para saber si el último está incompleto por la fecha de corte)
function naturalEnd(grain: AptGrain, iso: string) {
  if (grain === 'dia') return iso.slice(0, 10)
  if (grain === 'semana') return addDays(iso, 6)
  const [y, m] = iso.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

type Row = AptTrendPoint & { label: string }

const tipFmt = (v: unknown, k: string) => {
  if (v === null || v === undefined) return '—'
  if (k === 'aging_pond' || k === 'dias_prom_despacho') return `${fmtDec1(Number(v))} días`
  if (k.startsWith('lotes')) return fmtInt(Number(v))
  return `${fmtTn(Number(v))} TN`
}

function Delta({ value, unit, digits = 'tn' }: { value: number | null; unit: string; digits?: 'tn' | 'dias' }) {
  if (value === null || Number.isNaN(value)) return <span className="text-slate-400">sin periodo anterior</span>
  const flat = Math.abs(value) < (digits === 'tn' ? 0.005 : 0.05)
  const up = value > 0
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight
  // Más saldo o más aging = más carga en APT (rojo); menos = verde
  const cls = flat ? 'text-slate-500' : up ? 'text-red-600' : 'text-emerald-600'
  const txt = digits === 'tn' ? fmtTn(Math.abs(value)) : fmtDec1(Math.abs(value))
  return (
    <span className={`inline-flex items-center gap-0.5 font-bold ${cls}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden />{flat ? '0' : `${up ? '+' : '−'}${txt}`} {unit}
    </span>
  )
}

export default function TendenciasPage() {
  const { filters, hrefWith } = useAptFilters()
  const [grain, setGrain] = useState<AptGrain>('semana')
  const fetcher = useCallback(() => aptApi.trends(filters, grain), [filters, grain])
  const { data, error, loading, retry } = useAptQuery(fetcher)
  const [brush, setBrush] = useState<{ key: string; start: number; end: number } | null>(null)
  const [sort, setSort] = useState<SortState>({ key: 'periodo', desc: true })

  const dataGrain = data?.grain ?? grain
  const rows: Row[] = useMemo(
    () => (data?.series ?? []).map(p => ({ ...p, label: periodLabel(dataGrain, p.periodo) })),
    [data, dataGrain],
  )

  // Rango visible: en series diarias largas se muestra por defecto los últimos 90 días
  const useBrush = dataGrain === 'dia' && rows.length > 60
  const brushKey = `${dataGrain}|${rows.length}|${rows[0]?.periodo ?? ''}`
  const range = useBrush
    ? (brush && brush.key === brushKey ? brush : { key: brushKey, start: Math.max(0, rows.length - 90), end: rows.length - 1 })
    : { key: brushKey, start: 0, end: Math.max(rows.length - 1, 0) }
  const visible = useBrush ? rows.slice(range.start, range.end + 1) : rows

  const summary = useMemo(() => {
    if (!rows.length) return null
    const last = rows[rows.length - 1]
    const prev = rows.length > 1 ? rows[rows.length - 2] : null
    const tnIn = rows.reduce((s, r) => s + r.tn_in, 0)
    const tnOut = rows.reduce((s, r) => s + r.tn_out, 0)
    const lotesIn = rows.reduce((s, r) => s + r.lotes_ingresados, 0)
    const lotesOut = rows.reduce((s, r) => s + r.lotes_despachados, 0)
    const entradas = rows.reduce((s, r) => s + r.entradas, 0)
    const dSaldo = prev ? last.saldo_tn - prev.saldo_tn : null
    const dAging = prev && last.aging_pond !== null && prev.aging_pond !== null ? last.aging_pond - prev.aging_pond : null
    const partial = last.hasta.slice(0, 10) < naturalEnd(dataGrain, last.periodo)
    return { last, prev, tnIn, tnOut, lotesIn, lotesOut, entradas, dSaldo, dAging, partial }
  }, [rows, dataGrain])

  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort])

  const doExport = () => {
    exportAptXlsx(`APT_tendencias_${dataGrain}`, {
      Tendencias: rows.map(r => ({
        Periodo: periodLabel(dataGrain, r.periodo, true), Desde: fmtDate(r.periodo), Hasta: fmtDate(r.hasta),
        'TN ingresadas': r.tn_in, 'TN despachadas': r.tn_out, 'Neto TN': r.neto, 'Filas ENTRADA': r.entradas, 'Salidas asignadas': r.salidas,
        'NumRel ingresados': r.lotes_ingresados, 'NumRel despachados': r.lotes_despachados, 'TN prom. por entrada': r.tn_prom_entrada,
        'TN prom. por salida': r.tn_prom_salida, 'Días prom. despacho': r.dias_prom_despacho, 'TN ingresadas acum.': r.tn_in_acum,
        'TN despachadas acum.': r.tn_out_acum, 'Saldo TN': r.saldo_tn, 'Aging ponderado (días)': r.aging_pond,
      })),
    })
  }

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-base font-black text-slate-900">Tendencias</h2>
        <p className="text-xs text-slate-500">¿La carga de APT está aumentando o disminuyendo? Ingresos, despachos, saldo y aging por periodo.</p>
      </div>
      <Segmented label="Grano de tiempo" value={grain} options={GRAINS} onChange={setGrain} />
    </div>
  )

  if (error && !data) return <div className="space-y-4">{header}<ErrorBlock message={error} onRetry={retry} /></div>
  if (!data) return <div className="space-y-4">{header}<LoadingBlock /></div>
  if (!rows.length || !summary) {
    return <div className="space-y-4">{header}<EmptyState title="Aún no hay movimientos: cargue ENTRADA y SALIDA">No hay periodos con los filtros actuales.</EmptyState></div>
  }

  const { last, prev, dSaldo, dAging, partial } = summary
  const lastName = periodLabel(dataGrain, last.periodo, true)
  const prevName = prev ? periodLabel(dataGrain, prev.periodo, true) : ''
  let verdict: ReactNode = 'Solo hay un periodo: no se puede comparar todavía.'
  let trendUp: boolean | null = null
  if (prev && dSaldo !== null) {
    const base = Math.abs(prev.saldo_tn)
    const pct = base > 0 ? (dSaldo / base) * 100 : null
    const stable = Math.abs(dSaldo) < Math.max(0.5, base * 0.01)
    trendUp = stable ? null : dSaldo > 0
    const agingTxt = dAging === null ? ''
      : Math.abs(dAging) < 0.05 ? `; el aging ponderado se mantiene en ${fmtDec1(last.aging_pond)} días`
      : `; el aging ponderado ${dAging > 0 ? 'subió' : 'bajó'} de ${fmtDec1(prev.aging_pond)} a ${fmtDec1(last.aging_pond)} días`
    verdict = (
      <>
        La carga de APT <b>{stable ? 'se mantiene estable' : dSaldo > 0 ? 'está aumentando' : 'está disminuyendo'}</b>: el saldo pasó de{' '}
        <b>{fmtTn(prev.saldo_tn)} TN</b> ({prevName}) a <b>{fmtTn(last.saldo_tn)} TN</b> ({lastName}
        {partial ? `, ${GRAIN_NOUN[dataGrain]} en curso hasta ${fmtDate(last.hasta)}` : ''})
        {pct !== null && !stable ? `, ${dSaldo > 0 ? '+' : '−'}${fmtPct(Math.abs(pct))}` : ''}{agingTxt}.
      </>
    )
  }
  const VerdictIcon = trendUp === null ? Minus : trendUp ? TrendingUp : TrendingDown

  return (
    <div className={`space-y-4 transition-opacity ${loading ? 'opacity-60' : ''}`}>
      {header}

      <div className={`flex items-start gap-3 rounded-xl border p-4 text-sm shadow-sm ${
        trendUp === null ? 'border-slate-200 bg-white text-slate-700' : trendUp ? 'border-red-200 bg-red-50 text-red-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>
        <VerdictIcon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
        <p className="leading-relaxed">{verdict}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="TN ingresadas" value={fmtTn(summary.tnIn)} unit="TN" tone="navy"
          hint={`${fmtInt(summary.entradas)} filas · ${fmtInt(summary.lotesIn)} NumRel nuevos en ${rows.length} periodos`} />
        <KpiCard label="TN despachadas" value={fmtTn(summary.tnOut)} unit="TN"
          hint={`${summary.tnIn > 0 ? fmtPct((summary.tnOut / summary.tnIn) * 100) : '—'} de lo ingresado · ${fmtInt(summary.lotesOut)} NumRel cerrados`} />
        <KpiCard label="Neto del periodo" value={`${summary.tnIn - summary.tnOut >= 0 ? '+' : '−'}${fmtTn(Math.abs(summary.tnIn - summary.tnOut))}`} unit="TN"
          tone={summary.tnIn - summary.tnOut > 0 ? 'warn' : 'ok'} hint="Ingresado − despachado en todo el rango" />
        <KpiCard label={`Saldo al cierre (${periodLabel(dataGrain, last.periodo)})`} value={fmtTn(last.saldo_tn)} unit="TN" tone="navy"
          hint={<>vs anterior: <Delta value={dSaldo} unit="TN" /></>} />
        <KpiCard label="Aging ponderado al cierre" value={fmtDec1(last.aging_pond)} unit="días"
          tone={last.aging_pond !== null && last.aging_pond > 30 ? 'crit' : last.aging_pond !== null && last.aging_pond > 15 ? 'warn' : 'ok'}
          hint={<>vs anterior: <Delta value={dAging} unit="días" digits="dias" /></>} />
        <KpiCard label={`Último ${GRAIN_NOUN[dataGrain]}`} value={`${last.neto >= 0 ? '+' : '−'}${fmtTn(Math.abs(last.neto))}`} unit="TN"
          tone={last.neto > 0 ? 'warn' : 'ok'}
          hint={`${fmtTn(last.tn_in)} ingresadas · ${fmtTn(last.tn_out)} despachadas${partial ? ' (en curso)' : ''}`} />
      </div>

      {useBrush && (
        <p className="text-xs text-slate-500">
          Serie diaria: mostrando {fmtDate(rows[range.start]?.periodo)} – {fmtDate(rows[range.end]?.periodo)}. Arrastre el selector bajo el primer gráfico para cambiar el rango; los demás gráficos lo siguen.
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="TN ingresadas vs despachadas" subtitle={`Por ${GRAIN_NOUN[dataGrain]} · línea = neto (ingresado − despachado)`}
          info="Despachadas = TN asignadas por FIFO a capas ingresadas a APT (no incluye salidas sin ingreso identificado).">
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart key={brushKey} data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
                <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={16} />
                <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} tickFormatter={v => fmtInt(v)} />
                <Tooltip cursor={{ fill: '#f1f5f9' }} content={<ChartTip fmt={tipFmt} labelFmt={(_, r) => periodTip(dataGrain, r)} />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="tn_in" name="TN ingresadas" fill={APT_COLORS.in} radius={[4, 4, 0, 0]} maxBarSize={28} />
                <Bar dataKey="tn_out" name="TN despachadas" fill={APT_COLORS.out} radius={[4, 4, 0, 0]} maxBarSize={28} />
                <Line dataKey="neto" name="Neto" stroke={APT_COLORS.amber} strokeWidth={2} dot={false} type="monotone" />
                {useBrush && (
                  <Brush dataKey="label" height={22} travellerWidth={8} stroke={APT_COLORS.navy} startIndex={range.start} endIndex={range.end}
                    onChange={r => {
                      if (typeof r?.startIndex === 'number' && typeof r?.endIndex === 'number') setBrush({ key: brushKey, start: r.startIndex, end: r.endIndex })
                    }} />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard title="Inventario en APT y aging ponderado" subtitle="Área = saldo TN al cierre de cada periodo · línea = aging ponderado (eje derecho)"
          info="Saldo acumulado desde el inicio de los datos cargados (parte en 0). Aging ponderado = Σ(TN × días) / Σ TN del saldo al cierre del periodo.">
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={visible} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="aptSaldoGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={APT_COLORS.navy} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={APT_COLORS.navy} stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={16} />
                <YAxis yAxisId="tn" tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} tickFormatter={v => fmtInt(v)} />
                <YAxis yAxisId="d" orientation="right" tick={AXIS_TICK} axisLine={false} tickLine={false} width={36} tickFormatter={v => `${fmtInt(v)} d`} />
                <Tooltip content={<ChartTip fmt={tipFmt} labelFmt={(_, r) => periodTip(dataGrain, r)} />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                <Area yAxisId="tn" dataKey="saldo_tn" name="Saldo TN" type="monotone" stroke={APT_COLORS.navy} strokeWidth={2} fill="url(#aptSaldoGrad)" />
                <Line yAxisId="d" dataKey="aging_pond" name="Aging ponderado" type="monotone" stroke={APT_COLORS.red} strokeWidth={2} dot={false} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard title="NumRel ingresados vs despachados" subtitle={`Por ${GRAIN_NOUN[dataGrain]}`}
          info="Ingresados = NumRel cuyo primer ingreso a APT cae en el periodo. Despachados = NumRel que quedaron despachados (dentro de la tolerancia) con su última salida en el periodo.">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={visible} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
                <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={16} />
                <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={40} allowDecimals={false} />
                <Tooltip cursor={{ fill: '#f1f5f9' }} content={<ChartTip fmt={tipFmt} labelFmt={(_, r) => periodTip(dataGrain, r)} />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="lotes_ingresados" name="NumRel ingresados" fill={APT_COLORS.in} radius={[4, 4, 0, 0]} maxBarSize={28} />
                <Bar dataKey="lotes_despachados" name="NumRel despachados" fill={APT_COLORS.out} radius={[4, 4, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard title="Tamaño promedio de movimientos y días de despacho"
          subtitle="TN promedio por fila de entrada y por salida · debajo, días promedio desde el ingreso hasta el despacho (ponderado por TN)">
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={visible} syncId="apt-tend-prom" margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" hide />
                <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} tickFormatter={v => fmtDec1(v)} />
                <Tooltip content={<ChartTip fmt={tipFmt} labelFmt={(_, r) => periodTip(dataGrain, r)} />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                <Line dataKey="tn_prom_entrada" name="TN prom. por entrada" stroke={APT_COLORS.in} strokeWidth={2} dot={false} type="monotone" connectNulls />
                <Line dataKey="tn_prom_salida" name="TN prom. por salida" stroke={APT_COLORS.out} strokeWidth={2} dot={false} type="monotone" connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 h-32">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={visible} syncId="apt-tend-prom" margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={16} />
                <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} tickFormatter={v => `${fmtInt(v)} d`} />
                <Tooltip cursor={{ fill: '#f1f5f9' }} content={<ChartTip fmt={tipFmt} labelFmt={(_, r) => periodTip(dataGrain, r)} />} />
                <Bar dataKey="dias_prom_despacho" name="Días prom. de despacho" fill={APT_COLORS.slate} radius={[4, 4, 0, 0]} maxBarSize={24} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>
      </div>

      <ChartCard title="Detalle por periodo" subtitle={`${rows.length} periodos · clic en el ícono para ver las capas ingresadas en ese periodo`}
        actions={<ExportButton onClick={doExport} />} bodyClassName="p-0">
        <div className="max-h-[520px] overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500 shadow-[0_1px_0_#e2e8f0]">
              <tr>
                <SortTh k="periodo" sort={sort} onSort={setSort} right={false}>Periodo</SortTh>
                <th className="whitespace-nowrap px-3 py-2 text-left font-bold">Desde – Hasta</th>
                <SortTh k="tn_in" sort={sort} onSort={setSort}>TN ingr.</SortTh>
                <SortTh k="tn_out" sort={sort} onSort={setSort}>TN desp.</SortTh>
                <SortTh k="neto" sort={sort} onSort={setSort}>Neto</SortTh>
                <SortTh k="entradas" sort={sort} onSort={setSort} title="Filas de ENTRADA">Entradas</SortTh>
                <SortTh k="salidas" sort={sort} onSort={setSort} title="Salidas asignadas a capas">Salidas</SortTh>
                <SortTh k="lotes_ingresados" sort={sort} onSort={setSort}>NumRel ingr.</SortTh>
                <SortTh k="lotes_despachados" sort={sort} onSort={setSort}>NumRel desp.</SortTh>
                <SortTh k="tn_prom_entrada" sort={sort} onSort={setSort}>TN/entrada</SortTh>
                <SortTh k="tn_prom_salida" sort={sort} onSort={setSort}>TN/salida</SortTh>
                <SortTh k="dias_prom_despacho" sort={sort} onSort={setSort}>Días desp.</SortTh>
                <SortTh k="tn_in_acum" sort={sort} onSort={setSort}>Ingr. acum.</SortTh>
                <SortTh k="tn_out_acum" sort={sort} onSort={setSort}>Desp. acum.</SortTh>
                <SortTh k="saldo_tn" sort={sort} onSort={setSort}>Saldo TN</SortTh>
                <SortTh k="aging_pond" sort={sort} onSort={setSort}>Aging pond.</SortTh>
                <th className="px-2 py-2"><span className="sr-only">Ver capas</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sorted.map(r => (
                <tr key={r.periodo} className="hover:bg-slate-50">
                  <td className="whitespace-nowrap px-3 py-1.5 font-semibold text-slate-800">{periodLabel(dataGrain, r.periodo, true)}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">{dataGrain === 'dia' ? fmtDate(r.periodo) : `${fmtDate(r.periodo)} – ${fmtDate(r.hasta)}`}</td>
                  <Num v={fmtTn(r.tn_in)} />
                  <Num v={fmtTn(r.tn_out)} />
                  <Num v={fmtTn(r.neto)} cls={r.neto > 0.005 ? 'text-red-600' : r.neto < -0.005 ? 'text-emerald-600' : ''} />
                  <Num v={fmtInt(r.entradas)} />
                  <Num v={fmtInt(r.salidas)} />
                  <Num v={fmtInt(r.lotes_ingresados)} />
                  <Num v={fmtInt(r.lotes_despachados)} />
                  <Num v={fmtTn(r.tn_prom_entrada)} />
                  <Num v={fmtTn(r.tn_prom_salida)} />
                  <Num v={fmtDec1(r.dias_prom_despacho)} />
                  <Num v={fmtTn(r.tn_in_acum)} />
                  <Num v={fmtTn(r.tn_out_acum)} />
                  <Num v={fmtTn(r.saldo_tn)} cls="font-bold text-[#002855]" />
                  <Num v={fmtDias(r.aging_pond)} />
                  <td className="px-2 py-1.5">
                    {r.entradas > 0 && (
                      <Link href={hrefWith('/apt/detalle', { ingreso_desde: r.periodo.slice(0, 10), ingreso_hasta: r.hasta.slice(0, 10) })}
                        aria-label={`Ver capas ingresadas en ${periodLabel(dataGrain, r.periodo, true)}`} className="text-slate-400 hover:text-[#002855]">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>
    </div>
  )
}

function Num({ v, cls = '' }: { v: string; cls?: string }) {
  return <td className={`whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700 ${cls}`}>{v}</td>
}

function periodTip(grain: AptGrain, r?: Record<string, unknown>) {
  if (!r) return ''
  const ini = String(r.periodo ?? ''), fin = String(r.hasta ?? '')
  if (grain === 'dia') return fmtDate(ini)
  return `${periodLabel(grain, ini, true)} (${fmtDate(ini)} – ${fmtDate(fin)})`
}
