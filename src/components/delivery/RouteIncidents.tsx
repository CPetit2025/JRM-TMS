'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { readActionQueue, saveOfflineAction, syncOfflineActions } from '@/lib/route-point-sync'
import { INCIDENT_CATEGORIES, INCIDENT_CAUSES, INCIDENT_STATUS, limaTime, type RouteIncident } from '@/lib/route-incidents'

type Stop = { id: string; label: string }
const field = 'mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-sm'

/** Incidencias del viaje desde la app: catálogo, parada opcional y causa que cree el conductor (la confirma la oficina). */
export function RouteIncidents({ dispatchId, stops }: { dispatchId: string; stops: Stop[] }) {
  const [rows, setRows] = useState<RouteIncident[]>([]), [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [draft, setDraft] = useState({ category: '', request: '', description: '', cause: '' })
  const load = useCallback(async () => {
    const { data } = await createClient().rpc('route_incidents_list', { p_dispatch: dispatchId })
    setRows((data || []) as RouteIncident[])
  }, [dispatchId])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])
  const queued = readActionQueue().filter(a => a.type === 'route_incident_report' && a.payload.dispatch_id === dispatchId && !rows.some(r => r.id === a.id))

  const submit = async () => {
    setBusy(true); setError('')
    const position = await new Promise<GeolocationPosition | null>(resolve => 'geolocation' in navigator
      ? navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }) : resolve(null))
    const id = crypto.randomUUID()
    saveOfflineAction('route_incident_report', { dispatch_id: dispatchId, request_id: draft.request || null, category: draft.category, description: draft.description.trim(),
      reported_cause: draft.cause || null, occurred_at: new Date().toISOString(), latitude: position?.coords.latitude ?? null, longitude: position?.coords.longitude ?? null }, id)
    if (navigator.onLine) await syncOfflineActions().catch(() => {})
    const failed = readActionQueue().find(a => a.id === id && a.status === 'error')
    if (failed?.last_error) setError(failed.last_error)
    else { setOpen(false); setDraft({ category: '', request: '', description: '', cause: '' }) }
    await load(); setBusy(false)
  }

  return <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" aria-label="Incidencias del viaje">
    <div className="flex items-center justify-between gap-2">
      <p className="flex items-center gap-2 font-semibold text-[#002855]"><AlertTriangle className="h-4 w-4 text-rose-600" aria-hidden />Incidencias del viaje</p>
      {!open && <button type="button" onClick={() => setOpen(true)} className="min-h-11 rounded-lg border border-rose-300 px-3 text-sm font-semibold text-rose-800">Reportar incidencia</button>}
    </div>
    {open && <div className="mt-3 space-y-2 text-sm">
      <label className="block font-semibold">Tipo<select value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value })} className={field}>
        <option value="">Elija…</option>{Object.entries(INCIDENT_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      {stops.length > 0 && <label className="block font-semibold">Parada<select value={draft.request} onChange={e => setDraft({ ...draft, request: e.target.value })} className={field}>
        <option value="">Del viaje en general</option>{stops.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>}
      <label className="block font-semibold">Qué pasó<textarea value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} maxLength={1000} rows={3} className="mt-1 w-full rounded-lg border border-slate-300 p-3" /></label>
      <label className="block font-semibold">¿A qué se debe, según usted?<select value={draft.cause} onChange={e => setDraft({ ...draft, cause: e.target.value })} className={field}>
        <option value="">No lo sé</option>{Object.entries(INCIDENT_CAUSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <p className="text-xs text-slate-500">La oficina registra la acción y confirma la causa. Si no hay señal, se guarda en el teléfono y se envía después.</p>
      {error && <p role="alert" className="text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={() => setOpen(false)} className="min-h-11 flex-1 rounded-lg border px-3 font-semibold">Cancelar</button>
        <button type="button" disabled={busy || !draft.category || draft.description.trim().length < 5} onClick={() => void submit()} className="min-h-11 flex-1 rounded-lg bg-rose-700 px-3 font-semibold text-white disabled:opacity-50">{busy ? 'Guardando…' : 'Enviar'}</button>
      </div>
    </div>}
    {(rows.length > 0 || queued.length > 0) && <ul className="mt-3 space-y-2 text-sm">
      {queued.map(a => <li key={a.id} className="rounded-lg bg-amber-50 p-2 text-amber-900">{INCIDENT_CATEGORIES[String(a.payload.category)] || 'Incidencia'} · envío pendiente{a.last_error ? `: ${a.last_error}` : ''}</li>)}
      {rows.map(r => <li key={r.id} className="rounded-lg border border-slate-200 p-2">
        <p><b>{INCIDENT_CATEGORIES[r.category] || r.category}</b> · {limaTime(r.occurred_at)} · <span className="font-semibold">{INCIDENT_STATUS[r.status] || r.status}</span></p>
        <p className="text-slate-600">{r.description}</p>
        {r.action_taken && <p className="text-xs text-slate-600">Acción: {r.action_taken}{r.responsible ? ` · ${r.responsible}` : ''}</p>}
      </li>)}
    </ul>}
  </section>
}
