'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ClipboardList, RefreshCw, Search, UserRoundCheck } from 'lucide-react'

type Request = {
  request_number: string
  requester_name: string | null
  delivery_address: string | null
  required_date: string | null
  required_at: string | null
  reference_number: string | null
  request_client?: { business_name: string | null } | null
  contracts?: { code: string | null } | null
}
type Task = {
  id: string
  task_code: string
  status: string
  created_at: string
  contract_id: string | null
  assigned_picker: string | null
  transport_requests?: Request | null
}
type Urgency = { label: string; style: string }
const labels: Record<string, string> = {
  PENDING: 'Pendiente', PARTIAL: 'Carga parcial', PICKING: 'En picking', PAUSED: 'Pausada',
  PACKING: 'En packing', READY_FOR_LOAD: 'Lista para cargar', LOADED: 'Cargada',
  RECONCILED: 'Conciliada', CANCELLED: 'Cancelada',
}
const terminal = ['LOADED', 'RECONCILED', 'CANCELLED']
function urgency(date: string | null, at: string | null): Urgency {
  if (!date && !at) return { label: 'Sin fecha', style: 'border-slate-200 bg-slate-100 text-slate-600' }
  const due = (at || date || '').slice(0, 10)
  const limaToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const delta = Math.round((Date.parse(due + 'T12:00:00Z') - Date.parse(limaToday + 'T12:00:00Z')) / 86400000)
  if (delta < 0) return { label: 'Urgente', style: 'border-rose-200 bg-rose-100 text-rose-800' }
  if (delta === 0) return { label: 'Hoy', style: 'border-orange-200 bg-orange-100 text-orange-800' }
  if (delta <= 3) return { label: 'Próxima', style: 'border-amber-200 bg-amber-100 text-amber-900' }
  return { label: 'Programada', style: 'border-emerald-200 bg-emerald-100 text-emerald-800' }
}
const dateLabel = (date: string | null, at: string | null) => {
  if (at) return new Date(at).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'medium', timeStyle: 'short' })
  if (date) return new Date(date + 'T12:00:00').toLocaleDateString('es-PE', { timeZone: 'America/Lima', dateStyle: 'medium' })
  return 'Sin fecha'
}
const requestRef = (r?: Request | null) => r?.contracts?.code || r?.reference_number || r?.request_number || '—'
const requestClient = (r?: Request | null) => r?.request_client?.business_name || r?.requester_name || '—'

