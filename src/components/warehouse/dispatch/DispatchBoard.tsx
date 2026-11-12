'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { TablePagination } from '@/components/ui/table-pagination'
import { usePagination } from '@/lib/use-pagination'
import { PeriodFilter, usePeriod } from '@/components/ui/period-filter'
import { readCache, writeCache } from '@/lib/use-cached'
import { ClipboardList, RefreshCw, Search } from 'lucide-react'
import { STATE, fmtDate, type BoardRow } from '@/lib/warehouse/packing-list'
import { syncFromTms } from '@/lib/warehouse/sync'
import { DispatchNav } from '@/components/warehouse/dispatch/DispatchNav'
import { DISPATCH_STAGES, TASK_GROUPS, attendedInTms, taskGroup, taskInStage, type TaskGroup, type TaskStage } from '@/lib/warehouse/dispatch'
import { usePermissions } from '@/hooks/usePermissions'

const approved = ['APROBADA', 'APROBADO', 'ASIGNADA']
// Minutos sin actividad del responsable tras los que otro operador puede tomar la tarea (igual que wh_assign_task)
const IDLE_MIN = 20
// Fecha del tablero en Lima: la requerida o, si falta, la de cierre (tareas cerradas).
const limaDate = (r: BoardRow) => r.required_at ? new Date(r.required_at).toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
  : r.required_date || (r.closed_at ? new Date(r.closed_at).toLocaleDateString('en-CA', { timeZone: 'America/Lima' }) : null)
// Filtro por grupo del historial de Picking; por defecto, las activas (pendientes y en proceso).
const GROUP_FILTERS: [string, string][] = [['ACTIVAS', 'Pendiente + En proceso'], ...Object.entries(TASK_GROUPS), ['TODOS', 'Todos']]
const groupMatch = (r: BoardRow, f: string) => f === 'TODOS' || (f === 'ACTIVAS' ? ['PENDIENTE', 'EN_PROCESO'].includes(taskGroup(r)) : taskGroup(r) === f)
const dateLabel = (r: BoardRow) => r.required_at
  ? new Date(r.required_at).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' })
  : r.required_date ? new Date(r.required_date + 'T12:00:00').toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : r.closed_at ? fmtDate(r.closed_at) : 'Sin fecha'

