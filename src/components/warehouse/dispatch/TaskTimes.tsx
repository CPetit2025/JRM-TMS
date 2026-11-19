'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { fmt, fmtDate, type BoardRow } from '@/lib/warehouse/packing-list'

export const WAIT_REASONS: Record<string, string> = { STOCK: 'Stock', PROGRAMACION: 'Programación', AUDITORIA: 'Auditoría', CORRECCION: 'Corrección', DOCUMENTACION: 'Documentación', VEHICULO: 'Vehículo', EQUIPO: 'Equipo', SISTEMA: 'Sistema', OTRO: 'Otro' }
type Times = { inicio: string | null; listo_auditoria: string | null; en_curso: boolean; transcurrido_min: number | null; espera_min: number | null; activo_min: number | null; espera_por_motivo: Record<string, number>; espera_abierta: { reason: string; note: string | null; since: string; by: string | null } | null }
const min = (v: number | null) => v === null ? 'sin dato' : `${fmt(v, 0)} min`

/** Tiempo activo vs. espera de la tarea y registro de esperas con motivo (no cambian el estado de la tarea). */
export function TaskTimes({ task, onChanged }: { task: BoardRow; onChanged: () => Promise<unknown> }) {
  const { hasAccess } = usePermissions()
  const [times, setTimes] = useState<Times | null>(null)
  const [userId, setUserId] = useState('')
  const [reason, setReason] = useState('STOCK')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    const r = await createClient().rpc('wh_task_times', { p_task_id: task.id })
    setTimes(r.error || typeof r.data?.en_curso !== 'boolean' ? null : r.data as Times)
  }, [task.id])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
    void createClient().auth.getUser().then(({ data }) => setUserId(data.user?.id || ''))
  }, [load, task])
  const canWait = (hasAccess('almacen-supervisor') || (userId !== '' && task.assigned_picker === userId)) && ['PICKING', 'PACKING'].includes(task.status)
  const act = async (action: 'START' | 'END') => {
    setBusy(true); setError('')
    const r = await createClient().rpc('wh_task_wait', { p_task_id: task.id, p_action: action, p_reason: action === 'START' ? reason : null, p_note: note.trim() || null })
    setBusy(false)
    if (r.error) { setError(r.error.message); return }
    setNote(''); await Promise.all([load(), onChanged()])
  }
  if (!times) return null
  const open = times.espera_abierta
  const reasons = Object.entries(times.espera_por_motivo || {})
  return <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 text-sm print:hidden">
    <h2 className="font-bold text-[#002855]">Tiempos de preparación</h2>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-5">
      <div><dt className="text-xs text-slate-500">Inicio de picking</dt><dd>{times.inicio ? fmtDate(times.inicio) : 'sin registro'}</dd></div>
      <div><dt className="text-xs text-slate-500">Listo para auditoría</dt><dd>{times.listo_auditoria ? fmtDate(times.listo_auditoria) : times.en_curso ? 'en preparación' : '—'}</dd></div>
      <div><dt className="text-xs text-slate-500">Transcurrido</dt><dd>{min(times.transcurrido_min)}</dd></div>
      <div><dt className="text-xs text-slate-500">Activo</dt><dd className="font-bold">{min(times.activo_min)}</dd></div>
      <div><dt className="text-xs text-slate-500">En espera</dt><dd>{min(times.espera_min)}</dd></div>
    </dl>
    {!times.inicio && <p className="text-xs text-slate-500">La tarea no tiene inicio registrado: los tiempos no se calculan (no se infieren de otras marcas).</p>}
    {reasons.length > 0 && <p className="text-xs text-slate-600">Espera por motivo: {reasons.map(([k, v]) => `${WAIT_REASONS[k] || k} ${fmt(v, 0)} min`).join(' · ')}</p>}
    {error && <p role="alert" className="rounded-lg bg-rose-50 p-2 text-rose-900">{error}</p>}
    {open ? <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 p-2 text-amber-900">
      <span><b>En espera: {WAIT_REASONS[open.reason] || open.reason}</b>{open.note ? ` · ${open.note}` : ''} · desde {fmtDate(open.since)}{open.by ? ` · ${open.by}` : ''}</span>
      {canWait && <button disabled={busy} onClick={() => void act('END')} className="rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">Terminar espera</button>}
    </div> : canWait && <div className="flex flex-wrap items-end gap-2">
      <label className="font-semibold">Motivo de espera<select value={reason} onChange={e => setReason(e.target.value)} className="mt-1 block rounded-lg border border-slate-300 px-2 py-1.5 font-normal">{Object.entries(WAIT_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="min-w-48 flex-1 font-semibold">Detalle{reason === 'OTRO' ? ' (obligatorio)' : ' (opcional)'}<input value={note} onChange={e => setNote(e.target.value)} maxLength={300} className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-1.5 font-normal"/></label>
      <button disabled={busy || (reason === 'OTRO' && !note.trim())} onClick={() => void act('START')} className="rounded-lg border border-amber-300 px-3 py-2 text-xs font-bold text-amber-900 disabled:opacity-50">Registrar espera</button>
    </div>}
  </section>
}
