'use client'
import { useEffect, useMemo, useState } from 'react'
import { Loader2, Save, Truck } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { errorMessage, money } from '@/lib/caja'
import { DEFAULT_SETTINGS, isDeviation, type EconSettings } from '@/lib/economic-closure'

// Flete con etapas (Etapa 3): referencial de las solicitudes, acordado al programar, vigente (lo que mueve la partida) y
// final después de la ejecución. Ninguna etapa sobrescribe a otra; cada cambio queda en el historial de costos.
// El flete final se registra solo en el Cierre económico; fuera de él (Torre de Control) el componente es de consulta.

type ByRequest = { request_id: string; request_number: string; contract_code: string | null; referential_pen: number; agreed_pen: number; current_pen: number; final_pen: number | null; status: string }
type Summary = {
  success: true; status: string; referential_pen: number; agreed_pen: number; agreed_recorded: boolean; current_pen: number
  base_pen: number | null; extras_pen: number | null; final_pen: number | null; executed_as_planned: boolean | null
  final_reason: string | null; final_at: string | null; final_by: string | null; can_register_final: boolean; by_request: ByRequest[]
}

const delta = (a: number, b: number) => {
  const d = Math.round((b - a) * 100) / 100
  if (!a || d === 0) return null
  return <span className={d > 0 ? 'text-red-700' : 'text-emerald-700'}> ({d > 0 ? '+' : ''}{money(d)}; {d > 0 ? '+' : ''}{Math.round(d / a * 100)}%)</span>
}

