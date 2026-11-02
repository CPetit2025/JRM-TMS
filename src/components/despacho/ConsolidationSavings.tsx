"use client"
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { PiggyBank } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { errorMessage, money } from '@/lib/caja'

// Ahorro por consolidación (consolidation_savings, docs/control-presupuestal/ahorro-consolidacion.md): indicador de
// eficiencia, no toca la partida. Lo usan la pestaña Ahorro, el detalle de la OT y Costos del viaje en Torre de Control.

export type SavingRow = {
  dispatch_id: string; dispatch_number: string; date: string; modalidad: string; request_id: string; request_number: string; request_type: string
  contract_id: string | null; contract_code: string | null; root_id: string | null; root_code: string | null; client: string | null
  district: string | null; weight_kg: number | null; vehicle_class: string | null; class_by_weight: boolean
  principal: boolean; added: boolean; state: 'PRINCIPAL' | 'VALORIZADO' | 'SIN_TARIFA' | 'SIN_KM'; standalone_pen: number | null
  direct_km: number | null; extra_km: number | null; extra_hours: number | null; km_estimated: boolean
  fuel_pen: number; hours_pen: number; hours_cost_missing: boolean; tolls_pen: number; freight_paid_pen: number | null
  marginal_pen: number | null; saving_pen: number | null
}
export type SavingsResult = { success: boolean; error?: string; services_total: number; leveraged: number; saving_total: number; hours_cost_missing: boolean | null; rows: SavingRow[] }

const supabase = createClient()
const STATE: Record<SavingRow['state'], { label: string; cls: string }> = {
  PRINCIPAL: { label: 'Principal de la ruta', cls: 'bg-slate-100 text-slate-600' }, VALORIZADO: { label: 'Aprovechado', cls: 'bg-emerald-100 text-emerald-800' },
  SIN_TARIFA: { label: 'Sin tarifa', cls: 'bg-amber-100 text-amber-800' }, SIN_KM: { label: 'Sin km directos', cls: 'bg-amber-100 text-amber-800' },
}
const TYPE: Record<string, string> = { DESPACHO: 'Entrega', RECOJO: 'Recojo', TRASLADO: 'Traslado' }
const pen = (v: number | null | undefined) => v == null ? '—' : money(Number(v))

/** Base del cálculo en una línea: tarifa, clase y costo marginal */
export const savingBasis = (r: SavingRow) => r.principal ? 'La ruta existe por este servicio: no genera ahorro'
  : `Tarifa ${r.district || '—'} · ${r.vehicle_class || 'sin clase'}${r.class_by_weight ? ` (por ${Number(r.weight_kg)} kg)` : ' (unidad de la ruta)'} · `
    + (r.modalidad === 'TERCERO' ? `flete pagado S/ ${pen(r.freight_paid_pen)}` : `${Number(r.extra_km ?? 0)} km y ${Number(r.extra_hours ?? 0)} h extra${r.added ? ' (agregado en ruta)' : ''}`)
    + (Number(r.tolls_pen) ? ` · peajes S/ ${pen(r.tolls_pen)}` : '') + (r.km_estimated ? ' · km estimados' : '') + (r.hours_cost_missing ? ' · horas sin costo cargado' : '')

