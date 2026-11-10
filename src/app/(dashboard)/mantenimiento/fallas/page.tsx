'use client'

import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { DataTable } from '@/components/ui/data-table'
import { TablePagination } from '@/components/ui/table-pagination'
import { usePagination } from '@/lib/use-pagination'
import { Modal } from '@/components/ui/modal'
import { EvidenceGallery, type EvidenceItem } from '@/components/evidence/EvidenceGallery'
import { createClient } from '@/lib/supabase/client'
import { format } from 'date-fns'
import { AlertTriangle, ArrowRight, CalendarClock, CheckCircle2, Clock3, Hand, Loader2, Plus, RefreshCw, Search, ShieldAlert, Stethoscope, Wrench, XCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

const supabase = createClient()
type Severity = 'CRITICA' | 'ALTA' | 'MEDIA' | 'BAJA'
type RequestStatus = 'REPORTADA' | 'VALIDADA' | 'DIAGNOSTICADA' | 'PROGRAMADA' | 'CONVERTIDA_OT'
type Tab = 'resumen' | 'evaluacion' | 'evidencias' | 'accion' | 'historial'

interface BacklogItem {
  id: string; incident_code: string; vehicle_plate: string; vehicle_type: string | null; vehicle_status: string | null
  description: string; severity: Severity; status: RequestStatus; source: string; reported_at: string
  odometer_at_report: number | null; driver_name: string | null; responsible_id: string | null; responsible_name: string | null
  diagnosis: string | null; affected_system: string | null; affected_component: string | null
  technical_assessment: string | null; recommended_action: string | null; scheduled_for: string | null
  work_order_id: string | null; work_order_code: string | null; work_order_status: string | null
  age_days: number; age_bucket: string; impact: string; priority_score: number; photo_url?: string | null
}
interface RequestEvent { id: number; evento: string; estado_anterior: string | null; estado_nuevo: string | null; at: string; by: string | null; detalle: string | null; metadata: Record<string, unknown> | null }
interface Person { id: string; first_name: string | null; last_name: string | null }

const statuses: RequestStatus[] = ['REPORTADA', 'VALIDADA', 'DIAGNOSTICADA', 'PROGRAMADA', 'CONVERTIDA_OT']
const severities: Severity[] = ['CRITICA', 'ALTA', 'MEDIA', 'BAJA']
const sources: Record<string, string> = { APP_CONDUCTOR: 'App conductor', SUPERVISOR: 'Supervisor', INSPECCION: 'Inspección', MANTENIMIENTO: 'Mantenimiento', COPILOTO_AI: 'Copiloto IA', TORRE_CONTROL: 'Torre de Control' }
const severityStyle: Record<Severity, string> = { CRITICA: 'bg-red-100 text-red-700', ALTA: 'bg-orange-100 text-orange-700', MEDIA: 'bg-amber-100 text-amber-800', BAJA: 'bg-sky-100 text-sky-700' }
const statusStyle: Record<RequestStatus, string> = { REPORTADA: 'bg-rose-50 text-rose-700', VALIDADA: 'bg-sky-50 text-sky-700', DIAGNOSTICADA: 'bg-violet-50 text-violet-700', PROGRAMADA: 'bg-amber-50 text-amber-800', CONVERTIDA_OT: 'bg-emerald-50 text-emerald-700' }
const field = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-100'
const label = 'mb-1 block text-xs font-medium text-slate-600'

function safeDate(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : format(date, 'dd/MM/yyyy HH:mm')
}

async function loadEvidence(requestId: string): Promise<EvidenceItem[]> {
  const { data, error } = await supabase.from('maintenance_requests').select('photo_url, audio_url, evidence').eq('id', requestId).maybeSingle()
  if (error || !data) return []
  const row = data as { photo_url?: string | null; audio_url?: string | null; evidence?: unknown }
  const extra = Array.isArray(row.evidence) ? row.evidence.filter((path): path is string => typeof path === 'string') : []
  return [row.photo_url, row.audio_url, ...extra].filter((path): path is string => Boolean(path)).map((path, index) => ({ kind: index === 1 ? 'AUDIO' : 'FALLA', label: index === 1 ? 'Audio del reporte' : 'Evidencia de la falla', path }))
}

export default function FallasBacklogPage() {
  const [items, setItems] = useState<BacklogItem[]>([])
  const [plates, setPlates] = useState<string[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [severityFilter, setSeverityFilter] = useState('TODAS')
  const [statusFilter, setStatusFilter] = useState('TODOS')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('resumen')
  const [events, setEvents] = useState<RequestEvent[]>([])
  const [evidence, setEvidence] = useState<EvidenceItem[]>([])
  const [newOpen, setNewOpen] = useState(false)
  const [form, setForm] = useState({ vehicle_plate: '', description: '', severity: 'MEDIA' as Severity, affected_system: '', affected_component: '', odometer: '' })
  const [evaluation, setEvaluation] = useState({ affected_system: '', affected_component: '', technical_assessment: '', diagnosis: '', recommended_action: '', severity: 'MEDIA' as Severity })
  const evaluationId = useRef<string | null>(null)
  const [actionForm, setActionForm] = useState({ note: '', scheduled_for: '', responsible_id: '' })
  const [discarding, setDiscarding] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.from('vw_maintenance_backlog').select('*').order('priority_score', { ascending: false }).order('reported_at', { ascending: true })
    if (error) toast.error(`No se pudo cargar el backlog: ${error.message}`)
    else setItems((data || []) as BacklogItem[])
    setLoading(false)
  }, [])

  useEffect(() => {
    void Promise.resolve().then(refresh)
    supabase.from('vehicles').select('plate').order('plate').then(({ data, error }) => {
      if (error) toast.error(`No se pudo cargar el maestro de unidades: ${error.message}`)
      else setPlates((data || []).map((row: { plate: string }) => row.plate))
    })
    supabase.from('profiles').select('id, first_name, last_name').eq('is_active', true).order('first_name')
      .then(({ data }) => setPeople((data || []) as Person[]))
  }, [refresh])

  const filtered = useMemo(() => items.filter(item =>
    (severityFilter === 'TODAS' || item.severity === severityFilter) &&
    (statusFilter === 'TODOS' || item.status === statusFilter) &&
    (!search || `${item.incident_code} ${item.vehicle_plate} ${item.description} ${item.affected_system || ''} ${item.affected_component || ''} ${item.responsible_name || ''} ${item.work_order_code || ''}`.toLowerCase().includes(search.toLowerCase()))
  ), [items, search, severityFilter, statusFilter])

  const pg = usePagination(filtered, 'mantenimiento-fallas')
  const visible = pg.pageRows
  const openItem = items.find(item => item.id === selectedId) || null
  const openCount = items.length
  const kpis = useMemo(() => ({
    unevaluated: items.filter(item => item.status === 'REPORTADA').length,
    critical: items.filter(item => item.severity === 'CRITICA').length,
    overdue: items.filter(item => item.age_days > 7 && item.status !== 'CONVERTIDA_OT').length,
    inFollowup: items.filter(item => ['DIAGNOSTICADA', 'PROGRAMADA'].includes(item.status)).length,
    immobilized: items.filter(item => item.vehicle_status === 'BLOQUEADA' || item.vehicle_status === 'FUERA_DE_SERVICIO').length,
  }), [items])
  const groupable = filtered.filter(item => item.status !== 'CONVERTIDA_OT')
  const selectedForGroup = groupable.filter(item => selectedIds.includes(item.id))

  useEffect(() => {
    if (!openItem) return
    supabase.from('maintenance_request_events').select('id, evento, estado_anterior, estado_nuevo, at, by, detalle, metadata').eq('request_id', openItem.id).order('at', { ascending: false })
      .then(({ data, error }) => { if (error) toast.error(`No se pudo cargar el historial: ${error.message}`); else setEvents((data || []) as RequestEvent[]) })
    void loadEvidence(openItem.id).then(setEvidence)
  }, [openItem, openItem?.id])

  const setModal = (id: string) => {
    const item = items.find(row => row.id === id)
    if (item && evaluationId.current !== id) {
      setEvaluation({ affected_system: item.affected_system || '', affected_component: item.affected_component || '', technical_assessment: item.technical_assessment || '', diagnosis: item.diagnosis || '', recommended_action: item.recommended_action || '', severity: item.severity })
      setActionForm({ note: '', scheduled_for: item.scheduled_for || '', responsible_id: item.responsible_id || '' })
      setDiscarding(false)
      evaluationId.current = id
    }
    setSelectedId(id); setTab('resumen')
  }
  const closeModal = () => { setSelectedId(null); setDiscarding(false) }

  const saveEvaluation = async () => {
    if (!openItem) return
    if (!evaluation.affected_system.trim()) return toast.error('Indique el sistema afectado')
    setBusy(openItem.id)
    const { error } = await supabase.from('maintenance_requests').update({
      affected_system: evaluation.affected_system.trim(), affected_component: evaluation.affected_component.trim() || null,
      technical_assessment: evaluation.technical_assessment.trim() || null,
      recommended_action: evaluation.recommended_action.trim() || null, severity: evaluation.severity,
    }).eq('id', openItem.id)
    setBusy(null)
    if (error) return toast.error(`No se pudo guardar la evaluación: ${error.message}`)
    const { error: diagnosisError } = await supabase.from('maintenance_requests').update({ diagnosis: evaluation.diagnosis.trim() || null }).eq('id', openItem.id)
    if (diagnosisError) return toast.error(`No se pudo guardar el diagnóstico: ${diagnosisError.message}`)
    toast.success('Evaluación técnica guardada en el historial')
    await refresh()
  }

  const runTransition = async (item: BacklogItem, next: string) => {
    if (next === 'DESCARTADA' && !actionForm.note.trim()) return toast.error('Indique el sustento del descarte')
    if (next === 'DIAGNOSTICADA' && !evaluation.diagnosis.trim()) return toast.error('Complete el diagnóstico técnico antes de avanzar')
    if (next === 'DIAGNOSTICADA') {
      const { error: diagnosisError } = await supabase.from('maintenance_requests').update({ diagnosis: evaluation.diagnosis.trim() }).eq('id', item.id)
      if (diagnosisError) return toast.error(`No se pudo guardar el diagnóstico: ${diagnosisError.message}`)
    }
    if (next === 'PROGRAMADA' && !actionForm.scheduled_for) return toast.error('Seleccione la fecha de programación')
    setBusy(item.id)
    const { data, error } = await supabase.rpc('transition_maintenance_request', {
      p_request_id: item.id, p_new_status: next,
      p_notes: next === 'DIAGNOSTICADA' ? evaluation.diagnosis.trim() : (next === 'DESCARTADA' ? actionForm.note.trim() : actionForm.note.trim() || null),
      p_responsible_id: actionForm.responsible_id || null,
      p_scheduled_for: next === 'PROGRAMADA' ? actionForm.scheduled_for : null,
    })
    setBusy(null)
    if (error || !data?.success) return toast.error(error?.message || data?.error || 'No se pudo actualizar la falla')
    toast.success(`${item.incident_code}: ${data.previous_status} → ${next}`)
    setDiscarding(false)
    await refresh()
  }

  const takeItem = async (item: BacklogItem) => {
    setBusy(item.id)
    const { data, error } = await supabase.rpc('soporte_tomar_falla', { p_request_id: item.id, p_usuario: null, p_nota: actionForm.note.trim() || null })
    setBusy(null)
    if (error || !data?.success) return toast.error(error?.message || data?.error || 'No se pudo tomar la falla')
    toast.success(`${item.incident_code}: asignada a usted`)
    await refresh()
  }

  const createWorkOrder = async (ids: string[]) => {
    if (!ids.length) return
    setBusy('group')
    const { data: auth } = await supabase.auth.getUser()
    const { data, error } = await supabase.rpc('create_work_order_from_requests', { p_request_ids: ids, p_user_id: auth.user?.id ?? null })
    setBusy(null)
    if (error) return toast.error(`No se pudo crear la OT: ${error.message}`)
    const id = typeof data === 'string' ? data : (data as { create_work_order_from_requests?: string })?.create_work_order_from_requests
    toast.success(`OT ${id ? id.slice(0, 8) : ''} creada y vinculada a ${ids.length} falla(s)`)
    setSelectedIds([])
    if (ids.includes(selectedId || '')) closeModal()
    await refresh()
  }

  const createRequest = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!form.vehicle_plate || !form.description.trim() || !form.affected_system.trim()) return toast.error('Complete la unidad, sistema afectado y descripción')
    setBusy('new')
    const { error } = await supabase.from('maintenance_requests').insert({
      vehicle_plate: form.vehicle_plate, description: form.description.trim(), severity: form.severity,
      source: 'SUPERVISOR', affected_system: form.affected_system.trim(), affected_component: form.affected_component.trim() || null,
      odometer_at_report: form.odometer ? Number(form.odometer) : null,
    })
    setBusy(null)
    if (error) return toast.error(error.code === '23505' ? 'Esta falla ya fue registrada hoy para la unidad.' : error.message)
    toast.success(form.severity === 'CRITICA' ? 'Falla crítica registrada y unidad bloqueada por el control de elegibilidad.' : 'Falla agregada al backlog')
    setForm({ vehicle_plate: '', description: '', severity: 'MEDIA', affected_system: '', affected_component: '', odometer: '' })
    setNewOpen(false)
    await refresh()
  }

  const toggleSelected = (id: string) => setSelectedIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])
  const togglePage = () => {
    const ids = visible.filter(item => item.status !== 'CONVERTIDA_OT').map(item => item.id)
    setSelectedIds(current => ids.every(id => current.includes(id)) ? current.filter(id => !ids.includes(id)) : [...new Set([...current, ...ids])])
  }

  return <div className="container mx-auto space-y-4">
    <PageHeader showTitle title="Fallas y Backlog" description="Gestión trazable desde el reporte hasta la OT y su cierre." actions={<div className="flex gap-2">
      <Button variant="outline" onClick={() => void refresh()} disabled={loading}><RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</Button>
      <Button onClick={() => setNewOpen(true)}><Plus className="mr-2 h-4 w-4" />Registrar falla</Button>
    </div>} />

    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {([
        ['Fallas abiertas', openCount, Wrench, 'text-slate-900'],
        ['Sin evaluar', kpis.unevaluated, Clock3, 'text-amber-700'],
        ['Críticas', kpis.critical, ShieldAlert, 'text-red-700'],
        ['Vencidas · más de 7 días', kpis.overdue, AlertTriangle, 'text-orange-700'],
        ['Unidades inmovilizadas', kpis.immobilized, Wrench, 'text-red-700'],
      ] as [string, number, typeof Wrench, string][]).map(([title, value, Icon, color]) => <Card key={title}><CardContent className="flex items-center gap-3 p-4">
        <div className="rounded-lg bg-slate-100 p-2"><Icon className={`h-5 w-5 ${color}`} /></div>
        <div><div className="text-xs text-slate-500">{title}</div><div className={`text-2xl font-semibold ${color}`}>{value}</div></div>
      </CardContent></Card>)}
    </div>

    <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-white p-3">
      <div className="relative min-w-60 flex-1"><Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" /><input className={`${field} pl-9`} placeholder="Buscar código, placa, descripción, sistema, responsable u OT" value={search} onChange={e => setSearch(e.target.value)} /></div>
      <select className={`${field} w-auto min-w-40`} value={severityFilter} onChange={e => setSeverityFilter(e.target.value)}><option value="TODAS">Todas las criticidades</option>{severities.map(value => <option key={value}>{value}</option>)}</select>
      <select className={`${field} w-auto min-w-44`} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="TODOS">Todos los estados</option>{statuses.map(value => <option key={value}>{value}</option>)}</select>
      <span className="text-xs text-slate-500">{filtered.length} resultado(s)</span>
    </div>

    {selectedForGroup.length > 0 && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3">
      <div className="text-sm text-blue-900"><b>{selectedForGroup.length}</b> fallas seleccionadas · deben pertenecer a la misma unidad para agruparse en una OT.</div>
      <Button onClick={() => void createWorkOrder(selectedForGroup.map(item => item.id))} disabled={busy === 'group'}><ArrowRight className="mr-2 h-4 w-4" />Crear OT agrupada</Button>
    </div>}

    <div className="overflow-hidden rounded-xl border bg-white">
      {loading ? <div className="flex justify-center py-14"><Loader2 className="h-7 w-7 animate-spin text-slate-400" /></div> : filtered.length === 0 ? <div className="py-14 text-center text-sm text-slate-500">No hay fallas con estos filtros.</div> : <>
        <div className="overflow-x-auto">
          <DataTable className="w-full min-w-[1160px] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr>
              <th className="w-10 p-3"><input aria-label="Seleccionar fallas de esta página" type="checkbox" checked={visible.filter(item => item.status !== 'CONVERTIDA_OT').length > 0 && visible.filter(item => item.status !== 'CONVERTIDA_OT').every(item => selectedIds.includes(item.id))} onChange={togglePage} /></th>
              <th className="p-3">Código / fecha</th><th className="p-3">Unidad</th><th className="p-3">Origen</th><th className="p-3">Sistema afectado</th><th className="p-3">Descripción</th><th className="p-3">Criticidad</th><th className="p-3">Estado</th><th className="p-3">Responsable</th><th className="p-3">Antigüedad</th><th className="p-3">Acción</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {visible.map(item => <tr key={item.id} className="hover:bg-slate-50/80">
                <td className="p-3"><input aria-label={`Seleccionar ${item.incident_code}`} type="checkbox" disabled={item.status === 'CONVERTIDA_OT'} checked={selectedIds.includes(item.id)} onChange={() => toggleSelected(item.id)} /></td>
                <td className="p-3"><button className="font-semibold text-blue-900 hover:underline" onClick={() => setModal(item.id)}>{item.incident_code || item.id.slice(0, 10)}</button><div className="mt-0.5 text-xs text-slate-500">{safeDate(item.reported_at)}</div></td>
                <td className="p-3"><div className="font-medium">{item.vehicle_plate}</div><div className="text-xs text-slate-500">{item.vehicle_type || 'Unidad'} · {item.vehicle_status?.replace(/_/g, ' ') || '—'}</div></td>
                <td className="p-3 text-slate-600">{sources[item.source] || item.source}</td>
                <td className="p-3"><div>{item.affected_system || 'Sin clasificar'}</div><div className="text-xs text-slate-500">{item.affected_component || '—'}</div></td>
                <td className="max-w-[260px] p-3"><div className="line-clamp-2" title={item.description}>{item.description}</div>{item.work_order_code && <div className="mt-1 text-xs text-blue-700">OT {item.work_order_code}</div>}</td>
                <td className="p-3"><Badge className={severityStyle[item.severity]}>{item.severity}</Badge></td>
                <td className="p-3"><Badge className={statusStyle[item.status]}>{item.status.replace(/_/g, ' ')}</Badge></td>
                <td className="p-3 text-slate-600">{item.responsible_name || 'Sin asignar'}</td>
                <td className="p-3"><span className={item.age_days > 7 ? 'font-semibold text-orange-700' : 'text-slate-600'}>{item.age_days} d</span><div className="text-xs text-slate-400">{item.age_bucket}</div></td>
                <td className="p-3"><Button size="sm" variant="outline" onClick={() => setModal(item.id)}>Gestionar</Button></td>
              </tr>)}
            </tbody>
          </DataTable>
        </div>
        <TablePagination total={pg.total} page={pg.page} pageSize={pg.pageSize} onPageChange={pg.setPage} onPageSizeChange={pg.setPageSize} itemLabel="fallas" compact />
      </>}
    </div>

    <Modal isOpen={newOpen} onClose={() => setNewOpen(false)} title="Registrar falla" maxWidth="max-w-2xl">
      <form onSubmit={createRequest} className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <label><span className={label}>Unidad *</span><select required className={field} value={form.vehicle_plate} onChange={e => setForm({ ...form, vehicle_plate: e.target.value })}><option value="">Seleccione una unidad</option>{plates.map(plate => <option key={plate}>{plate}</option>)}</select></label>
          <label><span className={label}>Criticidad *</span><select className={field} value={form.severity} onChange={e => setForm({ ...form, severity: e.target.value as Severity })}>{severities.map(value => <option key={value}>{value}</option>)}</select></label>
          <label><span className={label}>Sistema afectado *</span><input required className={field} placeholder="Ej. frenos, motor, sistema eléctrico" value={form.affected_system} onChange={e => setForm({ ...form, affected_system: e.target.value })} /></label>
          <label><span className={label}>Componente</span><input className={field} placeholder="Ej. pastillas, alternador" value={form.affected_component} onChange={e => setForm({ ...form, affected_component: e.target.value })} /></label>
          <label className="md:col-span-2"><span className={label}>Descripción *</span><textarea required rows={3} className={field} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></label>
          <label><span className={label}>Odómetro (km)</span><input type="number" min={0} step="0.1" className={field} value={form.odometer} onChange={e => setForm({ ...form, odometer: e.target.value })} /></label>
        </div>
        {form.severity === 'CRITICA' && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"><ShieldAlert className="mr-2 inline h-4 w-4" />Una falla crítica activa el bloqueo por el motor de elegibilidad.</div>}
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setNewOpen(false)}>Cancelar</Button><Button type="submit" disabled={busy === 'new'}>{busy === 'new' ? 'Guardando…' : 'Registrar falla'}</Button></div>
      </form>
    </Modal>

    {openItem && <Modal isOpen onClose={closeModal} title={`${openItem.incident_code || 'Falla'} · ${openItem.vehicle_plate}`} maxWidth="max-w-5xl">
      <div className="max-h-[78vh] space-y-4 overflow-y-auto pr-1">
        <div className="flex flex-wrap items-center gap-2"><Badge className={severityStyle[openItem.severity]}>{openItem.severity}</Badge><Badge className={statusStyle[openItem.status]}>{openItem.status.replace(/_/g, ' ')}</Badge><span className="text-xs text-slate-500">Reportada {safeDate(openItem.reported_at)} · {sources[openItem.source] || openItem.source}</span>
          {openItem.impact === 'BLOQUEA_ACTIVO' && <span className="rounded-full bg-red-50 px-2 py-1 text-xs font-medium text-red-700">Unidad {openItem.vehicle_status}</span>}
          {openItem.work_order_code && <span className="rounded-full bg-blue-50 px-2 py-1 text-xs text-blue-800">OT {openItem.work_order_code} · {openItem.work_order_status}</span>}
        </div>
        <div className="flex flex-wrap gap-1 border-b">
          {([['resumen', 'Resumen'], ['evaluacion', 'Evaluación técnica'], ['evidencias', 'Evidencias'], ['accion', 'Plan de acción'], ['historial', 'Historial']] as [Tab, string][]).map(([key, text]) => <button key={key} onClick={() => setTab(key)} className={`border-b-2 px-3 py-2 text-sm ${tab === key ? 'border-blue-800 font-semibold text-blue-900' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{text}{key === 'historial' ? ` (${events.length})` : ''}</button>)}
        </div>

        {tab === 'resumen' && <div className="grid gap-4 md:grid-cols-3">
          <section className="space-y-3 rounded-xl border p-4 md:col-span-2"><h3 className="font-semibold">Descripción reportada</h3><p className="whitespace-pre-wrap text-sm text-slate-700">{openItem.description}</p><div className="grid gap-3 sm:grid-cols-2"><Info label="Sistema" value={openItem.affected_system || 'Pendiente de clasificar'} /><Info label="Componente" value={openItem.affected_component || '—'} /><Info label="Odómetro al reportar" value={openItem.odometer_at_report == null ? '—' : `${Number(openItem.odometer_at_report).toLocaleString('es-PE')} km`} /><Info label="Conductor" value={openItem.driver_name || '—'} /></div></section>
          <section className="space-y-3 rounded-xl border p-4"><h3 className="font-semibold">Seguimiento</h3><Info label="Responsable" value={openItem.responsible_name || 'Sin asignar'} /><Info label="Prioridad calculada" value={openItem.priority_score} /><Info label="Antigüedad" value={`${openItem.age_days} días · ${openItem.age_bucket}`} />{openItem.scheduled_for && <Info label="Programada" value={openItem.scheduled_for} />}</section>
          {openItem.diagnosis && <section className="rounded-xl border p-4 md:col-span-3"><h3 className="mb-2 font-semibold">Diagnóstico</h3><p className="whitespace-pre-wrap text-sm text-slate-700">{openItem.diagnosis}</p></section>}
        </div>}

        {tab === 'evaluacion' && <div className="space-y-4">
          <p className="text-sm text-slate-500">Los cambios quedan en el historial de la falla. La criticidad define impacto operativo; el estado avanza por la transición controlada.</p>
          <div className="grid gap-3 md:grid-cols-2">
            <label><span className={label}>Sistema afectado *</span><input className={field} value={evaluation.affected_system} onChange={e => setEvaluation({ ...evaluation, affected_system: e.target.value })} /></label>
            <label><span className={label}>Componente</span><input className={field} value={evaluation.affected_component} onChange={e => setEvaluation({ ...evaluation, affected_component: e.target.value })} /></label>
            <label><span className={label}>Criticidad</span><select className={field} value={evaluation.severity} onChange={e => setEvaluation({ ...evaluation, severity: e.target.value as Severity })}>{severities.map(value => <option key={value}>{value}</option>)}</select></label>
            <label><span className={label}>Diagnóstico definitivo / preliminar</span><textarea rows={3} className={field} value={evaluation.diagnosis} onChange={e => setEvaluation({ ...evaluation, diagnosis: e.target.value })} /></label>
            <label><span className={label}>Evaluación técnica preliminar</span><textarea rows={3} className={field} value={evaluation.technical_assessment} onChange={e => setEvaluation({ ...evaluation, technical_assessment: e.target.value })} /></label>
            <label><span className={label}>Acción recomendada</span><textarea rows={3} className={field} value={evaluation.recommended_action} onChange={e => setEvaluation({ ...evaluation, recommended_action: e.target.value })} /></label>
          </div>
          <div className="flex justify-end"><Button onClick={() => void saveEvaluation()} disabled={busy === openItem.id}>{busy === openItem.id ? 'Guardando…' : 'Guardar evaluación'}</Button></div>
        </div>}

        {tab === 'evidencias' && <div className="space-y-3"><h3 className="font-semibold">Evidencia recibida</h3>{evidence.length ? <EvidenceGallery items={evidence} title="Fotos y archivos del reporte" /> : <div className="rounded-lg border border-dashed p-8 text-center text-sm text-slate-500">Esta falla no tiene archivos adjuntos.</div>}</div>}

        {tab === 'accion' && <div className="space-y-4">
          {openItem.status === 'CONVERTIDA_OT' ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">Esta falla ya forma parte de la OT <b>{openItem.work_order_code}</b>. La ejecución y el cierre se administran desde el Gestor de OT.</div> : <>
            <div className="grid gap-3 md:grid-cols-2">
              <label><span className={label}>Responsable</span><select className={field} value={actionForm.responsible_id} onChange={e => setActionForm({ ...actionForm, responsible_id: e.target.value })}><option value="">Mantener responsable actual</option>{people.map(person => <option key={person.id} value={person.id}>{`${person.first_name || ''} ${person.last_name || ''}`.trim() || person.id.slice(0, 8)}</option>)}</select></label>
              <label><span className={label}>Fecha prevista</span><input type="date" className={field} value={actionForm.scheduled_for} onChange={e => setActionForm({ ...actionForm, scheduled_for: e.target.value })} /></label>
              <label className="md:col-span-2"><span className={label}>Nota de seguimiento / sustento</span><textarea rows={2} className={field} value={actionForm.note} onChange={e => setActionForm({ ...actionForm, note: e.target.value })} /></label>
            </div>
            <div className="flex flex-wrap gap-2 border-t pt-4">
              {!openItem.responsible_name && <Button variant="outline" onClick={() => void takeItem(openItem)} disabled={busy === openItem.id}><Hand className="mr-2 h-4 w-4" />Tomar caso</Button>}
              {openItem.status === 'REPORTADA' && <Button variant="outline" onClick={() => void runTransition(openItem, 'VALIDADA')} disabled={busy === openItem.id}><CheckCircle2 className="mr-2 h-4 w-4" />Validar</Button>}
              {['REPORTADA', 'VALIDADA', 'PROGRAMADA'].includes(openItem.status) && <Button variant="outline" onClick={() => { setTab('evaluacion'); if (!evaluation.diagnosis) toast.info('Registre el diagnóstico en Evaluación técnica antes de avanzar.') }}><Stethoscope className="mr-2 h-4 w-4" />Completar diagnóstico</Button>}
              {['REPORTADA', 'VALIDADA', 'DIAGNOSTICADA'].includes(openItem.status) && <Button variant="outline" onClick={() => void runTransition(openItem, 'PROGRAMADA')} disabled={busy === openItem.id}><CalendarClock className="mr-2 h-4 w-4" />Programar</Button>}
              <Button onClick={() => void createWorkOrder([openItem.id])} disabled={busy === openItem.id}><ArrowRight className="mr-2 h-4 w-4" />Crear OT</Button>
              {!discarding ? <Button variant="outline" className="text-red-700" onClick={() => setDiscarding(true)}><XCircle className="mr-2 h-4 w-4" />Descartar con sustento</Button> : <div className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3"><span className="text-sm text-red-800">Confirmar descarte. El motivo es obligatorio.</span><Button size="sm" variant="destructive" onClick={() => void runTransition(openItem, 'DESCARTADA')} disabled={busy === openItem.id || !actionForm.note.trim()}>Confirmar descarte</Button><Button size="sm" variant="outline" onClick={() => setDiscarding(false)}>Volver</Button></div>}
            </div>
          </>}
        </div>}

        {tab === 'historial' && <div className="space-y-3">
          {events.length === 0 ? <div className="rounded-lg border border-dashed p-8 text-center text-sm text-slate-500">Sin movimientos registrados.</div> : <ol className="relative ml-2 space-y-4 border-l border-slate-200 pl-5">{events.map(event => <li key={event.id} className="relative"><span className="absolute -left-[27px] top-1 h-3 w-3 rounded-full border-2 border-white bg-blue-700" /><div className="flex flex-wrap items-center justify-between gap-2"><b className="text-sm">{event.evento.replace(/_/g, ' ')}</b><time className="text-xs text-slate-500">{safeDate(event.at)}</time></div><div className="text-xs text-slate-600">{event.estado_anterior && event.estado_nuevo ? `${event.estado_anterior.replace(/_/g, ' ')} → ${event.estado_nuevo.replace(/_/g, ' ')}` : event.detalle || 'Actualización registrada'}</div>{event.metadata && Object.keys(event.metadata).length > 0 && <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-[11px] text-slate-500">{JSON.stringify(event.metadata, null, 2)}</pre>}</li>)}</ol>}
        </div>}
      </div>
    </Modal>}
  </div>
}

function Info({ label: title, value }: { label: string; value: React.ReactNode }) {
  return <div className="rounded-lg bg-slate-50 p-3"><div className="text-[11px] text-slate-500">{title}</div><div className="mt-1 text-sm font-medium text-slate-800">{value}</div></div>
}
