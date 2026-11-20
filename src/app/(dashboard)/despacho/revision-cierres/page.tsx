'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { createClient } from '@/lib/supabase/client'

type Review = { id: number; status: string; resolution: string | null; note: string | null; reason: string; created_at: string; resolved_at: string | null; resolvio: string | null
  request_id: string; request_number: string | null; request_type: string | null; request_status: string; delivery_address: string | null; committed_date: string | null; required_date: string | null
  estimated_weight: number | null; dispatch_id: string; dispatch_number: string | null; vehicle_plate: string | null; driver_name: string | null; modalidad: string | null; cerrado: string | null
  conformidad: string | null; llegada: string | null; puede_resolver: boolean }
type Draft = { res: 'ENTREGADA' | 'REPROGRAMADA' | 'ANULADA'; note: string; at: string; causa: string }

const CAUSAS: Record<string, string> = { CLIENTE: 'Cliente', ALMACEN_SIN_STOCK: 'Almacén sin stock', PRODUCCION: 'Producción', SIN_UNIDAD: 'Sin unidad', SIN_CONDUCTOR: 'Sin conductor', VIA_CLIMA: 'Vía o clima', DOCUMENTOS: 'Documentos', OTRO: 'Otro' }
const fmt = (d: string | null) => d ? new Date(d).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' }) : '—'
const field = 'min-h-11 rounded-lg border border-slate-300 px-3 py-2 text-sm'

