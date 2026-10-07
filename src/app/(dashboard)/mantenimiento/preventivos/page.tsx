"use client"
import { DataTable } from '@/components/ui/data-table'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/modal'
import { PlanesPorActivarAviso } from '@/components/mantenimiento/HistorialResumen'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { AlertTriangle, CalendarClock, Gauge, Loader2, Play, Plus, RefreshCw, Trash2, Edit2, Wrench } from 'lucide-react'

// Planificación preventiva (Fase 5). Vencimientos, alertas y proyección se calculan en la BD
// (vw_maintenance_projections); el programador corre por pg_cron (migración 20260927160000).

const supabase = createClient()

type Alert = 'VENCIDO' | 'URGENTE' | 'PRÓXIMO' | 'NORMAL'
interface Projection {
  plan_id: string; vehicle_plate: string; vehicle_type: string; plan_name: string
  frequency_km: number | null; frequency_days: number | null; frequency_hours: number | null
  next_due_km: number | null; next_due_date: string | null; next_due_hours: number | null
  km_remaining: number | null; days_remaining: number | null; hours_remaining: number | null
  avg_daily_km: number | null; projected_due_date: string | null; projected_days: number | null
  projection_bucket: string; alert_status: Alert; due_driver: string
  open_work_order_id: string | null; open_work_order_code: string | null; open_work_order_status: string | null
}
interface Plan {
  id: string; name: string; vehicle_plate: string | null; activity_description: string | null
  frequency_km: number | null; frequency_days: number | null; frequency_hours: number | null
  last_performed_km: number | null; last_performed_date: string | null; last_performed_hours: number | null
  standard_tasks: { description?: string; text?: string }[] | null; expected_parts: { part_id: string; quantity: number }[] | null
  is_active: boolean
}
interface Run { id: string; run_at: string; triggered_by: string; evaluated: number; generated: number }

const ALERT_STYLE: Record<Alert, string> = {
  VENCIDO: 'bg-red-100 text-red-700', URGENTE: 'bg-orange-100 text-orange-700',
  'PRÓXIMO': 'bg-amber-100 text-amber-700', NORMAL: 'bg-emerald-100 text-emerald-700',
}
const TABS = [['proyeccion', 'Proyección'], ['calendario', 'Calendario 90 días'], ['planes', 'Planes'], ['lecturas', 'Lecturas'], ['programador', 'Programador']] as const
const n = (v: number | null | undefined, unit = '') => v == null ? '—' : `${Number(v).toLocaleString('es-PE')}${unit}`

function loadAll() {
  return Promise.all([
    supabase.from('vw_maintenance_projections').select('*').order('projected_days', { ascending: true, nullsFirst: false }),
    supabase.from('maintenance_plans').select('*').order('created_at', { ascending: false }),
    supabase.from('vehicles').select('plate, type, current_odometer, current_hours').order('plate'),
    supabase.from('spare_parts').select('id, internal_code, name').order('name'),
    supabase.from('preventive_scheduler_runs').select('id, run_at, triggered_by, evaluated, generated').order('run_at', { ascending: false }).limit(15),
  ])
}