export function DispatchFreightStages({ dispatchId, onSaved, settings = DEFAULT_SETTINGS, readOnly = false, onEconomic }: {
  dispatchId: string; onSaved?: () => void; settings?: EconSettings; readOnly?: boolean; onEconomic?: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [data, setData] = useState<Summary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [form, setForm] = useState({ asPlanned: true, base: '', extras: '', reason: '' })
  const [alloc, setAlloc] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    void supabase.rpc('dispatch_freight_summary', { p_dispatch_id: dispatchId }).then(({ data: out, error: err }) => {
      if (!alive) return
      if (err || !out?.success) { setError(err ? errorMessage(err) : out?.error || 'No se pudo leer el flete'); return }
      setData(out as Summary); setError(null)
    })
    return () => { alive = false }
  }, [supabase, dispatchId, reload])

  if (error) return <p className="text-xs text-slate-500">{error}</p>
  if (!data) return <Loader2 className="w-4 h-4 animate-spin text-slate-400" />

  const canRegister = data.can_register_final && !readOnly
  const base = form.asPlanned ? data.agreed_pen : Number(form.base || 0)
  const final = Math.round((base + Number(form.extras || 0)) * 100) / 100
  // Motivo solo cuando supera el umbral configurable o hay adicionales (igual que la base)
  const differs = isDeviation(data.agreed_pen, final, settings) || Number(form.extras || 0) > 0
  const mixed = data.by_request.filter(r => r.status !== 'LIBERADO')
  const allocTotal = mixed.reduce((s, r) => s + Number(alloc[r.request_id] || 0), 0)
  const useAlloc = mixed.length > 1 && Object.values(alloc).some(v => v.trim() !== '')

  const save = async () => {
    if (!form.asPlanned && !(form.base.trim() && Number(form.base) >= 0)) { toast.error('Indique el flete ejecutado'); return }
    if (differs && form.reason.trim().length < 5) { toast.error('Justifique la diferencia: supera el umbral o tiene adicionales (mínimo 5 caracteres)'); return }
    if (useAlloc && Math.abs(allocTotal - final) >= 0.01) { toast.error(`El reparto por OT debe sumar ${money(final)}`); return }
    setSaving(true)
    try {
      const { data: out, error: err } = await supabase.rpc('register_dispatch_freight_final', { p_dispatch_id: dispatchId, p: {
        executed_as_planned: form.asPlanned, base_pen: form.asPlanned ? null : Number(form.base), extras_pen: Number(form.extras || 0),
        reason: form.reason.trim() || null,
        allocation: useAlloc ? mixed.map(r => ({ request_id: r.request_id, final_pen: Number(alloc[r.request_id] || 0) })) : null,
      } })
      if (err) throw err
      if (!out?.success) throw new Error(out?.error)
      toast.success('Flete final registrado')
      setForm({ asPlanned: true, base: '', extras: '', reason: '' }); setAlloc({})
      setReload(n => n + 1)
      onSaved?.()
    } catch (e) { toast.error(errorMessage(e)) } finally { setSaving(false) }
  }

  const input = 'w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-[#002855]'
  return (
    <div className="space-y-3">
      <h3 className="font-bold text-slate-800 flex items-center gap-2"><Truck className="w-4 h-4" />Flete por etapas</h3>
      <dl className="grid gap-2 text-sm sm:grid-cols-4">
        <div className="rounded-lg border bg-white p-2"><dt className="text-[11px] text-slate-500">Referencial (solicitudes)</dt><dd className="font-bold tabular-nums">{money(data.referential_pen)}</dd></div>
        <div className="rounded-lg border bg-white p-2"><dt className="text-[11px] text-slate-500">Acordado (programación){!data.agreed_recorded && ' · histórico'}</dt>
          <dd className="font-bold tabular-nums">{money(data.agreed_pen)}<span className="text-xs font-normal">{delta(data.referential_pen, data.agreed_pen)}</span></dd></div>
        <div className="rounded-lg border bg-white p-2"><dt className="text-[11px] text-slate-500">Vigente (partida)</dt>
          <dd className="font-bold tabular-nums">{money(data.current_pen)}<span className="text-xs font-normal">{delta(data.agreed_pen, data.current_pen)}</span></dd></div>
        <div className="rounded-lg border bg-white p-2"><dt className="text-[11px] text-slate-500">Final (ejecutado)</dt>
          <dd className="font-bold tabular-nums">{data.final_pen == null ? <span className="font-semibold text-amber-700">Pendiente</span> : <>{money(data.final_pen)}<span className="text-xs font-normal">{delta(data.agreed_pen, data.final_pen)}</span></>}</dd></div>
      </dl>
      {data.final_pen != null && (
        <p className="text-xs text-slate-600">
          {data.executed_as_planned ? 'Ejecutado conforme a lo programado' : `Ejecutado distinto a lo programado (${money(data.base_pen || 0)})`}
          {Number(data.extras_pen) > 0 && ` · adicionales ${money(Number(data.extras_pen))}`}
          {data.final_reason && ` · Motivo: ${data.final_reason}`}
          {data.final_at && ` · ${new Date(data.final_at).toLocaleString('es-PE')}${data.final_by ? ` · ${data.final_by}` : ''}`}
        </p>
      )}
      {data.by_request.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-xs">
            <thead><tr className="border-b text-left text-slate-500"><th className="py-1 pr-2">Servicio · OT</th><th className="pr-2 text-right">Referencial</th><th className="pr-2 text-right">Acordado</th><th className="pr-2 text-right">Vigente</th><th className="pr-2 text-right">Final</th>
              {canRegister && mixed.length > 1 && <th className="text-right">Reparto final</th>}</tr></thead>
            <tbody>
              {data.by_request.map(r => (
                <tr key={r.request_id} className="border-b last:border-0">
                  <td className="py-1 pr-2">{r.request_number} · {r.contract_code || 'Sin OT'}{r.status === 'LIBERADO' && <span className="text-slate-400"> (retirado)</span>}</td>
                  <td className="pr-2 text-right tabular-nums">{money(r.referential_pen)}</td>
                  <td className="pr-2 text-right tabular-nums">{money(r.agreed_pen)}</td>
                  <td className="pr-2 text-right tabular-nums">{money(r.current_pen)}</td>
                  <td className="pr-2 text-right tabular-nums">{r.final_pen == null ? '—' : money(r.final_pen)}</td>
                  {canRegister && mixed.length > 1 && <td className="text-right">{r.status !== 'LIBERADO' &&
                    <input inputMode="decimal" aria-label={`Flete final de ${r.request_number}`} value={alloc[r.request_id] ?? ''} placeholder="Proporcional"
                      onChange={e => setAlloc(a => ({ ...a, [r.request_id]: e.target.value }))} className="w-24 rounded border border-slate-300 px-1 py-0.5 text-right" />}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {readOnly && data.can_register_final && <p className="text-xs text-slate-600">El flete final se registra en el Cierre económico.{onEconomic && <> <button type="button" onClick={onEconomic} className="font-semibold text-[#002855] underline">Ir al cierre económico</button></>}</p>}
      {canRegister && (
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <p className="text-xs font-bold text-slate-700">{data.final_pen == null ? 'Registrar flete final' : 'Corregir flete final'}</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <label className="flex items-center gap-2 text-sm sm:col-span-3"><input type="checkbox" checked={form.asPlanned} onChange={e => setForm({ ...form, asPlanned: e.target.checked })} />
              Se ejecutó conforme a lo programado ({money(data.agreed_pen)})</label>
            {!form.asPlanned && <label><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Flete ejecutado S/</span>
              <input inputMode="decimal" value={form.base} onChange={e => setForm({ ...form, base: e.target.value })} className={input} /></label>}
            <label><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Adicionales S/</span>
              <input inputMode="decimal" value={form.extras} onChange={e => setForm({ ...form, extras: e.target.value })} placeholder="0.00" className={input} /></label>
            <label className={form.asPlanned ? 'sm:col-span-2' : ''}><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Motivo {differs && '*'}</span>
              <input value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder={differs ? 'Obligatorio: supera el umbral o hay adicionales' : 'Opcional (dentro del umbral)'} className={input} /></label>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm">Final: <b className="tabular-nums">{money(final)}</b><span className="text-xs">{delta(data.agreed_pen, final)}</span></p>
            <button type="button" onClick={() => void save()} disabled={saving} className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}Guardar flete final</button>
          </div>
          <p className="mt-1 text-[11px] text-slate-500">El flete final no cambia la partida todavía: se impacta en el cierre económico.</p>
        </div>
      )}
    </div>
  )
}