/** Solicitudes de viajes ya cerrados sin entrega registrada: el Supervisor de Transporte decide cómo quedan. */
export default function RevisionCierresPage() {
  const [rows, setRows] = useState<Review[]>([]), [status, setStatus] = useState<'PENDIENTE' | 'RESUELTA'>('PENDIENTE')
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [draft, setDraft] = useState<Record<number, Draft>>({}), [busy, setBusy] = useState<number | null>(null)
  const pending = useRef(false)
  const load = useCallback(async () => {
    const { data, error: e } = await createClient().rpc('transport_request_reviews_list', { p_status: status })
    if (e) setError(e.message); else { setError(''); setRows((data || []) as Review[]) }
    setLoading(false)
  }, [status])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  const resolve = async (r: Review, d: Draft) => {
    if (pending.current) return
    pending.current = true; setBusy(r.id); setError('')
    const { error: e } = await createClient().rpc('transport_request_review_resolve', { p_id: r.id, p_resolution: d.res, p_note: d.note.trim(),
      p_required_at: d.res === 'REPROGRAMADA' && d.at ? new Date(d.at).toISOString() : null, p_causa: d.res === 'REPROGRAMADA' ? d.causa : null })
    pending.current = false; setBusy(null)
    if (e) { setError(e.message); return }
    setDraft(x => { const y = { ...x }; delete y[r.id]; return y }); void load()
  }

  return <div className="space-y-4">
    <PageHeader title="Revisión de cierres" showTitle description="Solicitudes de viajes cerrados sin entrega registrada. Cada una se resuelve: entregada (con la guía validada), reprogramada o anulada."
      actions={<button type="button" onClick={() => void load()} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold"><RefreshCw className="h-4 w-4" aria-hidden />Actualizar</button>} />
    <div className="flex gap-2" role="group" aria-label="Estado">
      {(['PENDIENTE', 'RESUELTA'] as const).map(s => <button key={s} type="button" aria-pressed={status === s} onClick={() => { setLoading(true); setStatus(s) }}
        className={`min-h-11 rounded-full px-4 text-sm font-semibold ${status === s ? 'bg-[#002855] text-white' : 'bg-white ring-1 ring-slate-200'}`}>{s === 'PENDIENTE' ? 'Pendientes' : 'Resueltas'}</button>)}
    </div>
    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}
    {loading ? <Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-400" /> : rows.length === 0
      ? <p className="rounded-xl border border-slate-200 bg-white p-6 text-center text-slate-500">{status === 'PENDIENTE' ? 'No hay solicitudes por revisar.' : 'Sin revisiones resueltas.'}</p>
      : <ul className="space-y-3">{rows.map(r => {
        const d = draft[r.id]
        return <li key={r.id} className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p><b className="text-[#002855]">{r.request_number || 'Solicitud'}</b> · {r.request_type} · <span className="text-slate-600">{r.delivery_address || 'sin dirección'}</span></p>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-900">{r.request_status}</span>
          </div>
          <p className="mt-1 text-slate-600">Viaje {r.dispatch_number || '—'} · {r.vehicle_plate || '—'} · {r.driver_name || '—'} · cerrado {fmt(r.cerrado)}</p>
          <p className="text-slate-600">Comprometido {r.committed_date || '—'} · requerido {r.required_date || '—'} · conformidad {r.conformidad ? r.conformidad.toLowerCase() : 'sin registrar'}{r.llegada ? ` · llegada ${fmt(r.llegada)}` : ''}</p>
          {r.status === 'RESUELTA' && <p className="mt-2 rounded bg-slate-50 p-2">Resuelta como <b>{r.resolution?.toLowerCase()}</b> por {r.resolvio || '—'} · {fmt(r.resolved_at)} — {r.note}</p>}
          {r.status === 'PENDIENTE' && r.puede_resolver && (!d
            ? <div className="mt-3 flex flex-wrap gap-2">
                {r.conformidad === 'VALIDADA' && <button type="button" onClick={() => setDraft({ ...draft, [r.id]: { res: 'ENTREGADA', note: '', at: '', causa: 'CLIENTE' } })} className="min-h-11 rounded-lg bg-emerald-700 px-3 font-semibold text-white">Entregada</button>}
                {r.conformidad !== 'VALIDADA' && <Link href="/despacho/documentos" className="inline-flex min-h-11 items-center rounded-lg border border-emerald-300 px-3 font-semibold text-emerald-900">Validar guía en Documentos</Link>}
                <button type="button" onClick={() => setDraft({ ...draft, [r.id]: { res: 'REPROGRAMADA', note: '', at: '', causa: 'CLIENTE' } })} className="min-h-11 rounded-lg border border-slate-300 px-3 font-semibold">Reprogramar</button>
                <button type="button" onClick={() => setDraft({ ...draft, [r.id]: { res: 'ANULADA', note: '', at: '', causa: 'CLIENTE' } })} className="min-h-11 rounded-lg border border-rose-300 px-3 font-semibold text-rose-800">Anular</button>
              </div>
            : <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                <div className="grid gap-2">
                  {d.res === 'REPROGRAMADA' && <div className="flex flex-wrap gap-2">
                    <label className="text-xs font-semibold">Nueva fecha y hora<input type="datetime-local" value={d.at} onChange={e => setDraft({ ...draft, [r.id]: { ...d, at: e.target.value } })} className={`mt-1 block ${field}`} /></label>
                    <label className="text-xs font-semibold">Causa<select value={d.causa} onChange={e => setDraft({ ...draft, [r.id]: { ...d, causa: e.target.value } })} className={`mt-1 block ${field}`}>
                      {Object.entries(CAUSAS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                  </div>}
                  <label className="text-xs font-semibold">Motivo ({d.res === 'ENTREGADA' ? 'entregada' : d.res === 'REPROGRAMADA' ? 'reprogramar' : 'anular'})
                    <input value={d.note} onChange={e => setDraft({ ...draft, [r.id]: { ...d, note: e.target.value } })} placeholder="Al menos 10 caracteres" className={`mt-1 block w-full ${field}`} /></label>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setDraft(x => { const y = { ...x }; delete y[r.id]; return y })} className="min-h-11 rounded-lg border px-3 font-semibold">Cancelar</button>
                  <button type="button" disabled={busy === r.id || d.note.trim().length < 10 || (d.res === 'REPROGRAMADA' && !d.at)} onClick={() => void resolve(r, d)}
                    className="min-h-11 rounded-lg bg-[#002855] px-3 font-semibold text-white disabled:opacity-50">{busy === r.id ? 'Guardando…' : 'Confirmar'}</button>
                </div>
              </div>)}
        </li>
      })}</ul>}
  </div>
}
