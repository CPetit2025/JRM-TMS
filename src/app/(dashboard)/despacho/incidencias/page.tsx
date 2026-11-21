'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { createClient } from '@/lib/supabase/client'
import { INCIDENT_CATEGORIES, INCIDENT_CAUSES, INCIDENT_STATUS, limaTime, type RouteIncident } from '@/lib/route-incidents'

type Draft = { status: string; action: string; responsible: string; cause: string }
const field = 'mt-1 block min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm'

/** Incidencias en ruta: el Supervisor de Transporte registra acción, responsable y estado; la causa la confirma alguien distinto de quien reportó. */
export default function IncidenciasPage() {
  const [rows, setRows] = useState<RouteIncident[]>([]), [status, setStatus] = useState<'ABIERTAS' | 'CERRADA'>('ABIERTAS')
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [draft, setDraft] = useState<Record<string, Draft>>({}), [busy, setBusy] = useState<string | null>(null)
  const pending = useRef(false)
  const load = useCallback(async () => {
    const { data, error: e } = await createClient().rpc('route_incidents_list', { p_status: status === 'CERRADA' ? 'CERRADA' : null })
    if (e) setError(e.message); else { setError(''); setRows(((data || []) as RouteIncident[]).filter(r => status === 'CERRADA' || r.status !== 'CERRADA')) }
    setLoading(false)
  }, [status])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  const save = async (r: RouteIncident, d: Draft) => {
    if (pending.current) return
    pending.current = true; setBusy(r.id); setError('')
    const { error: e } = await createClient().rpc('route_incident_update', { p_id: r.id, p_status: d.status, p_action: d.action, p_responsible: d.responsible, p_confirmed_cause: d.cause || null })
    pending.current = false; setBusy(null)
    if (e) { setError(e.message); return }
    setDraft(x => { const y = { ...x }; delete y[r.id]; return y }); void load()
  }

  return <div className="space-y-4">
    <PageHeader title="Incidencias en ruta" showTitle description="Reportadas desde la app del conductor o la oficina. Registre la acción, el responsable y la causa confirmada; quien reportó no confirma la causa."
      actions={<button type="button" onClick={() => void load()} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold"><RefreshCw className="h-4 w-4" aria-hidden />Actualizar</button>} />
    <div className="flex gap-2" role="group" aria-label="Estado">
      {(['ABIERTAS', 'CERRADA'] as const).map(s => <button key={s} type="button" aria-pressed={status === s} onClick={() => { if (s !== status) { setLoading(true); setStatus(s) } }}
        className={`min-h-11 rounded-full px-4 text-sm font-semibold ${status === s ? 'bg-[#002855] text-white' : 'bg-white ring-1 ring-slate-200'}`}>{s === 'ABIERTAS' ? 'Abiertas y en atención' : 'Cerradas'}</button>)}
    </div>
    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}
    {loading ? <Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-400" /> : rows.length === 0
      ? <p className="rounded-xl border border-slate-200 bg-white p-6 text-center text-slate-500">Sin registros.</p>
      : <ul className="space-y-3">{rows.map(r => {
        const d = draft[r.id]
        return <li key={r.id} className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p><b className="text-[#002855]">{INCIDENT_CATEGORIES[r.category] || r.category}</b> · viaje {r.dispatch_number || '—'} · {r.vehicle_plate || '—'} · {r.driver_name || '—'}{r.request_number ? ` · solicitud ${r.request_number}` : ''}</p>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-900">{INCIDENT_STATUS[r.status] || r.status}</span>
          </div>
          <p className="mt-1">{r.description}</p>
          <p className="mt-1 text-slate-600">Ocurrió {limaTime(r.occurred_at)} · registrada {limaTime(r.recorded_at)} · reportó {r.reporto || '—'} · causa reportada: {r.reported_cause ? INCIDENT_CAUSES[r.reported_cause] : 'no indicada'}</p>
          {(r.action_taken || r.confirmed_cause) && <p className="mt-1 text-slate-600">Acción: {r.action_taken || '—'} · responsable {r.responsible || '—'} · causa confirmada: {r.confirmed_cause ? `${INCIDENT_CAUSES[r.confirmed_cause]} (${r.confirmo || '—'})` : 'pendiente'}</p>}
          {r.status !== 'CERRADA' && r.puede_gestionar && (!d
            ? <button type="button" onClick={() => setDraft({ ...draft, [r.id]: { status: r.status === 'ABIERTA' ? 'EN_ATENCION' : r.status, action: r.action_taken || '', responsible: r.responsible || '', cause: r.confirmed_cause || '' } })}
                className="mt-3 min-h-11 rounded-lg border border-slate-300 px-3 font-semibold">Gestionar</button>
            : <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <label className="text-xs font-semibold">Estado<select value={d.status} onChange={e => setDraft({ ...draft, [r.id]: { ...d, status: e.target.value } })} className={field}>
                  {Object.entries(INCIDENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                <label className="text-xs font-semibold">Responsable<input value={d.responsible} maxLength={120} onChange={e => setDraft({ ...draft, [r.id]: { ...d, responsible: e.target.value } })} placeholder="Persona o área" className={field} /></label>
                <label className="text-xs font-semibold sm:col-span-2">Acción tomada<input value={d.action} maxLength={1000} onChange={e => setDraft({ ...draft, [r.id]: { ...d, action: e.target.value } })} className={field} /></label>
                <label className="text-xs font-semibold">Causa confirmada{r.es_mio ? ' (la confirma otra persona)' : ''}<select disabled={r.es_mio} value={d.cause} onChange={e => setDraft({ ...draft, [r.id]: { ...d, cause: e.target.value } })} className={field}>
                  <option value="">Sin confirmar</option>{Object.entries(INCIDENT_CAUSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                <div className="flex items-end gap-2">
                  <button type="button" onClick={() => setDraft(x => { const y = { ...x }; delete y[r.id]; return y })} className="min-h-11 rounded-lg border px-3 font-semibold">Cancelar</button>
                  <button type="button" disabled={busy === r.id} onClick={() => void save(r, d)} className="min-h-11 flex-1 rounded-lg bg-[#002855] px-3 font-semibold text-white disabled:opacity-50">{busy === r.id ? 'Guardando…' : 'Guardar'}</button>
                </div>
              </div>)}
        </li>
      })}</ul>}
  </div>
}
