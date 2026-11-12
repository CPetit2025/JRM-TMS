'use client'
import { useState } from 'react'

// Filtro de período compartido (Hoy por defecto, Semana = últimos 7 días, Mes en curso, Personalizado), en hora de Lima.
export type Period = 'HOY' | 'SEMANA' | 'MES' | 'RANGO'
const PERIODS: [Period, string][] = [['HOY', 'Hoy'], ['SEMANA', 'Semana'], ['MES', 'Mes'], ['RANGO', 'Personalizado']]
/** Fecha de Lima (YYYY-MM-DD) desplazada `days` días. */
export function limaDay(days = 0) { return new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Lima' }) }
export function periodRange(period: Period, from: string, to: string): [string, string] {
  const today = limaDay(0)
  if (period === 'HOY') return [today, today]
  if (period === 'SEMANA') return [limaDay(-6), today]
  if (period === 'MES') return [today.slice(0, 8) + '01', today]
  return [from || '0000-01-01', to || '9999-12-31']
}
/** Estado del filtro: `range` es [desde, hasta] (YYYY-MM-DD) para comparar con fechas de Lima. */
export function usePeriod() {
  const [period, setPeriod] = useState<Period>('HOY')
  const [from, setFrom] = useState(() => limaDay(0))
  const [to, setTo] = useState(() => limaDay(0))
  return { period, setPeriod, from, setFrom, to, setTo, range: periodRange(period, from, to) }
}
export function PeriodFilter({ state, note }: { state: ReturnType<typeof usePeriod>; note?: string }) {
  const { period, setPeriod, from, setFrom, to, setTo } = state
  return <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="Período">
    {PERIODS.map(([value, label]) => <button key={value} type="button" aria-pressed={period === value} onClick={() => setPeriod(value)}
      className={`rounded-lg border px-3 py-1.5 font-semibold ${period === value ? 'border-[#002855] bg-[#002855] text-white' : 'border-slate-300 text-[#002855] hover:bg-slate-50'}`}>{label}</button>)}
    {period === 'RANGO' && <>
      <label className="flex items-center gap-1 text-xs text-slate-600">Desde<input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1 text-sm" /></label>
      <label className="flex items-center gap-1 text-xs text-slate-600">Hasta<input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1 text-sm" /></label>
    </>}
    {note && <span className="text-xs text-slate-500">{note}</span>}
  </div>
}