export default function WarehouseTasksPage() {
  const [rows, setRows] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('ACTIVE')
  const [userId, setUserId] = useState('')

  const load = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true)
    setError('')
    const db = createClient()
    const [{ data: auth }, result] = await Promise.all([
      db.auth.getUser(),
      (() => {
        let req = db.from('wh_tasks')
          .select('id,task_code,status,created_at,contract_id,assigned_picker,transport_requests(request_number,requester_name,delivery_address,required_date,required_at,reference_number,request_client:clients!client_id(business_name),contracts(code))')
          .order('created_at', { ascending: false }).limit(500)
        if (filter === 'ACTIVE') req = req.not('status', 'in', '(LOADED,RECONCILED,CANCELLED)')
        else if (filter !== 'ALL') req = req.eq('status', filter)
        return req
      })(),
    ])
    if (auth.user) setUserId(auth.user.id)
    if (result.error) setError(/does not exist|schema cache/i.test(result.error.message)
      ? 'La migración WMS no está aplicada en el entorno de esta versión.'
      : result.error.message)
    else setRows((result.data || []) as unknown as Task[])
    setLoading(false)
  }, [filter])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(false), 30000)
    return () => window.clearInterval(timer)
  }, [load])

  const assign = async (task: Task) => {
    setBusyId(task.id)
    setError('')
    setNotice('')
    const { error: assignError } = await createClient().rpc('wh_assign_task', { p_task_id: task.id })
    if (assignError) setError(assignError.message)
    else {
      setNotice(`La tarea ${task.task_code} quedó asignada a tu usuario.`)
      await load(false)
    }
    setBusyId('')
  }

  const filtered = rows.filter(task => {
    const r = task.transport_requests
    const haystack = [task.task_code, requestRef(r), requestClient(r), r?.delivery_address || '', r?.required_date || ''].join(' ').toLocaleLowerCase()
    return haystack.includes(query.toLocaleLowerCase())
  })

  return <div className="space-y-5">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-blue-700">Despacho</p>
        <h1 className="mt-1 text-3xl font-black text-[#002855]">Tareas de despacho</h1>
        <p className="mt-1 text-sm text-slate-600">Las solicitudes de transporte registradas en TMS generan aquí una tarea de almacén.</p>
      </div>
      <button onClick={() => void load()} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold"><RefreshCw size={16}/>Actualizar</button>
    </header>

    <section className="flex flex-wrap gap-3 rounded-xl border border-slate-200 bg-white p-3">
      <label className="relative min-w-64 flex-1">
        <Search size={16} className="absolute left-3 top-3 text-slate-400"/>
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar OT, lote, cliente o punto de entrega" className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm"/>
      </label>
      <select value={filter} onChange={event => setFilter(event.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
        <option value="ACTIVE">Tareas activas</option><option value="ALL">Todos los estados</option>
        {Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
    </section>
    {error && <div role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</div>}
    {notice && <div role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</div>}

    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-600">
            <tr><th className="px-4 py-3">Fecha de Atención</th><th className="px-4 py-3">OT o Lote</th><th className="px-4 py-3">Cliente</th><th className="px-4 py-3">Punto de entrega</th><th className="px-4 py-3 text-right">Acciones</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? <tr><td colSpan={5} className="p-10 text-center text-slate-500">Cargando tareas…</td></tr>
              : filtered.length === 0 ? <tr><td colSpan={5} className="p-10 text-center">
                <ClipboardList className="mx-auto h-8 w-8 text-slate-300"/>
                <p className="mt-2 font-semibold text-slate-700">No hay tareas para mostrar</p>
                <p className="mt-1 text-sm text-slate-500">Las solicitudes elegibles de transporte aparecen automáticamente al registrarse en TMS.</p>
              </td></tr>
              : filtered.map(task => {
                const request = task.transport_requests
                const level = urgency(request?.required_date || null, request?.required_at || null)
                const assignedToMe = Boolean(userId && task.assigned_picker === userId)
                const unavailable = terminal.includes(task.status)
                return <tr key={task.id} className="hover:bg-blue-50/40">
                  <td className="whitespace-nowrap px-4 py-3 text-slate-700">
                    <span className="block">{dateLabel(request?.required_date || null, request?.required_at || null)}</span>
                    <span className={`mt-1 inline-flex rounded-full border px-2 py-0.5 text-[11px] font-bold ${level.style}`}>{level.label}</span>
                  </td>
                  <td className="px-4 py-3 font-semibold text-[#002855]">{requestRef(request)}</td>
                  <td className="px-4 py-3 text-slate-700">{requestClient(request)}</td>
                  <td className="max-w-[360px] px-4 py-3 text-slate-700">{request?.delivery_address || 'Sin punto de entrega'}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button type="button" disabled={busyId === task.id || unavailable || (Boolean(task.assigned_picker) && !assignedToMe)} onClick={() => void assign(task)} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-[#002855] px-3 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-50" title={task.assigned_picker && !assignedToMe ? 'Ya está asignada a otro usuario' : 'Asignar la tarea a tu usuario'}>
                        <UserRoundCheck size={14}/>{busyId === task.id ? 'Asignando…' : assignedToMe ? 'Asignada a mí' : task.assigned_picker ? 'Asignada' : 'Asignar Tarea'}
                      </button>
                      <button type="button" aria-label={`Prioridad: ${level.label}`} title={`Urgencia calculada según la fecha de atención: ${level.label}`} className={`inline-flex min-w-[104px] cursor-default justify-center rounded-lg border px-2.5 py-2 text-xs font-extrabold ${level.style}`}>Prioridad · {level.label}</button>
                    </div>
                    {!assignedToMe && task.assigned_picker && <Link href={`/almacen/tareas/${task.id}`} className="mt-1 block text-right text-[11px] font-semibold text-blue-800 underline">Ver tarea</Link>}
                    {assignedToMe && <Link href={`/almacen/tareas/${task.id}`} className="mt-1 block text-right text-[11px] font-semibold text-blue-800 underline">Abrir tarea</Link>}
                  </td>
                </tr>
              })}
          </tbody>
        </table>
      </div>
    </div>
  </div>
}
