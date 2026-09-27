'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/modal'
import { toast } from 'sonner'
import { format } from 'date-fns'
import {
  Loader2, Plus, RefreshCw, Wrench, CheckCircle2, PlayCircle, PauseCircle, Flag, ShieldCheck, XCircle,
  Lock, Trash2, Upload, ClipboardList, Package,
} from 'lucide-react'

const supabase = createClient()

// Gestor de OT (Fase 4). El estado, la aprobación, los tiempos y los totales solo cambian por RPC:
// transition_work_order, complete_maintenance_order, consume_work_order_part (migración 20260927120000).

type WoStatus = 'BORRADOR' | 'APROBADA' | 'PROGRAMADA' | 'EN_PROCESO' | 'EN_ESPERA' | 'TERMINADA' | 'VALIDACION' | 'CERRADA' | 'CANCELADA'

interface WorkOrder {
  id: string
  ot_code: string
  status: WoStatus
  order_type: string
  source_type: string | null
  priority: string
  description: string
  diagnostic: string | null
  activities_performed: string | null
  tasks: { text: string; done: boolean }[] | null
  evidence_urls: string[] | null
  notes: string | null
  vehicle_id: string
  vehicle_plate: string
  vehicle_status: string
  plan_name: string | null
  provider_id: string | null
  provider_name: string | null
  responsible_name: string | null
  mechanic_name: string | null
  approved_at: string | null
  closed_at: string | null
  cancel_reason: string | null
  start_date: string | null
  estimated_end_date: string | null
  downtime_start: string | null
  downtime_end: string | null
  downtime_hours: number | null
  labor_cost: number
  parts_cost: number
  services_cost: number
  total_cost: number
  linked_requests: number
  release_result: { eligibility?: { status: string; motives?: string[] } } | null
  created_at: string
}

interface CostLine { id: string; cost_type: string; amount: number; quantity: number | null; description: string | null; document_number: string | null; created_at: string }
interface SparePart { id: string; internal_code: string; name: string; current_stock: number | null; available: number | null }
interface Option { id: string; label: string }

