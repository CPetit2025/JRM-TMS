'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fmtDate, type BoardRow } from '@/lib/warehouse/packing-list'

export const PRIORITIES: Record<string, string> = { URGENTE: 'Urgente', ALTA: 'Alta', NORMAL: 'Normal', BAJA: 'Baja' }
type Person = { id: string; name: string }
type HistoryItem = { at: string; type: string; by: string | null; to: string | null; previous: string | null; priority: string | null; previous_priority: string | null; committed_at: string | null; previous_committed_at: string | null; reason: string | null }

// datetime-local trabaja en hora local del navegador (Lima en la operación)
const toLocal = (v: string | null | undefined) => { if (!v) return ''; const d = new Date(v); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }

/** Supervisión asigna responsable, prioridad y compromiso. Asignar no inicia la tarea; cambios con motivo e historial. */
export function TaskPlanDialog({ task, onClose, onSaved }: { task: BoardRow; onClose: () => void; onSaved: () => Promise<void> }) {
  const [people, setPeople] = useState<Person[]>([])
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [assignee, setAssignee] = useState(task.assigned_picker || '')
  const [priority, setPriority] = useState(task.priority || 'NORMAL')
  const [due, setDue] = useState(toLocal(task.committed_at))
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const db = createClient()
    void db.rpc('wh_task_assignees', { p_task_id: task.id }).then(r => r.error ? setError(r.error.message) : setPeople(r.data as Person[]))
    void db.rpc('wh_task_assignment_history', { p_task_id: task.id }).then(r => { if (!r.error) setHistory(r.data as HistoryItem[]) })
  }, [task.id])
  useEffect(() => { const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; window.addEventListener('keydown', esc); return () => window.removeEventListener('keydown', esc) }, [onClose])
  const reassign = Boolean(task.assigned_picker && assignee && assignee !== task.assigned_picker)
  const moveDue = Boolean(task.committed_at && toLocal(task.committed_at) !== due)
  const save = async () => {
    setBusy(true); setError('')
    const r = await createClient().rpc('wh_task_plan', { p_task_id: task.id, p_assignee: assignee || null, p_priority: priority, p_committed_at: due ? new Date(due).toISOString() : null, p_reason: reason.trim() || null })
    setBusy(false)
    if (r.error) { setError(r.error.message); return }
    await onSaved(); onClose()
  }
  const field = 'mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-normal'
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-2 sm:items-center" onClick={onClose}>
    <div role="dialog" aria-modal="true" aria-label={`Planificar ${task.request_number || task.task_code}`} onClick={e => e.stopPropagation()} className="max-h-[calc(100dvh-1rem)] w-full max-w-lg space-y-3 overflow-y-auto rounded-xl bg-white p-4 text-sm">
      <h2 className="text-lg font-bold text-[#002855]">Planificar {task.request_number || task.task_code}</h2>
      <p className="text-slate-600">Asignar no inicia la tarea: el responsable la inicia al tomarla.</p>
      {error && <p role="alert" className="rounded-lg bg-rose-50 p-2 text-rose-900">{error}</p>}
      <label className="block font-semibold">Responsable<select value={assignee} onChange={e => setAssignee(e.target.value)} className={field}>
        <option value="">{task.assigned_picker ? 'Mantener actual' : 'Sin asignar'}</option>{people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block font-semibold">Prioridad<select value={priority} onChange={e => setPriority(e.target.value)} className={field}>{Object.entries(PRIORITIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="block font-semibold">Compromiso<input type="datetime-local" value={due} onChange={e => setDue(e.target.value)} className={field}/></label>
      </div>
      {(reassign || moveDue) && <label className="block font-semibold">Motivo {reassign ? 'de la reasignación' : 'del cambio de compromiso'}<input required value={reason} onChange={e => setReason(e.target.value)} maxLength={300} className={field}/></label>}
      <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-3 py-2 font-bold">Cancelar</button>
        <button type="button" disabled={busy || ((reassign || moveDue) && !reason.trim())} onClick={() => void save()} className="rounded-lg bg-[#002855] px-3 py-2 font-bold text-white disabled:opacity-50">{busy ? 'Guardando…' : 'Guardar'}</button></div>
      <h3 className="font-bold text-[#002855]">Historial de asignación</h3>
      {history.length === 0 ? <p className="text-slate-500">Sin asignaciones registradas.</p> : <ol className="space-y-2">{history.map((h, i) => <li key={i} className="rounded-lg bg-slate-50 p-2">
        <b>{fmtDate(h.at)}</b> · {h.type === 'TASK_ASSIGNED' ? `${h.by || '—'} tomó la tarea` : `${h.by || '—'} planificó: responsable ${h.to || 'sin asignar'}${h.previous && h.previous !== h.to ? ` (antes ${h.previous})` : ''}`}
        {h.priority && <span> · prioridad {PRIORITIES[h.priority] || h.priority}{h.previous_priority && h.previous_priority !== h.priority ? ` (antes ${PRIORITIES[h.previous_priority] || h.previous_priority})` : ''}</span>}
        {h.type === 'TASK_PLANNED' && h.committed_at !== h.previous_committed_at && <span> · compromiso {h.committed_at ? fmtDate(h.committed_at) : 'sin fecha'}{h.previous_committed_at ? ` (antes ${fmtDate(h.previous_committed_at)})` : ''}</span>}
        {h.reason && <small className="block text-slate-600">Motivo: {h.reason}</small>}
      </li>)}</ol>}
    </div>
  </div>
}