export default function PreventivosPage() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('proyeccion')
  const [projections, setProjections] = useState<Projection[]>([])
  const [plans, setPlans] = useState<Plan[]>([])
  const [vehicles, setVehicles] = useState<{ plate: string; type: string; current_odometer: number | null; current_hours: number | null }[]>([])
  const [parts, setParts] = useState<{ id: string; internal_code: string; name: string }[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(true)
  const [alertFilter, setAlertFilter] = useState<string>('TODAS')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Plan | 'new' | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const apply = useCallback((res: Awaited<ReturnType<typeof loadAll>>) => {
    const [pr, pl, ve, sp, ru] = res
    const err = pr.error || pl.error || ve.error
    if (err) toast.error('Error al cargar: ' + err.message)
    setProjections((pr.data || []) as Projection[])
    setPlans((pl.data || []) as Plan[])
    setVehicles(ve.data || [])
    setParts(sp.data || [])
    setRuns((ru.data || []) as Run[])
    setLoading(false)
  }, [])
  const refresh = useCallback(() => { setLoading(true); return loadAll().then(apply) }, [apply])
  useEffect(() => { loadAll().then(apply) }, [apply])

  const filtered = useMemo(() => projections.filter(p =>
    (alertFilter === 'TODAS' || p.alert_status === alertFilter || p.projection_bucket === alertFilter) &&
    (!search || `${p.vehicle_plate} ${p.plan_name}`.toLowerCase().includes(search.toLowerCase()))), [projections, alertFilter, search])

  const counts = useMemo(() => ({
    VENCIDO: projections.filter(p => p.alert_status === 'VENCIDO').length,
    URGENTE: projections.filter(p => p.alert_status === 'URGENTE').length,
    'PRÓXIMO': projections.filter(p => p.alert_status === 'PRÓXIMO').length,
    NORMAL: projections.filter(p => p.alert_status === 'NORMAL').length,
    d30: projections.filter(p => p.projection_bucket === '30').length,
    d60: projections.filter(p => p.projection_bucket === '60').length,
    d90: projections.filter(p => p.projection_bucket === '90').length,
  }), [projections])

  const generate = async (p: Projection) => {
    setBusy(p.plan_id)
    const { error } = await supabase.rpc('generate_preventive_wo', { p_plan_id: p.plan_id })
    setBusy(null)
    if (error) return toast.error(error.message)
    toast.success(`OT preventiva lista para ${p.vehicle_plate}. Gestiónela en el Gestor de OT.`)
    refresh()
  }

  const runScheduler = async () => {
    setBusy('scheduler')
    const { data, error } = await supabase.rpc('run_preventive_scheduler', { p_triggered_by: 'MANUAL' })
    setBusy(null)
    if (error) return toast.error(error.message)
    toast.success(`Programador: ${data.evaluated} planes evaluados, ${data.generated} OT generadas`)
    refresh()
  }

  const calendar = useMemo(() => {
    const groups = new Map<string, Projection[]>()
    projections.filter(p => p.projected_due_date && (p.projected_days ?? 999) <= 90).forEach(p => {
      const key = format(new Date(`${p.projected_due_date}T12:00:00`), 'yyyy-MM')
      groups.set(key, [...(groups.get(key) || []), p])
    })
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [projections])

  return (
    <div className="p-6 space-y-5">
      <PlanesPorActivarAviso />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Planificación preventiva</h1>
          <p className="text-sm text-slate-500">Planes por kilometraje, horómetro, fecha o combinación; vence lo primero que ocurra. Proyección según uso real.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setEditing('new')} className="px-4 py-2 bg-[#002855] text-white rounded-lg text-sm flex items-center gap-2"><Plus className="w-4 h-4" />Nuevo plan</button>
          <button onClick={refresh} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-2"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-7 gap-3">
        {(['VENCIDO', 'URGENTE', 'PRÓXIMO', 'NORMAL'] as Alert[]).map(a => (
          <button key={a} onClick={() => { setTab('proyeccion'); setAlertFilter(a) }} className={`rounded-xl p-3 text-left ${ALERT_STYLE[a]}`}>
            <div className="text-xs font-semibold">{a}</div><div className="text-2xl font-bold">{counts[a]}</div>
          </button>
        ))}
        {([['30', counts.d30], ['60', counts.d60], ['90', counts.d90]] as const).map(([b, c]) => (
          <button key={b} onClick={() => { setTab('proyeccion'); setAlertFilter(b) }} className="rounded-xl p-3 text-left bg-white border">
            <div className="text-xs text-slate-500">Próximos {b} días</div><div className="text-2xl font-bold text-slate-900">{c}</div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 border-b">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`px-3 py-2 text-sm border-b-2 -mb-px ${tab === k ? 'border-[#002855] text-[#002855] font-semibold' : 'border-transparent text-slate-500'}`}>{label}</button>
        ))}
      </div>

      {loading ? <div className="p-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div> : (
        <>
          {tab === 'proyeccion' && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar unidad o plan…" className="border rounded-lg px-3 py-2 text-sm w-64" />
                <select value={alertFilter} onChange={e => setAlertFilter(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
                  <option value="TODAS">Todas</option>
                  {['VENCIDO', 'URGENTE', 'PRÓXIMO', 'NORMAL'].map(a => <option key={a}>{a}</option>)}
                  <option value="30">≤ 30 días</option><option value="60">31–60 días</option><option value="90">61–90 días</option>
                </select>
              </div>
              <div className="bg-white border rounded-xl overflow-x-auto">
                {filtered.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">No hay planes con estos filtros.</p> : (
                  <DataTable className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
                      <th className="text-left p-3">Unidad / plan</th><th className="text-left p-3">Alerta</th><th className="text-right p-3">Km rest.</th>
                      <th className="text-right p-3">Horas rest.</th><th className="text-right p-3">Días rest.</th><th className="text-left p-3">Fecha proyectada</th>
                      <th className="text-left p-3">OT</th><th className="p-3"></th>
                    </tr></thead>
                    <tbody className="divide-y">
                      {filtered.map(p => (
                        <tr key={p.plan_id}>
                          <td className="p-3"><div className="font-semibold text-[#002855]">{p.vehicle_plate}</div><div className="text-xs text-slate-500">{p.plan_name}</div></td>
                          <td className="p-3"><span className={`px-2 py-1 rounded text-xs font-bold ${ALERT_STYLE[p.alert_status]}`}>{p.alert_status}</span><div className="text-[11px] text-slate-500 mt-1">por {p.due_driver.toLowerCase()}</div></td>
                          <td className="p-3 text-right">{n(p.km_remaining)}</td>
                          <td className="p-3 text-right">{n(p.hours_remaining)}</td>
                          <td className="p-3 text-right">{n(p.days_remaining)}</td>
                          <td className="p-3">{p.projected_due_date ? format(new Date(`${p.projected_due_date}T12:00:00`), 'dd/MM/yyyy') : '—'}{p.avg_daily_km ? <div className="text-[11px] text-slate-500">{n(p.avg_daily_km)} km/día</div> : null}</td>
                          <td className="p-3 text-xs">{p.open_work_order_code ? `${p.open_work_order_code} (${p.open_work_order_status})` : '—'}</td>
                          <td className="p-3 text-right">
                            {!p.open_work_order_id && (
                              <button disabled={busy === p.plan_id} onClick={() => generate(p)} className="px-3 py-1.5 bg-[#002855] text-white rounded-lg text-xs flex items-center gap-1 ml-auto">
                                <Wrench className="w-3.5 h-3.5" />Generar OT
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </DataTable>
                )}
              </div>
            </div>
          )}

          {tab === 'calendario' && (
            calendar.length === 0 ? <p className="text-sm text-slate-500">No hay mantenimientos proyectados en los próximos 90 días.</p> : (
              <div className="grid md:grid-cols-3 gap-4">
                {calendar.map(([month, items]) => (
                  <div key={month} className="bg-white border rounded-xl p-4">
                    <h3 className="font-semibold mb-3 flex items-center gap-2"><CalendarClock className="w-4 h-4" />{format(new Date(`${month}-15T12:00:00`), 'MMMM yyyy')}</h3>
                    <ul className="space-y-2 text-sm">
                      {items.sort((a, b) => String(a.projected_due_date).localeCompare(String(b.projected_due_date))).map(p => (
                        <li key={p.plan_id} className="flex justify-between gap-2">
                          <span>{format(new Date(`${p.projected_due_date}T12:00:00`), 'dd/MM')} · <b>{p.vehicle_plate}</b> {p.plan_name}</span>
                          <span className={`px-1.5 rounded text-[11px] font-bold h-fit ${ALERT_STYLE[p.alert_status]}`}>{p.alert_status}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )
          )}

          {tab === 'planes' && (
            <div className="bg-white border rounded-xl overflow-x-auto">
              {plans.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">Aún no hay planes. Cree el primero con “Nuevo plan”.</p> : (
                <DataTable className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
                    <th className="text-left p-3">Plan</th><th className="text-left p-3">Unidad</th><th className="text-left p-3">Frecuencia</th>
                    <th className="text-left p-3">Última ejecución</th><th className="text-left p-3">Estado</th><th className="p-3"></th>
                  </tr></thead>
                  <tbody className="divide-y">
                    {plans.map(pl => (
                      <tr key={pl.id}>
                        <td className="p-3"><div className="font-semibold">{pl.name}</div><div className="text-xs text-slate-500">{(pl.standard_tasks || []).length} tareas · {(pl.expected_parts || []).length} repuestos previstos</div></td>
                        <td className="p-3">{pl.vehicle_plate || '—'}</td>
                        <td className="p-3 text-xs">{[pl.frequency_km && `${n(pl.frequency_km)} km`, pl.frequency_hours && `${n(pl.frequency_hours)} h`, pl.frequency_days && `${pl.frequency_days} días`].filter(Boolean).join(' · ')}</td>
                        <td className="p-3 text-xs">{[pl.last_performed_km != null && `${n(pl.last_performed_km)} km`, pl.last_performed_hours ? `${n(pl.last_performed_hours)} h` : null, pl.last_performed_date].filter(Boolean).join(' · ')}</td>
                        <td className="p-3 text-xs">{pl.is_active ? 'Activo' : 'Inactivo'}</td>
                        <td className="p-3 text-right"><button onClick={() => setEditing(pl)} className="p-1.5 border rounded-lg"><Edit2 className="w-4 h-4" /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
              )}
            </div>
          )}

          {tab === 'lecturas' && <ReadingForm vehicles={vehicles} onSaved={refresh} />}

          {tab === 'programador' && (
            <div className="space-y-3">
              <div className="bg-white border rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm text-slate-600">El programador corre automáticamente todos los días a las 06:00 (Lima) en la base de datos y genera OT en BORRADOR para los planes VENCIDOS o URGENTES sin OT abierta.</div>
                <button disabled={busy === 'scheduler'} onClick={runScheduler} className="px-4 py-2 bg-[#002855] text-white rounded-lg text-sm flex items-center gap-2"><Play className="w-4 h-4" />Ejecutar ahora</button>
              </div>
              <div className="bg-white border rounded-xl overflow-x-auto">
                <DataTable className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="text-left p-3">Fecha</th><th className="text-left p-3">Origen</th><th className="text-right p-3">Evaluados</th><th className="text-right p-3">OT generadas</th></tr></thead>
                  <tbody className="divide-y">
                    {runs.map(r => <tr key={r.id}><td className="p-3">{format(new Date(r.run_at), 'dd/MM/yyyy HH:mm')}</td><td className="p-3">{r.triggered_by}</td><td className="p-3 text-right">{r.evaluated}</td><td className="p-3 text-right">{r.generated}</td></tr>)}
                    {runs.length === 0 && <tr><td colSpan={4} className="p-6 text-center text-slate-500">Sin corridas registradas.</td></tr>}
                  </tbody>
                </DataTable>
              </div>
            </div>
          )}
        </>
      )}

      {editing && (
        <PlanModal plan={editing === 'new' ? null : editing} vehicles={vehicles} parts={parts}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh() }} />
      )}
    </div>
  )
}

function PlanModal({ plan, vehicles, parts, onClose, onSaved }: {
  plan: Plan | null
  vehicles: { plate: string; type: string; current_odometer: number | null; current_hours: number | null }[]
  parts: { id: string; internal_code: string; name: string }[]
  onClose: () => void; onSaved: () => void
}) {
  const [form, setForm] = useState({
    name: plan?.name || '', vehicle_plate: plan?.vehicle_plate || '', activity_description: plan?.activity_description || '',
    frequency_km: plan?.frequency_km?.toString() || '', frequency_hours: plan?.frequency_hours?.toString() || '', frequency_days: plan?.frequency_days?.toString() || '',
    last_performed_km: plan?.last_performed_km?.toString() || '', last_performed_hours: plan?.last_performed_hours?.toString() || '', last_performed_date: plan?.last_performed_date || '',
    is_active: plan?.is_active ?? true,
  })
  const [tasks, setTasks] = useState<string[]>((plan?.standard_tasks || []).map(t => t.description || t.text || '').filter(Boolean))
  const [expected, setExpected] = useState<{ part_id: string; quantity: number }[]>(plan?.expected_parts || [])
  const [saving, setSaving] = useState(false)
  const vehicle = vehicles.find(v => v.plate === form.vehicle_plate)
  const num = (v: string) => (v.trim() === '' ? null : Number(v))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.frequency_km && !form.frequency_hours && !form.frequency_days) return toast.error('Defina al menos una frecuencia (km, horas o días)')
    setSaving(true)
    const payload = {
      name: form.name.trim(), vehicle_plate: form.vehicle_plate, activity_description: form.activity_description || null,
      frequency_km: num(form.frequency_km), frequency_hours: num(form.frequency_hours), frequency_days: num(form.frequency_days),
      last_performed_km: num(form.last_performed_km), last_performed_hours: num(form.last_performed_hours), last_performed_date: form.last_performed_date || null,
      standard_tasks: tasks.filter(t => t.trim()).map(t => ({ description: t.trim() })),
      expected_parts: expected.filter(x => x.part_id && x.quantity > 0),
      is_active: form.is_active,
    }
    const { error } = plan
      ? await supabase.from('maintenance_plans').update(payload).eq('id', plan.id)
      : await supabase.from('maintenance_plans').insert(payload)
    setSaving(false)
    if (error) return toast.error('No se pudo guardar: ' + error.message)
    toast.success(plan ? 'Plan actualizado' : 'Plan creado; la línea base es la lectura actual de la unidad')
    onSaved()
  }

  const field = 'w-full border rounded-lg px-3 py-2 text-sm'
  return (
    <Modal isOpen onClose={onClose} title={plan ? `Editar plan · ${plan.name}` : 'Nuevo plan preventivo'} maxWidth="max-w-2xl">
      <form onSubmit={save} className="space-y-3 text-sm max-h-[75vh] overflow-y-auto pr-1">
        <div className="grid md:grid-cols-2 gap-3">
          <label>Nombre<input required className={field} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
          <label>Unidad
            <select required className={field} value={form.vehicle_plate} onChange={e => setForm({ ...form, vehicle_plate: e.target.value })}>
              <option value="">Seleccionar…</option>{vehicles.map(v => <option key={v.plate} value={v.plate}>{v.plate} · {v.type}</option>)}
            </select>
          </label>
        </div>
        {vehicle && <p className="text-xs text-slate-500 flex items-center gap-1"><Gauge className="w-3.5 h-3.5" />Lectura actual: {n(vehicle.current_odometer, ' km')} · {n(vehicle.current_hours, ' h')}</p>}
        <label className="block">Actividad<textarea className={field} rows={2} value={form.activity_description} onChange={e => setForm({ ...form, activity_description: e.target.value })} /></label>
        <fieldset className="grid grid-cols-3 gap-3"><legend className="text-xs font-semibold text-slate-500 mb-1">Frecuencia (vence lo primero que ocurra)</legend>
          <label>Cada km<input type="number" min={1} className={field} value={form.frequency_km} onChange={e => setForm({ ...form, frequency_km: e.target.value })} /></label>
          <label>Cada horas<input type="number" min={1} className={field} value={form.frequency_hours} onChange={e => setForm({ ...form, frequency_hours: e.target.value })} /></label>
          <label>Cada días<input type="number" min={1} className={field} value={form.frequency_days} onChange={e => setForm({ ...form, frequency_days: e.target.value })} /></label>
        </fieldset>
        <fieldset className="grid grid-cols-3 gap-3"><legend className="text-xs font-semibold text-slate-500 mb-1">Última ejecución (vacío = desde la lectura actual)</legend>
          <label>Km<input type="number" min={0} className={field} value={form.last_performed_km} onChange={e => setForm({ ...form, last_performed_km: e.target.value })} /></label>
          <label>Horas<input type="number" min={0} className={field} value={form.last_performed_hours} onChange={e => setForm({ ...form, last_performed_hours: e.target.value })} /></label>
          <label>Fecha<input type="date" className={field} value={form.last_performed_date} onChange={e => setForm({ ...form, last_performed_date: e.target.value })} /></label>
        </fieldset>
        <div>
          <div className="text-xs font-semibold text-slate-500 mb-1">Tareas estándar</div>
          {tasks.map((t, i) => (
            <div key={i} className="flex gap-2 mb-1">
              <input className={field} value={t} onChange={e => setTasks(tasks.map((x, j) => j === i ? e.target.value : x))} />
              <button type="button" onClick={() => setTasks(tasks.filter((_, j) => j !== i))} className="px-2 border rounded-lg"><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
          <button type="button" onClick={() => setTasks([...tasks, ''])} className="text-xs text-blue-600">+ Agregar tarea</button>
        </div>
        <div>
          <div className="text-xs font-semibold text-slate-500 mb-1">Repuestos previstos</div>
          {expected.map((x, i) => (
            <div key={i} className="flex gap-2 mb-1">
              <select className={field} value={x.part_id} onChange={e => setExpected(expected.map((y, j) => j === i ? { ...y, part_id: e.target.value } : y))}>
                <option value="">Repuesto…</option>{parts.map(p => <option key={p.id} value={p.id}>{p.internal_code} · {p.name}</option>)}
              </select>
              <input type="number" min={0.01} step="0.01" className="w-24 border rounded-lg px-2" value={x.quantity} onChange={e => setExpected(expected.map((y, j) => j === i ? { ...y, quantity: Number(e.target.value) } : y))} />
              <button type="button" onClick={() => setExpected(expected.filter((_, j) => j !== i))} className="px-2 border rounded-lg"><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
          <button type="button" onClick={() => setExpected([...expected, { part_id: '', quantity: 1 }])} className="text-xs text-blue-600">+ Agregar repuesto</button>
        </div>
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} />Plan activo</label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 border rounded-lg">Cancelar</button>
          <button disabled={saving} className="px-4 py-2 bg-[#002855] text-white rounded-lg">{saving ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </form>
    </Modal>
  )
}

function ReadingForm({ vehicles, onSaved }: {
  vehicles: { plate: string; type: string; current_odometer: number | null; current_hours: number | null }[]; onSaved: () => void
}) {
  const [plate, setPlate] = useState('')
  const [odometer, setOdometer] = useState('')
  const [hours, setHours] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const v = vehicles.find(x => x.plate === plate)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    const { data, error } = await supabase.rpc('register_asset_reading', {
      p_vehicle_plate: plate, p_odometer: odometer ? Number(odometer) : null, p_hours: hours ? Number(hours) : null,
      p_source: 'MANTENIMIENTO', p_notes: notes || null,
    })
    setSaving(false)
    if (error || !data?.success) return toast.error(error?.message || data?.error)
    toast.success('Lectura registrada; las proyecciones se actualizaron')
    setOdometer(''); setHours(''); setNotes(''); onSaved()
  }

  const field = 'border rounded-lg px-3 py-2 text-sm'
  return (
    <form onSubmit={save} className="bg-white border rounded-xl p-4 grid md:grid-cols-5 gap-3 items-end text-sm">
      <label className="md:col-span-1">Unidad
        <select required className={`${field} w-full`} value={plate} onChange={e => setPlate(e.target.value)}>
          <option value="">Seleccionar…</option>{vehicles.map(x => <option key={x.plate} value={x.plate}>{x.plate}</option>)}
        </select>
      </label>
      <label>Odómetro (km){v && <span className="text-[11px] text-slate-400"> actual {n(v.current_odometer)}</span>}
        <input type="number" min={0} className={`${field} w-full`} value={odometer} onChange={e => setOdometer(e.target.value)} />
      </label>
      <label>Horómetro (h){v && <span className="text-[11px] text-slate-400"> actual {n(v.current_hours)}</span>}
        <input type="number" min={0} step="0.1" className={`${field} w-full`} value={hours} onChange={e => setHours(e.target.value)} />
      </label>
      <label>Nota<input className={`${field} w-full`} value={notes} onChange={e => setNotes(e.target.value)} /></label>
      <button disabled={saving} className="px-4 py-2 bg-[#002855] text-white rounded-lg flex items-center justify-center gap-2"><AlertTriangle className="w-4 h-4 hidden" />{saving ? 'Guardando…' : 'Registrar lectura'}</button>
    </form>
  )
}