const STATUS_STYLE: Record<WoStatus, string> = {
  BORRADOR: 'bg-slate-100 text-slate-700',
  APROBADA: 'bg-sky-100 text-sky-700',
  PROGRAMADA: 'bg-indigo-100 text-indigo-700',
  EN_PROCESO: 'bg-blue-100 text-blue-700',
  EN_ESPERA: 'bg-amber-100 text-amber-700',
  TERMINADA: 'bg-teal-100 text-teal-700',
  VALIDACION: 'bg-purple-100 text-purple-700',
  CERRADA: 'bg-emerald-100 text-emerald-700',
  CANCELADA: 'bg-red-100 text-red-700',
}
const ORDER_TYPES = ['CORRECTIVA', 'PREVENTIVA', 'EMERGENCIA', 'INSPECCION', 'MEJORA']
const PRIORITIES = ['BAJA', 'NORMAL', 'ALTA', 'CRITICA']
const OPEN_STATUSES: WoStatus[] = ['BORRADOR', 'APROBADA', 'PROGRAMADA', 'EN_PROCESO', 'EN_ESPERA', 'TERMINADA', 'VALIDACION']
const money = (n: number | null | undefined) => `S/ ${Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function queryWorkOrders() {
  return supabase.from('vw_work_orders').select('*').order('created_at', { ascending: false }).limit(300)
}

export default function GestorOT() {
  const [orders, setOrders] = useState<WorkOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<string>('ABIERTAS')
  const [typeFilter, setTypeFilter] = useState<string>('TODOS')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [vehicles, setVehicles] = useState<Option[]>([])
  const [providers, setProviders] = useState<Option[]>([])
  const [people, setPeople] = useState<Option[]>([])
  const [loadedAt, setLoadedAt] = useState(() => Date.now())

  const applyOrders = useCallback(({ data, error }: { data: unknown[] | null; error: { message: string } | null }) => {
    if (error) toast.error('No se pudieron cargar las OT: ' + error.message)
    else setOrders((data || []) as WorkOrder[])
    setLoadedAt(Date.now())
    setLoading(false)
  }, [])

  const refresh = useCallback(() => {
    setLoading(true)
    return queryWorkOrders().then(applyOrders)
  }, [applyOrders])

  useEffect(() => {
    queryWorkOrders().then(applyOrders)
    supabase.from('vehicles').select('id, plate, type').order('plate').then(({ data }) =>
      setVehicles((data || []).map((v: { id: string; plate: string; type: string }) => ({ id: v.id, label: `${v.plate} · ${v.type}` }))))
    supabase.from('maintenance_providers').select('id, business_name').order('business_name').then(({ data }) =>
      setProviders((data || []).map((p: { id: string; business_name: string }) => ({ id: p.id, label: p.business_name }))))
    supabase.from('profiles').select('id, first_name, last_name').eq('is_active', true).order('first_name').then(({ data }) =>
      setPeople((data || []).map((p: { id: string; first_name: string | null; last_name: string | null }) =>
        ({ id: p.id, label: `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.id.slice(0, 8) }))))
  }, [applyOrders])

  const filtered = useMemo(() => orders.filter(o =>
    (statusFilter === 'TODOS' || (statusFilter === 'ABIERTAS' ? OPEN_STATUSES.includes(o.status) : o.status === statusFilter)) &&
    (typeFilter === 'TODOS' || o.order_type === typeFilter) &&
    (!search || `${o.ot_code} ${o.vehicle_plate} ${o.description}`.toLowerCase().includes(search.toLowerCase()))
  ), [orders, statusFilter, typeFilter, search])

  const kpis = useMemo(() => {
    const monthStart = new Date(loadedAt); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0)
    const closed30 = orders.filter(o => o.status === 'CERRADA' && o.closed_at && loadedAt - new Date(o.closed_at).getTime() <= 30 * 86_400_000 && o.downtime_hours != null)
    return {
      open: orders.filter(o => OPEN_STATUSES.includes(o.status)).length,
      inProgress: orders.filter(o => o.status === 'EN_PROCESO' || o.status === 'EN_ESPERA').length,
      toValidate: orders.filter(o => o.status === 'TERMINADA' || o.status === 'VALIDACION').length,
      costMonth: orders.filter(o => new Date(o.created_at) >= monthStart && o.status !== 'CANCELADA').reduce((s, o) => s + Number(o.total_cost || 0), 0),
      mttr: closed30.length ? closed30.reduce((s, o) => s + Number(o.downtime_hours), 0) / closed30.length : null,
    }
  }, [orders, loadedAt])

  const selected = orders.find(o => o.id === selectedId) || null

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Gestor de Órdenes de Trabajo</h1>
          <p className="text-sm text-slate-500">Correctivas, preventivas, emergencias e inspecciones con costos, tiempos y liberación por motor de elegibilidad.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setCreateOpen(true)} className="px-4 py-2 bg-[#002855] text-white rounded-lg flex items-center gap-2 text-sm font-medium">
            <Plus className="w-4 h-4" /> Nueva OT
          </button>
          <button onClick={refresh} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-2" disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Actualizar
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          ['OT abiertas', kpis.open],
          ['En ejecución', kpis.inProgress],
          ['Por validar/cerrar', kpis.toValidate],
          ['Costo del mes', money(kpis.costMonth)],
          ['MTTR 30 días', kpis.mttr == null ? '—' : `${kpis.mttr.toFixed(1)} h`],
        ].map(([label, value]) => (
          <div key={label as string} className="bg-white border rounded-xl p-4">
            <div className="text-xs text-slate-500">{label}</div>
            <div className="text-xl font-bold text-slate-900">{value}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-3">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar OT, placa o descripción…"
          className="border rounded-lg px-3 py-2 text-sm w-64" />
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
          <option value="ABIERTAS">Abiertas</option>
          <option value="TODOS">Todas</option>
          {(Object.keys(STATUS_STYLE) as WoStatus[]).map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
          <option value="TODOS">Todos los tipos</option>
          {ORDER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      <div className="bg-white border rounded-xl overflow-x-auto">
        {loading ? (
          <div className="p-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-slate-500 text-sm">No hay órdenes de trabajo con estos filtros.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
              <tr>
                <th className="text-left p-3">OT</th><th className="text-left p-3">Unidad</th><th className="text-left p-3">Tipo / prioridad</th>
                <th className="text-left p-3">Estado</th><th className="text-left p-3">Responsable</th>
                <th className="text-right p-3">Indisp. (h)</th><th className="text-right p-3">Costo</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(o => (
                <tr key={o.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => setSelectedId(o.id)}>
                  <td className="p-3"><div className="font-semibold text-[#002855]">{o.ot_code}</div><div className="text-xs text-slate-500 line-clamp-1 max-w-xs">{o.description}</div></td>
                  <td className="p-3"><div className="font-medium">{o.vehicle_plate}</div><div className="text-xs text-slate-500">{o.vehicle_status?.replace(/_/g, ' ')}</div></td>
                  <td className="p-3"><div>{o.order_type}</div><div className={`text-xs ${o.priority === 'CRITICA' ? 'text-red-600 font-semibold' : 'text-slate-500'}`}>{o.priority}</div></td>
                  <td className="p-3"><span className={`px-2 py-1 rounded-full text-xs font-semibold ${STATUS_STYLE[o.status]}`}>{o.status.replace('_', ' ')}</span></td>
                  <td className="p-3 text-slate-600">{o.responsible_name || '—'}</td>
                  <td className="p-3 text-right">{o.downtime_hours != null ? Number(o.downtime_hours).toFixed(1) : '—'}</td>
                  <td className="p-3 text-right font-medium">{money(o.total_cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <CreateWorkOrderModal open={createOpen} onClose={() => setCreateOpen(false)} vehicles={vehicles} providers={providers}
        people={people} onCreated={() => { setCreateOpen(false); refresh() }} />
      {selected && (
        <WorkOrderDetail order={selected} providers={providers} people={people}
          onClose={() => setSelectedId(null)} onChanged={refresh} />
      )}
    </div>
  )
}

function CreateWorkOrderModal({ open, onClose, vehicles, providers, people, onCreated }: {
  open: boolean; onClose: () => void; vehicles: Option[]; providers: Option[]; people: Option[]; onCreated: () => void
}) {
  const empty = { vehicle_id: '', order_type: 'CORRECTIVA', priority: 'NORMAL', description: '', start_date: '', estimated_end_date: '', responsible_id: '', mechanic_id: '', provider_id: '', workshop_name: '' }
  const [form, setForm] = useState(empty)
  const [saving, setSaving] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    const code = `OT-${format(new Date(), 'yyMMdd')}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
    const { error } = await supabase.from('maintenance_work_orders').insert({
      ot_code: code,
      vehicle_id: form.vehicle_id,
      order_type: form.order_type,
      source_type: 'MANUAL',
      priority: form.priority,
      description: form.description.trim(),
      start_date: form.start_date || null,
      estimated_end_date: form.estimated_end_date || null,
      responsible_id: form.responsible_id || null,
      mechanic_id: form.mechanic_id || null,
      provider_id: form.provider_id || null,
      workshop_name: form.workshop_name || null,
    })
    setSaving(false)
    if (error) return toast.error('No se pudo crear la OT: ' + error.message)
    toast.success(`OT ${code} creada en BORRADOR`)
    setForm(empty)
    onCreated()
  }

  const field = 'w-full border rounded-lg px-3 py-2 text-sm'
  return (
    <Modal isOpen={open} onClose={onClose} title="Nueva orden de trabajo" maxWidth="max-w-2xl">
      <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="text-sm">Unidad
          <select required className={field} value={form.vehicle_id} onChange={e => setForm({ ...form, vehicle_id: e.target.value })}>
            <option value="">Seleccionar…</option>{vehicles.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </label>
        <label className="text-sm">Tipo
          <select className={field} value={form.order_type} onChange={e => setForm({ ...form, order_type: e.target.value })}>
            {ORDER_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
        </label>
        <label className="text-sm md:col-span-2">Descripción
          <textarea required className={field} rows={2} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
        </label>
        <label className="text-sm">Prioridad
          <select className={field} value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}>
            {PRIORITIES.map(p => <option key={p}>{p}</option>)}
          </select>
        </label>
        <label className="text-sm">Proveedor / taller externo
          <select className={field} value={form.provider_id} onChange={e => setForm({ ...form, provider_id: e.target.value })}>
            <option value="">Taller propio</option>{providers.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label className="text-sm">Inicio programado<input type="date" className={field} value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })} /></label>
        <label className="text-sm">Fin estimado<input type="date" className={field} value={form.estimated_end_date} onChange={e => setForm({ ...form, estimated_end_date: e.target.value })} /></label>
        <label className="text-sm">Responsable
          <select className={field} value={form.responsible_id} onChange={e => setForm({ ...form, responsible_id: e.target.value })}>
            <option value="">—</option>{people.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label className="text-sm">Mecánico
          <select className={field} value={form.mechanic_id} onChange={e => setForm({ ...form, mechanic_id: e.target.value })}>
            <option value="">—</option>{people.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <div className="md:col-span-2 flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 border rounded-lg text-sm">Cancelar</button>
          <button type="submit" disabled={saving} className="px-4 py-2 bg-[#002855] text-white rounded-lg text-sm">{saving ? 'Guardando…' : 'Crear OT'}</button>
        </div>
      </form>
    </Modal>
  )
}

function WorkOrderDetail({ order, providers, people, onClose, onChanged }: {
  order: WorkOrder; providers: Option[]; people: Option[]; onClose: () => void; onChanged: () => void
}) {
  const [costs, setCosts] = useState<CostLine[]>([])
  const [parts, setParts] = useState<SparePart[]>([])
  const [busy, setBusy] = useState(false)
  const [diagnostic, setDiagnostic] = useState(order.diagnostic || '')
  const [tasks, setTasks] = useState(order.tasks || [])
  const [newTask, setNewTask] = useState('')
  const [costForm, setCostForm] = useState({ cost_type: 'MANO_OBRA', amount: '', description: '', document_number: '' })
  const [partForm, setPartForm] = useState({ part_id: '', quantity: '1' })
  const locked = order.status === 'CERRADA' || order.status === 'CANCELADA'

  const loadCosts = useCallback(() => supabase.from('work_order_costs').select('id, cost_type, amount, quantity, description, document_number, created_at')
    .eq('work_order_id', order.id).order('created_at').then(({ data }) => setCosts((data || []) as CostLine[])), [order.id])

  useEffect(() => {
    loadCosts()
    supabase.from('vw_spare_parts_stock').select('id, internal_code, name, current_stock, available').eq('is_active', true).order('name').then(({ data }) => setParts((data || []) as SparePart[]))
  }, [loadCosts])

  const rpc = async (fn: string, args: Record<string, unknown>, okMsg?: string) => {
    setBusy(true)
    const { data, error } = await supabase.rpc(fn, args)
    setBusy(false)
    if (error || (data && data.success === false)) {
      toast.error(error?.message || data?.error || 'Operación rechazada')
      return false
    }
    toast.success(okMsg || data?.message || 'Actualizado')
    onChanged()
    return true
  }

  const transition = (status: WoStatus) => {
    let notes: string | null = null
    if (status === 'CANCELADA') { notes = prompt('Motivo de la cancelación (obligatorio):'); if (!notes?.trim()) return }
    if (status === 'TERMINADA') { notes = prompt('Actividades realizadas (obligatorio):', order.activities_performed || ''); if (!notes?.trim()) return }
    if (status === 'VALIDACION' || status === 'EN_ESPERA') notes = prompt(status === 'EN_ESPERA' ? 'Motivo de la espera (repuesto, proveedor…):' : 'Observaciones de la validación:') || null
    rpc('transition_work_order', { p_work_order_id: order.id, p_new_status: status, p_notes: notes }, `OT ${order.ot_code} → ${status}`)
  }

  const close = () => {
    if (!confirm('¿Cerrar la OT? Se validará la elegibilidad de la unidad antes de liberarla.')) return
    const notes = prompt('Notas de cierre:') || null
    rpc('complete_maintenance_order', { p_order_id: order.id, p_used_parts: [], p_closing_notes: notes })
  }

  const saveTechnical = async () => {
    setBusy(true)
    const { error } = await supabase.from('maintenance_work_orders').update({ diagnostic, tasks }).eq('id', order.id)
    setBusy(false)
    if (error) return toast.error(error.message)
    toast.success('Diagnóstico y tareas guardados'); onChanged()
  }

  const setAssignment = async (field: 'responsible_id' | 'mechanic_id' | 'provider_id', value: string) => {
    const { error } = await supabase.from('maintenance_work_orders').update({ [field]: value || null }).eq('id', order.id)
    if (error) return toast.error(error.message)
    onChanged()
  }

  const addCost = async (e: React.FormEvent) => {
    e.preventDefault()
    const amount = Number(costForm.amount)
    if (!(amount >= 0)) return toast.error('Monto inválido')
    const { error } = await supabase.from('work_order_costs').insert({
      work_order_id: order.id, cost_type: costForm.cost_type, amount,
      description: costForm.description || null, document_number: costForm.document_number || null,
      provider_id: costForm.cost_type === 'SERVICIOS' ? order.provider_id : null,
    })
    if (error) return toast.error(error.message)
    setCostForm({ cost_type: 'MANO_OBRA', amount: '', description: '', document_number: '' })
    loadCosts(); onChanged()
  }

  const removeCost = async (line: CostLine) => {
    if (!confirm('¿Eliminar la línea de costo?')) return
    const { error } = await supabase.from('work_order_costs').delete().eq('id', line.id)
    if (error) return toast.error(error.message)
    loadCosts(); onChanged()
  }

  const consumePart = async (e: React.FormEvent) => {
    e.preventDefault()
    if (await rpc('consume_work_order_part', { p_work_order_id: order.id, p_spare_part_id: partForm.part_id, p_quantity: Number(partForm.quantity), p_notes: null }, 'Repuesto consumido y descontado del stock')) {
      setPartForm({ part_id: '', quantity: '1' }); loadCosts()
    }
  }

  const uploadEvidence = async (file: File) => {
    setBusy(true)
    const path = `ot/${order.id}/${Date.now()}-${file.name.replace(/[^\w.-]/g, '_')}`
    const { error: upErr } = await supabase.storage.from('evidence').upload(path, file, { contentType: file.type })
    if (upErr) { setBusy(false); return toast.error(upErr.message) }
    const url = supabase.storage.from('evidence').getPublicUrl(path).data.publicUrl
    const { error } = await supabase.from('maintenance_work_orders').update({ evidence_urls: [...(order.evidence_urls || []), url] }).eq('id', order.id)
    setBusy(false)
    if (error) return toast.error(error.message)
    toast.success('Evidencia adjuntada'); onChanged()
  }

  const actions: Partial<Record<WoStatus, [WoStatus, string, React.ReactNode][]>> = {
    BORRADOR: [['APROBADA', 'Aprobar', <CheckCircle2 key="a" className="w-4 h-4" />], ['CANCELADA', 'Cancelar', <XCircle key="c" className="w-4 h-4" />]],
    APROBADA: [['PROGRAMADA', 'Programar', <ClipboardList key="p" className="w-4 h-4" />], ['EN_PROCESO', 'Iniciar', <PlayCircle key="i" className="w-4 h-4" />], ['CANCELADA', 'Cancelar', <XCircle key="c" className="w-4 h-4" />]],
    PROGRAMADA: [['EN_PROCESO', 'Iniciar', <PlayCircle key="i" className="w-4 h-4" />], ['CANCELADA', 'Cancelar', <XCircle key="c" className="w-4 h-4" />]],
    EN_PROCESO: [['EN_ESPERA', 'En espera', <PauseCircle key="e" className="w-4 h-4" />], ['TERMINADA', 'Terminar', <Flag key="t" className="w-4 h-4" />]],
    EN_ESPERA: [['EN_PROCESO', 'Reanudar', <PlayCircle key="r" className="w-4 h-4" />], ['CANCELADA', 'Cancelar', <XCircle key="c" className="w-4 h-4" />]],
    TERMINADA: [['VALIDACION', 'Validar', <ShieldCheck key="v" className="w-4 h-4" />], ['EN_PROCESO', 'Reabrir (retrabajo)', <PlayCircle key="r" className="w-4 h-4" />]],
    VALIDACION: [['EN_PROCESO', 'Retrabajo', <PlayCircle key="r" className="w-4 h-4" />]],
  }
  const field = 'border rounded-lg px-2 py-1.5 text-sm'

  return (
    <Modal isOpen onClose={onClose} title={`${order.ot_code} · ${order.vehicle_plate}`} maxWidth="max-w-4xl">
      <div className="space-y-5 text-sm max-h-[75vh] overflow-y-auto pr-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`px-2 py-1 rounded-full text-xs font-semibold ${STATUS_STYLE[order.status]}`}>{order.status.replace('_', ' ')}</span>
          <span className="text-slate-500">{order.order_type} · prioridad {order.priority} · origen {order.source_type || 'MANUAL'}{order.plan_name ? ` · plan ${order.plan_name}` : ''}</span>
          {order.linked_requests > 0 && <span className="text-slate-500">· {order.linked_requests} falla(s) vinculada(s)</span>}
        </div>
        <p className="text-slate-800">{order.description}</p>

        {!locked && (
          <div className="flex flex-wrap gap-2">
            {(actions[order.status] || []).map(([st, label, icon]) => (
              <button key={st} disabled={busy} onClick={() => transition(st)}
                className={`px-3 py-1.5 rounded-lg border text-sm flex items-center gap-1 ${st === 'CANCELADA' ? 'text-red-600 border-red-200' : 'text-slate-700'}`}>
                {icon}{label}
              </button>
            ))}
            {(order.status === 'TERMINADA' || order.status === 'VALIDACION') && (
              <button disabled={busy} onClick={close} className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm flex items-center gap-1">
                <Lock className="w-4 h-4" /> Cerrar OT
              </button>
            )}
          </div>
        )}

        {order.status === 'CERRADA' && order.release_result?.eligibility && (
          <div className={`rounded-lg p-3 text-sm ${order.release_result.eligibility.status === 'NO_APTO' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
            Elegibilidad al cierre: <b>{order.release_result.eligibility.status}</b>
            {order.release_result.eligibility.motives?.length ? ` — ${order.release_result.eligibility.motives.join('; ')}` : ''}
          </div>
        )}
        {order.cancel_reason && <div className="rounded-lg p-3 bg-red-50 text-red-700">Cancelada: {order.cancel_reason}</div>}

        <div className="grid md:grid-cols-4 gap-3">
          <Info label="Inicio indisponibilidad" value={order.downtime_start ? format(new Date(order.downtime_start), 'dd/MM/yyyy HH:mm') : '—'} />
          <Info label="Fin indisponibilidad" value={order.downtime_end ? format(new Date(order.downtime_end), 'dd/MM/yyyy HH:mm') : '—'} />
          <Info label="Horas fuera de servicio" value={order.downtime_hours != null ? Number(order.downtime_hours).toFixed(1) : '—'} />
          <Info label="Aprobada" value={order.approved_at ? format(new Date(order.approved_at), 'dd/MM/yyyy HH:mm') : '—'} />
        </div>

        <div className="grid md:grid-cols-3 gap-3">
          {([['responsible_id', 'Responsable', people, order.responsible_name], ['mechanic_id', 'Mecánico', people, order.mechanic_name], ['provider_id', 'Proveedor', providers, order.provider_name]] as const).map(([key, label, opts, current]) => (
            <label key={key} className="text-xs text-slate-500">{label}
              <select disabled={locked} className={`${field} w-full mt-1`} defaultValue=""
                onChange={e => setAssignment(key, e.target.value)}>
                <option value="">{current || '—'}</option>
                {opts.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </label>
          ))}
        </div>

        <section className="space-y-2">
          <h3 className="font-semibold flex items-center gap-2"><Wrench className="w-4 h-4" />Diagnóstico y tareas</h3>
          <textarea disabled={locked} className={`${field} w-full`} rows={2} value={diagnostic} onChange={e => setDiagnostic(e.target.value)} placeholder="Diagnóstico técnico" />
          <ul className="space-y-1">
            {tasks.map((t, i) => (
              <li key={i} className="flex items-center gap-2">
                <input type="checkbox" disabled={locked} checked={t.done} onChange={() => setTasks(tasks.map((x, j) => j === i ? { ...x, done: !x.done } : x))} />
                <span className={t.done ? 'line-through text-slate-400' : ''}>{t.text}</span>
              </li>
            ))}
          </ul>
          {!locked && (
            <div className="flex gap-2">
              <input className={`${field} flex-1`} value={newTask} onChange={e => setNewTask(e.target.value)} placeholder="Nueva tarea" />
              <button type="button" className="px-3 border rounded-lg" onClick={() => { if (newTask.trim()) { setTasks([...tasks, { text: newTask.trim(), done: false }]); setNewTask('') } }}>Agregar</button>
              <button type="button" disabled={busy} onClick={saveTechnical} className="px-3 bg-[#002855] text-white rounded-lg">Guardar</button>
            </div>
          )}
          {order.activities_performed && <p className="text-slate-600"><b>Actividades:</b> {order.activities_performed}</p>}
        </section>

        <section className="space-y-2">
          <h3 className="font-semibold">Costos</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Info label="Mano de obra" value={money(order.labor_cost)} /><Info label="Repuestos" value={money(order.parts_cost)} />
            <Info label="Servicios" value={money(order.services_cost)} /><Info label="Total" value={money(order.total_cost)} />
          </div>
          <table className="w-full text-xs">
            <tbody className="divide-y">
              {costs.map(c => (
                <tr key={c.id}>
                  <td className="py-1.5">{c.cost_type.replace('_', ' ')}</td>
                  <td className="py-1.5 text-slate-600">{c.description}{c.quantity ? ` (x${c.quantity})` : ''}{c.document_number ? ` · doc ${c.document_number}` : ''}</td>
                  <td className="py-1.5 text-right">{money(c.amount)}</td>
                  <td className="py-1.5 text-right w-8">
                    {!locked && c.cost_type !== 'REPUESTOS' && <button onClick={() => removeCost(c)} className="text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!locked && (
            <>
              <form onSubmit={addCost} className="flex flex-wrap gap-2">
                <select className={field} value={costForm.cost_type} onChange={e => setCostForm({ ...costForm, cost_type: e.target.value })}>
                  <option value="MANO_OBRA">Mano de obra</option><option value="SERVICIOS">Servicio externo</option><option value="OTROS">Otros</option>
                </select>
                <input required type="number" min={0} step="0.01" className={`${field} w-28`} placeholder="Monto" value={costForm.amount} onChange={e => setCostForm({ ...costForm, amount: e.target.value })} />
                <input className={`${field} flex-1 min-w-40`} placeholder="Descripción" value={costForm.description} onChange={e => setCostForm({ ...costForm, description: e.target.value })} />
                <input className={`${field} w-32`} placeholder="N° comprobante" value={costForm.document_number} onChange={e => setCostForm({ ...costForm, document_number: e.target.value })} />
                <button className="px-3 border rounded-lg">Agregar costo</button>
              </form>
              <form onSubmit={consumePart} className="flex flex-wrap gap-2 items-center">
                <Package className="w-4 h-4 text-slate-400" />
                <select required className={`${field} flex-1 min-w-48`} value={partForm.part_id} onChange={e => setPartForm({ ...partForm, part_id: e.target.value })}>
                  <option value="">Repuesto del almacén…</option>
                  {parts.map(p => <option key={p.id} value={p.id}>{p.internal_code} · {p.name} (disp. {p.available ?? 0} / stock {p.current_stock ?? 0})</option>)}
                </select>
                <input required type="number" min={0.01} step="0.01" className={`${field} w-24`} value={partForm.quantity} onChange={e => setPartForm({ ...partForm, quantity: e.target.value })} />
                <button disabled={busy} className="px-3 border rounded-lg">Consumir</button>
                <button type="button" disabled={busy || !partForm.part_id} className="px-3 border rounded-lg"
                  onClick={() => rpc('reserve_work_order_part', { p_work_order_id: order.id, p_spare_part_id: partForm.part_id, p_quantity: Number(partForm.quantity) }, 'Repuesto reservado para esta OT')}>
                  Reservar
                </button>
              </form>
            </>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="font-semibold">Evidencias</h3>
          <div className="flex flex-wrap gap-2">
            {(order.evidence_urls || []).map(url => (
              <a key={url} href={url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 underline break-all">{url.split('/').pop()}</a>
            ))}
            {!order.evidence_urls?.length && <span className="text-slate-400 text-xs">Sin evidencias</span>}
          </div>
          {!locked && (
            <label className="inline-flex items-center gap-2 px-3 py-1.5 border rounded-lg cursor-pointer text-sm">
              <Upload className="w-4 h-4" /> Adjuntar foto/documento
              <input type="file" className="hidden" accept="image/*,application/pdf" onChange={e => e.target.files?.[0] && uploadEvidence(e.target.files[0])} />
            </label>
          )}
        </section>

        {order.notes && (
          <section><h3 className="font-semibold">Bitácora</h3><pre className="whitespace-pre-wrap text-xs text-slate-600 bg-slate-50 rounded-lg p-3">{order.notes}</pre></section>
        )}
      </div>
    </Modal>
  )
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-slate-50 rounded-lg p-2">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="font-semibold text-slate-800">{value}</div>
    </div>
  )
}
