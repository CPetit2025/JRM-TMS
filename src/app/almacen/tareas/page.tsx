'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ClipboardList, RefreshCw, Search } from 'lucide-react'
import { STATE, type BoardRow } from '@/lib/warehouse/packing-list'
import { syncFromTms } from '@/lib/warehouse/sync'

const approved = ['APROBADA', 'APROBADO', 'ASIGNADA']
const dateLabel = (r: BoardRow) => r.required_at
  ? new Date(r.required_at).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' })
  : r.required_date ? new Date(r.required_date + 'T12:00:00').toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : 'Sin fecha'

export default function WarehouseTasksPage() {
  const router = useRouter()
  const [rows, setRows] = useState<BoardRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('ALL')
  const [userId, setUserId] = useState('')

  const load = useCallback(async (force = false) => {
    setWarning(await syncFromTms(force))
    const db = createClient()
    const [{ data: auth }, result] = await Promise.all([db.auth.getUser(), db.rpc('wh_task_board', { p_scope: 'tareas' })])
    if (auth.user) setUserId(auth.user.id)
    if (result.error) setError(result.error.message)
    else { setError(''); setRows((result.data || []) as BoardRow[]) }
    setLoading(false)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
    const timer = window.setInterval(() => void load(), 20000)
    return () => window.clearInterval(timer)
  }, [load])

  const take = async (task: BoardRow) => {
    setBusyId(task.id); setError('')
    const db = createClient()
    const assigned = await db.rpc('wh_assign_task', { p_task_id: task.id })
    if (assigned.error) { setError(assigned.error.message); setBusyId(''); await load(); return }
    if (task.status === 'PENDING') {
      const started = await db.rpc('wh_task_action', { p_task_id: task.id, p_action: 'START_PICKING' })
      if (started.error) { setError(started.error.message); setBusyId(''); return }
    }
    router.push(`/almacen/tareas/${task.id}`)
  }

  const needle = query.trim().toLocaleLowerCase()
  const filtered = rows.filter(r => (filter === 'ALL' || r.display_state === filter) &&
    (!needle || [r.request_number, r.task_code, r.contract_code, r.components, r.lots, r.client_name].join(' ').toLocaleLowerCase().includes(needle)))

  return <div className="space-y-4">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-blue-700">Despacho</p>
        <h1 className="mt-1 text-3xl font-black text-[#002855]">Tareas de almacén</h1>
        <p className="mt-1 text-sm text-slate-600">Solicitudes de despacho del TMS con OT, listas para preparar. Se actualiza sola.</p>
      </div>
      <button onClick={() => void load(true)} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold"><RefreshCw size={16}/>Actualizar</button>
    </header>

    <section className="flex flex-wrap gap-3 rounded-xl border border-slate-200 bg-white p-3">
      <label className="relative min-w-64 flex-1">
        <Search size={16} className="absolute left-3 top-3 text-slate-400"/>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar solicitud, OT, lote o cliente" className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm"/>
      </label>
      <select value={filter} onChange={e => setFilter(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" aria-label="Estado">
        <option value="ALL">Todas las activas</option>
        {['PENDIENTE', 'EN_PICKING', 'EN_AUDITORIA', 'OBSERVADO', 'LIBERADO'].map(k => <option key={k} value={k}>{STATE[k].label}</option>)}
      </select>
    </section>
    {error && <div role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</div>}
    {warning && <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{warning}</div>}

    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-600">
            <tr><th className="px-3 py-2.5">Fecha</th><th className="px-3 py-2.5">Solicitud</th><th className="px-3 py-2.5">OT / Lote</th><th className="px-3 py-2.5">Cliente</th><th className="px-3 py-2.5">Estado</th><th className="px-3 py-2.5">Responsable</th><th className="px-3 py-2.5 text-right">Acciones</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? <tr><td colSpan={7} className="p-10 text-center text-slate-500">Cargando tareas…</td></tr>
              : filtered.length === 0 ? <tr><td colSpan={7} className="p-10 text-center">
                <ClipboardList className="mx-auto h-8 w-8 text-slate-300"/>
                <p className="mt-2 font-semibold text-slate-700">No hay tareas para mostrar</p>
              </td></tr>
              : filtered.map(r => {
                const state = STATE[r.display_state] || { label: r.display_state, style: 'bg-slate-100 text-slate-700' }
                const mine = Boolean(userId && r.assigned_picker === userId)
                const otherOwner = Boolean(r.assigned_picker && !mine)
                const canTake = !r.assigned_picker && approved.includes(r.request_status?.toUpperCase()) && ['PENDING', 'PICKING', 'PACKING'].includes(r.status)
                return <tr key={r.id} className="hover:bg-blue-50/40">
                  <td className="whitespace-nowrap px-3 py-2.5 text-slate-700">{dateLabel(r)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 font-semibold text-[#002855]">{r.request_number || r.task_code}</td>
                  <td className="px-3 py-2.5"><b>{r.contract_code || '—'}</b>{(r.components || r.lots) && <small className="block text-slate-500">{[r.components, r.lots].filter(Boolean).join(' · ')}</small>}</td>
                  <td className="px-3 py-2.5 text-slate-700">{r.client_name || '—'}</td>
                  <td className="px-3 py-2.5"><span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold ${state.style}`}>{state.label}</span>
                    {r.lpn_total > 0 && <small className="block text-slate-500">{r.lpn_approved}/{r.lpn_total} LPN aprobados</small>}</td>
                  <td className="px-3 py-2.5 text-slate-700">{r.picker_name || '—'}</td>
                  <td className="px-3 py-2.5 text-right">
                    {canTake ? <button type="button" disabled={busyId === r.id} onClick={() => void take(r)} className="whitespace-nowrap rounded-lg bg-[#002855] px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{busyId === r.id ? 'Tomando…' : 'Tomar tarea'}</button>
                      : mine ? <Link href={`/almacen/tareas/${r.id}`} className="inline-block whitespace-nowrap rounded-lg bg-[#002855] px-3 py-2 text-xs font-bold text-white">Continuar</Link>
                      : otherOwner ? <Link href={`/almacen/tareas/${r.id}`} className="text-xs font-semibold text-blue-800 underline">Ver tarea</Link>
                      : <span className="text-xs text-slate-500" title="La solicitud debe estar aprobada en TMS">Por aprobar en TMS</span>}
                  </td>
                </tr>
              })}
          </tbody>
        </table>
      </div>
    </div>
  </div>
}