export function DispatchBoard({ stage }: { stage: TaskStage }) {
  const stageConfig = DISPATCH_STAGES[stage]
  const picking = stage === 'picking'
  const router = useRouter()
  const { hasAccess } = usePermissions()
  const [rows, setRows] = useState<BoardRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('ALL')
  const [group, setGroup] = useState('ACTIVAS')
  const [userId, setUserId] = useState('')
  const [now, setNow] = useState(0)

  const periodState = usePeriod()
  const [from, to] = periodState.range
  const load = useCallback(async (force = false) => {
    setWarning(await syncFromTms(force))
    const db = createClient()
    const [{ data: auth }, result] = await Promise.all([db.auth.getUser(), db.rpc('wh_task_board', picking ? { p_scope: 'historial', p_from: from, p_to: to } : { p_scope: 'tareas' })])
    if (auth.user) setUserId(auth.user.id)
    if (result.error) setError(result.error.message)
    else { setError(''); setRows((result.data || []) as BoardRow[]); setNow(Date.now()); void writeCache('wh-task-board', result.data || []) }
    setLoading(false)
  }, [picking, from, to])

  useEffect(() => {
    void readCache<BoardRow[]>('wh-task-board').then(cached => { if (cached) { setRows(r => r.length ? r : cached); setNow(n => n || Date.now()); setLoading(false) } })
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
    const timer = window.setInterval(() => void load(), 20000)
    return () => window.clearInterval(timer)
  }, [load])

  const take = async (task: BoardRow, takeover = false) => {
    const reason = takeover ? window.prompt(`Motivo para tomar la tarea de ${task.picker_name || 'otro operador'}:`)?.trim() : undefined
    if (takeover && !reason) return
    setBusyId(task.id); setError('')
    const db = createClient()
    const assigned = await db.rpc('wh_assign_task', { p_task_id: task.id, p_reason: reason ?? null })
    if (assigned.error) { setError(assigned.error.message); setBusyId(''); await load(); return }
    if (task.status === 'PENDING') {
      const started = await db.rpc('wh_task_action', { p_task_id: task.id, p_action: 'START_PICKING' })
      if (started.error) { setError(started.error.message); setBusyId(''); return }
    }
    router.push(`${stageConfig.path}/${task.id}`)
  }

  // Fecha requerida en hora de Lima; sin fecha siempre se muestra. Una búsqueda incluye todas las fechas.
  const inPeriod = (r: BoardRow) => { const d = limaDate(r)
    return !d || needle !== '' || (d >= periodState.range[0] && d <= periodState.range[1]) }
  const needle = query.trim().toLocaleLowerCase()
  // En Picking se ven todas las etapas (historial); el filtro de grupo reemplaza al de estado.
  const base = rows.filter(r => (picking || (taskInStage(r, stage) && (filter === 'ALL' || r.display_state === filter))) && inPeriod(r) &&
    (!needle || [r.request_number, r.task_code, r.contract_code, r.components, r.lots, r.client_name].join(' ').toLocaleLowerCase().includes(needle)))
  const counts = base.reduce<Record<string, number>>((c, r) => { c[taskGroup(r)] = (c[taskGroup(r)] || 0) + 1; return c }, {})
  const countOf = (f: string) => f === 'TODOS' ? base.length : f === 'ACTIVAS' ? (counts.PENDIENTE || 0) + (counts.EN_PROCESO || 0) : counts[f as TaskGroup] || 0
  const filtered = picking ? base.filter(r => groupMatch(r, group)) : base
  const pager = usePagination(filtered, `wh-board-${stage}`)

  return <div className="space-y-4">
    <DispatchNav stage={stage}/>
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-blue-700">Despacho</p>
        <h1 className="mt-1 text-3xl font-black text-[#002855]">{stageConfig.title}</h1>
        <p className="mt-1 text-sm text-slate-600">{stageConfig.description}</p>
      </div>
      <button onClick={() => void load(true)} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold"><RefreshCw size={16}/>Actualizar</button>
    </header>

    <section className="flex flex-wrap gap-3 rounded-xl border border-slate-200 bg-white p-3">
      <label className="relative min-w-64 flex-1">
        <Search size={16} className="absolute left-3 top-3 text-slate-400"/>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar solicitud, OT, lote o cliente" className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm"/>
      </label>
      {!picking && <select value={filter} onChange={e => setFilter(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" aria-label="Estado">
        <option value="ALL">Todas las activas</option>
        {['PENDIENTE', 'EN_PICKING', 'EN_AUDITORIA', 'OBSERVADO', 'LIBERADO'].map(k => <option key={k} value={k}>{STATE[k].label}</option>)}
      </select>}
      <div className="basis-full"><PeriodFilter state={periodState} note={needle ? (picking ? 'La búsqueda incluye las activas de todas las fechas; las cerradas, del período.' : 'La búsqueda incluye todas las fechas.') : undefined}/></div>
      {picking && <div className="flex basis-full flex-wrap gap-1.5" role="group" aria-label="Estado del picking">
        {GROUP_FILTERS.map(([k, label]) => <button key={k} type="button" onClick={() => setGroup(k)} aria-pressed={group === k}
          className={`rounded-full px-3 py-1 text-xs font-semibold ${group === k ? 'bg-[#002855] text-white' : 'bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50'}`}>{label} ({countOf(k)})</button>)}
      </div>}
    </section>
    {error && <div role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</div>}
    {warning && <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{warning}</div>}

    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="min-w-[860px] lg:min-w-0 w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-600">
            <tr><th className="px-3 py-2.5">Fecha</th><th className="px-3 py-2.5">Solicitud</th><th className="px-3 py-2.5">OT / Lote</th><th className="px-3 py-2.5">Cliente</th><th className="px-3 py-2.5">Estado</th><th className="px-3 py-2.5">Responsable</th><th className="px-3 py-2.5 text-right">Acciones</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? <tr><td colSpan={7} className="p-10 text-center text-slate-500">Cargando tareas…</td></tr>
              : filtered.length === 0 ? <tr><td colSpan={7} className="p-10 text-center">
                <ClipboardList className="mx-auto h-8 w-8 text-slate-300"/>
                <p className="mt-2 font-semibold text-slate-700">No hay tareas para mostrar</p>
              </td></tr>
              : pager.pageRows.map(r => {
                const state = STATE[attendedInTms(r) ? 'ATENDIDO_TMS' : r.display_state] || { label: r.display_state, style: 'bg-slate-100 text-slate-700' }
                // Fuera de la etapa (liberadas, cargadas, canceladas): solo lectura.
                const readOnly = picking && !taskInStage(r, 'picking')
                const mine = Boolean(userId && r.assigned_picker === userId)
                const otherOwner = Boolean(r.assigned_picker && !mine)
                const canTake = picking && (hasAccess('almacen-picking') || hasAccess('almacen-supervisor')) && !r.assigned_picker && approved.includes(r.request_status?.toUpperCase()) && ['PENDING', 'PICKING', 'PACKING'].includes(r.status)
                const idle = r.last_activity_at ? Math.floor((now - Date.parse(r.last_activity_at)) / 60000) : 0
                const canTakeOver = picking && otherOwner && ['PENDING', 'PICKING', 'PACKING'].includes(r.status) && (hasAccess('almacen-picking') || hasAccess('almacen-supervisor'))
                  && (idle >= IDLE_MIN || hasAccess('almacen-supervisor'))
                return <tr key={r.id} className="hover:bg-blue-50/40">
                  <td className="whitespace-nowrap px-3 py-2.5 text-slate-700">{dateLabel(r)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 font-semibold text-[#002855]">{r.request_number || r.task_code}
                    {(r.tms_dispatch_number || r.tms_vehicle_plate) && <small className="block font-normal text-slate-500" title={r.tms_driver_name ? `Conductor: ${r.tms_driver_name}` : 'Unidad asignada en el TMS'}>
                      Ruta {r.tms_dispatch_number || '—'}{r.tms_vehicle_plate ? ` · ${r.tms_vehicle_plate}` : ''}</small>}</td>
                  <td className="px-3 py-2.5"><b>{r.contract_code || '—'}</b>{(r.components || r.lots) && <small className="block text-slate-500">{[r.components, r.lots].filter(Boolean).join(' · ')}</small>}</td>
                  <td className="px-3 py-2.5 text-slate-700">{r.client_name || '—'}</td>
                  <td className="px-3 py-2.5"><span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold ${state.style}`}>{state.label}</span>
                    {r.lpn_total > 0 && <small className="block text-slate-500">{r.lpn_approved}/{r.lpn_total} LPN aprobados</small>}
                    {r.closed_at && <small className="block text-slate-500">{r.status === 'CANCELLED' ? 'Cerrada' : 'Cargada'} {fmtDate(r.closed_at)}{r.closed_by_name ? ` · ${r.closed_by_name}` : ''}</small>}
                    {r.status === 'CANCELLED' && !attendedInTms(r) && r.cancelled_reason && <small className="block text-rose-700">{r.cancelled_reason}</small>}</td>
                  <td className="px-3 py-2.5 text-slate-700">{r.picker_name || '—'}{otherOwner && idle >= IDLE_MIN && <small className="block font-semibold text-amber-700">Sin actividad hace {idle} min</small>}</td>
                  <td className="px-3 py-2.5 text-right">
                    {readOnly ? <Link href={`${stageConfig.path}/${r.id}`} className="text-xs font-semibold text-blue-800 underline">Ver detalle</Link>
                      : !picking ? <Link href={`${stageConfig.path}/${r.id}`} className="inline-block rounded-lg bg-[#002855] px-3 py-2 text-xs font-bold text-white">Abrir {stageConfig.title.toLowerCase()}</Link> : canTake ? <button type="button" disabled={busyId === r.id} onClick={() => void take(r)} className="whitespace-nowrap rounded-lg bg-[#002855] px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{busyId === r.id ? 'Tomando…' : 'Tomar tarea'}</button>
                      : mine ? <Link href={`${stageConfig.path}/${r.id}`} className="inline-block whitespace-nowrap rounded-lg bg-[#002855] px-3 py-2 text-xs font-bold text-white">Continuar</Link>
                      : canTakeOver ? <span className="inline-flex flex-wrap items-center justify-end gap-2"><button type="button" disabled={busyId === r.id} onClick={() => void take(r, true)} className="whitespace-nowrap rounded-lg border border-amber-400 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900 disabled:opacity-50">{busyId === r.id ? 'Tomando…' : 'Tomar tarea'}</button><Link href={`${stageConfig.path}/${r.id}`} className="text-xs font-semibold text-blue-800 underline">Ver</Link></span>
                      : otherOwner ? <Link href={`${stageConfig.path}/${r.id}`} className="text-xs font-semibold text-blue-800 underline">Ver tarea</Link>
                      : <span className="text-xs text-slate-500" title="La solicitud debe estar aprobada en TMS">Por aprobar en TMS</span>}
                  </td>
                </tr>
              })}
          </tbody>
        </table>
      </div>
      {!loading && filtered.length > 0 && <TablePagination total={pager.total} page={pager.page} pageSize={pager.pageSize} onPageChange={pager.setPage} onPageSizeChange={pager.setPageSize} itemLabel="tareas" compact />}
    </div>
  </div>
}