export function exportSavingsCsv(rows: SavingRow[], name = 'ahorro-consolidacion') {
  const head = ['Fecha', 'Ruta', 'Modalidad', 'Solicitud', 'Tipo', 'OT', 'OT raíz', 'Cliente', 'Distrito', 'Clase', 'Estado', 'Valor independiente', 'Km extra', 'Horas extra',
    'Combustible', 'Horas', 'Peajes', 'Flete pagado', 'Costo marginal', 'Ahorro']
  const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const lines = rows.map(r => [r.date, r.dispatch_number, r.modalidad, r.request_number, TYPE[r.request_type] || r.request_type, r.contract_code || 'Operación general', r.root_code, r.client,
    r.district, r.vehicle_class, STATE[r.state].label, r.standalone_pen, r.extra_km, r.extra_hours, r.fuel_pen, r.hours_pen, r.tolls_pen, r.freight_paid_pen, r.marginal_pen, r.saving_pen].map(cell).join(','))
  const url = URL.createObjectURL(new Blob(['﻿' + [head.map(cell).join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a'); a.href = url; a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`; a.click()
  URL.revokeObjectURL(url)
}

export function SavingsTable({ rows, showOt = true }: { rows: SavingRow[]; showOt?: boolean }) {
  if (!rows.length) return <p className="p-6 text-center text-sm text-slate-500">No hay rutas con servicios compartidos en el período.</p>
  return <div className="overflow-x-auto"><table className="w-full min-w-[64rem] text-sm">
    <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr>
      <th className="px-3 py-2">Fecha · ruta</th><th className="px-3 py-2">Servicio</th>{showOt && <th className="px-3 py-2">OT · cliente</th>}<th className="px-3 py-2">Base del cálculo</th>
      <th className="px-3 py-2 text-right">Valor independiente</th><th className="px-3 py-2 text-right">Costo marginal</th><th className="px-3 py-2 text-right">Ahorro</th>
    </tr></thead>
    <tbody className="divide-y divide-slate-100">{rows.map(r => <tr key={`${r.dispatch_id}:${r.request_id}`} className={r.principal ? 'bg-slate-50/60 text-slate-500' : ''}>
      <td className="whitespace-nowrap px-3 py-2 text-xs">{r.date.split('-').reverse().join('/')}<Link href={`/torre-control?despacho=${r.dispatch_id}`} className="block font-semibold text-[#002855] underline">{r.dispatch_number}</Link>
        <span className="text-slate-500">{r.modalidad === 'TERCERO' ? 'Tercero' : 'Flota propia'}</span></td>
      <td className="px-3 py-2 text-xs"><b>{r.request_number}</b> · {TYPE[r.request_type] || r.request_type}
        <span className={`mt-0.5 block w-fit rounded px-1.5 text-[10px] font-semibold ${STATE[r.state].cls}`}>{STATE[r.state].label}</span></td>
      {showOt && <td className="px-3 py-2 text-xs">{r.contract_code || 'Operación general'}{r.root_code && r.root_code !== r.contract_code && <span className="block text-slate-500">OT {r.root_code}</span>}
        <span className="block text-slate-500">{r.client || '—'}</span></td>}
      <td className="px-3 py-2 text-xs text-slate-600">{savingBasis(r)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{pen(r.standalone_pen)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{pen(r.marginal_pen)}</td>
      <td className={`px-3 py-2 text-right font-semibold tabular-nums ${Number(r.saving_pen) < 0 ? 'text-red-700' : 'text-emerald-700'}`}>{pen(r.saving_pen)}</td>
    </tr>)}</tbody>
  </table></div>
}

/** Costos del viaje (Torre de Control): el ahorro de este servicio dentro de su ruta */
export function TripSaving({ dispatchId, requestId }: { dispatchId: string; requestId: string }) {
  const [row, setRow] = useState<SavingRow | null | 'none'>(null)
  useEffect(() => {
    let alive = true
    void supabase.rpc('consolidation_savings', { p_dispatch: dispatchId }).then(({ data }) => {
      if (!alive) return
      const found = (data as SavingsResult | null)?.success ? (data as SavingsResult).rows?.find(r => r.request_id === requestId) : undefined
      setRow(found || 'none')
    })
    return () => { alive = false }
  }, [dispatchId, requestId])
  if (!row || row === 'none') return null
  return <section aria-label="Ahorro por consolidación" className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4 text-sm">
    <p className="flex items-center gap-2 font-bold text-emerald-900"><PiggyBank className="h-4 w-4" aria-hidden />Ahorro por consolidación</p>
    {row.principal ? <p className="mt-1 text-slate-600">{savingBasis(row)}.</p> : <>
      <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-800">{row.saving_pen == null ? '—' : `S/ ${pen(row.saving_pen)}`}</p>
      <p className="text-xs text-slate-600">Valor independiente S/ {pen(row.standalone_pen)} − costo marginal S/ {pen(row.marginal_pen)}</p>
      <p className="mt-1 text-xs text-slate-500">{savingBasis(row)}</p></>}
    <p className="mt-1 text-[11px] text-slate-500">Indicador de eficiencia: no consume la partida de la OT.</p>
  </section>
}

/** Costos por hora de unidad (por clase) y tripulación (por rol): los edita el Administrador o Gerencia */
export function HourCostsEditor({ onSaved }: { onSaved?: () => void }) {
  const [cfg, setCfg] = useState<{ can_edit: boolean; classes: string[]; roles: string[]; costs: Record<string, number> } | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('consolidation_hour_costs_get')
    if (error || !data?.success) { toast.error(error ? errorMessage(error) : data?.error); return }
    setCfg(data); setDraft(Object.fromEntries(Object.entries(data.costs as Record<string, number>).map(([k, v]) => [k, String(v)])))
  }, [])
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])
  const keys = useMemo(() => cfg ? [...cfg.classes.map(c => [`UNIDAD:${c}`, `Unidad ${c}`]), ...cfg.roles.map(r => [`ROL:${r}`, r === 'CONDUCTOR' ? 'Conductor' : r.charAt(0) + r.slice(1).toLowerCase().replace('_', ' ')])] : [], [cfg])
  const save = async (key: string) => {
    const raw = (draft[key] || '').trim()
    const { data, error } = await supabase.rpc('consolidation_hour_cost_set', { p_key: key, p_cost: raw === '' ? null : Number(raw) })
    if (error || !data?.success) { toast.error(error ? errorMessage(error) : data?.error); return }
    toast.success('Costo por hora guardado'); void load(); onSaved?.()
  }
  if (!cfg) return null
  return <details className="rounded-xl border border-slate-200 bg-white p-3">
    <summary className="cursor-pointer text-sm font-semibold text-[#002855]">Costos por hora (unidad y tripulación){keys.some(([k]) => cfg.costs[k] == null) ? ' · faltan valores' : ''}</summary>
    <p className="mt-2 text-xs text-slate-500">Se usan para valorizar las horas extra de la flota propia. Mientras falte alguno, esas horas no suman y el reporte lo indica.{!cfg.can_edit && ' Los define el Administrador o Gerencia.'}</p>
    <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{keys.map(([key, label]) => <label key={key} className="text-xs font-semibold text-slate-600">{label} (S/ por hora)
      <span className="mt-1 flex gap-1"><input type="number" min="0" step="0.01" value={draft[key] ?? ''} disabled={!cfg.can_edit} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))}
        className="h-9 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm disabled:bg-slate-50" />
        {cfg.can_edit && String(cfg.costs[key] ?? '') !== (draft[key] ?? '') && <button type="button" onClick={() => void save(key)} className="h-9 rounded-lg bg-[#002855] px-3 text-xs font-semibold text-white">Guardar</button>}</span></label>)}</div>
  </details>
}
