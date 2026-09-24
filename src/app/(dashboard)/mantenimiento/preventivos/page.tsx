"use client"
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Search, Plus, Calendar, Activity, Edit2, Trash2, AlertTriangle, Clock } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { toast } from 'sonner'
import Link from 'next/link'

export default function MaintenancePlansPage() {
  const supabase = createClient()
  const [activeTab, setActiveTab] = useState<'proyeccion' | 'planes'>('proyeccion')
  
  // Data States
  const [plans, setPlans] = useState<any[]>([])
  const [vehicles, setVehicles] = useState<any[]>([])
  const [projections, setProjections] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  
  // Form States (Planes)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: '',
    vehicle_plate: '',
    description: '',
    frequency_km: '',
    frequency_days: '',
    frequency_hours: '',
    standard_tasks: [] as any[],
    expected_parts: [] as any[]
  })

  const [searchTerm, setSearchTerm] = useState('')
  const [filterStatus, setFilterStatus] = useState('TODOS')

  const filteredProjections = projections.filter((proj: any) => {
    const matchSearch = searchTerm === '' || 
      proj.vehicle_plate?.toLowerCase().includes(searchTerm.toLowerCase()) || 
      proj.plan_name?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchStatus = filterStatus === 'TODOS' || proj.alert_status === filterStatus;
    return matchSearch && matchStatus;
  })

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    setLoading(true)
    try {
      // 1. Fetch Plans
      const { data: pData, error: pError } = await supabase
        .from('maintenance_plans')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: false })
      if (pError) throw pError
      setPlans(pData || [])

      // 2. Fetch Vehicles
      const { data: vData, error: vError } = await supabase
        .from('vehicles')
        .select('plate, type, status, current_odometer, current_hours')
      if (vError) throw vError
      setVehicles(vData || [])

      // 3. Fetch Projections
      const { data: projData, error: projError } = await supabase
        .from('vw_maintenance_projections')
        .select('*')
        .order('days_remaining', { ascending: true })
      
      if (projError) throw projError
      setProjections(projData || [])

    } catch (err: any) {
      toast.error('Error al cargar datos: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleGenerateOT = async (planId: string) => {
    try {
      const { data, error } = await supabase.rpc('generate_preventive_wo', { p_plan_id: planId })
      if (error) throw error
      toast.success('OT Preventiva generada con éxito')
      fetchData()
    } catch (err: any) {
      toast.error('Error al generar OT: ' + err.message)
    }
  }

  // --- HANDLERS PARA PLANES ---
  const handleSavePlan = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    const payload = {
      name: form.name,
      vehicle_plate: form.vehicle_plate,
      description: form.description,
      frequency_km: parseInt(form.frequency_km) || null,
      frequency_days: parseInt(form.frequency_days) || null,
      frequency_hours: parseInt(form.frequency_hours) || null,
      standard_tasks: form.standard_tasks,
      expected_parts: form.expected_parts
    }
    try {
      if (editingId) {
        await supabase.from('maintenance_plans').update(payload).eq('id', editingId)
        toast.success('Plan actualizado')
      } else {
        await supabase.from('maintenance_plans').insert([payload])
        toast.success('Plan creado exitosamente')
      }
      setIsModalOpen(false)
      fetchData()
    } catch (err: any) {
      toast.error('Error al guardar: ' + err.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleEdit = (plan: any) => {
    setForm({
      name: plan.name,
      vehicle_plate: plan.vehicle_plate,
      description: plan.description || '',
      frequency_km: plan.frequency_km?.toString() || '',
      frequency_days: plan.frequency_days?.toString() || '',
      frequency_hours: plan.frequency_hours?.toString() || '',
      standard_tasks: plan.standard_tasks || [],
      expected_parts: plan.expected_parts || []
    })
    setEditingId(plan.id)
    setIsModalOpen(true)
  }

  const addTask = () => setForm({ ...form, standard_tasks: [...form.standard_tasks, { description: '', estimated_hours: 1 }] })
  const updateTask = (index: number, val: string) => {
    const newTasks = [...form.standard_tasks]
    newTasks[index].description = val
    setForm({ ...form, standard_tasks: newTasks })
  }
  const removeTask = (index: number) => {
    const newTasks = form.standard_tasks.filter((_, i) => i !== index)
    setForm({ ...form, standard_tasks: newTasks })
  }

  return (
    <div className="space-y-6 w-full mx-auto">
      <div className="flex justify-between items-center mb-2">
        <div>
          <h1 className="text-2xl font-black text-[#002855] tracking-tight">Preventivos y Proyección</h1>
          <p className="text-sm text-slate-500 font-medium mt-1">Motor de alertas proyectadas y gestión de planes de mantenimiento</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-4 border-b border-slate-200">
        <button
          onClick={() => setActiveTab('proyeccion')}
          className={"pb-3 font-semibold text-sm transition-colors relative " + (activeTab === 'proyeccion' ? 'text-blue-600' : 'text-slate-500 hover:text-slate-800')}
        >
          Proyecciones y Alertas
          {activeTab === 'proyeccion' && <span className="absolute bottom-0 left-0 w-full h-0.5 bg-blue-600 rounded-t-full"></span>}
        </button>
        <button
          onClick={() => setActiveTab('planes')}
          className={"pb-3 font-semibold text-sm transition-colors relative " + (activeTab === 'planes' ? 'text-blue-600' : 'text-slate-500 hover:text-slate-800')}
        >
          Configurar Planes
          {activeTab === 'planes' && <span className="absolute bottom-0 left-0 w-full h-0.5 bg-blue-600 rounded-t-full"></span>}
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12"><Activity className="w-8 h-8 animate-spin text-blue-500" /></div>
      ) : activeTab === 'proyeccion' ? (
        
        /* TAB: PROYECCIONES */
        <div className="space-y-4">
          <div className="flex gap-4 mb-6">
            <div className="flex-1 relative">
              <Search className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
              <input 
                type="text" 
                placeholder="Buscar por placa o plan..." 
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <select 
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="border border-slate-200 rounded-lg px-4 py-2 bg-white text-sm"
            >
              <option value="TODOS">Todos los Estados</option>
              <option value="VENCIDO">Vencido</option>
              <option value="URGENTE">Urgente</option>
              <option value="PRÓXIMO">Próximo</option>
              <option value="NORMAL">Normal</option>
            </select>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Vehículo</th>
                  <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Plan Aplicable</th>
                  <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Métricas Restantes</th>
                  <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Estado</th>
                  <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredProjections.length === 0 ? (
                  <tr><td colSpan={5} className="p-8 text-center text-slate-500">No hay proyecciones que coincidan con los filtros.</td></tr>
                ) : (
                  filteredProjections.map((proj: any) => (
                    <tr key={proj.plan_id + proj.vehicle_plate} className="hover:bg-slate-50 transition-colors">
                      <td className="p-4 border-b border-slate-100">
                        <div className="font-bold text-slate-900">{proj.vehicle_plate}</div>
                      </td>
                      <td className="p-4 border-b border-slate-100 text-sm font-medium text-slate-700">
                        {proj.plan_name}
                      </td>
                      <td className="p-4 border-b border-slate-100">
                        {proj.km_remaining !== null && (
                          <div className="text-sm">KM: <span className="font-bold text-slate-900">{proj.km_remaining}</span></div>
                        )}
                        {proj.days_remaining !== null && (
                          <div className="text-sm">Días: <span className="font-bold text-slate-900">{proj.days_remaining}</span></div>
                        )}
                        {proj.hours_remaining !== null && (
                          <div className="text-sm">Horas: <span className="font-bold text-slate-900">{proj.hours_remaining}</span></div>
                        )}
                      </td>
                      <td className="p-4 border-b border-slate-100">
                        {proj.alert_status === 'VENCIDO' && <span className="bg-red-100 text-red-700 font-bold px-2 py-1 rounded text-xs flex items-center gap-1 w-max"><AlertTriangle className="w-3 h-3"/> VENCIDO</span>}
                        {proj.alert_status === 'URGENTE' && <span className="bg-orange-100 text-orange-700 font-bold px-2 py-1 rounded text-xs w-max block">URGENTE</span>}
                        {proj.alert_status === 'PRÓXIMO' && <span className="bg-amber-100 text-amber-700 font-bold px-2 py-1 rounded text-xs w-max block">PRÓXIMO</span>}
                        {proj.alert_status === 'NORMAL' && <span className="bg-emerald-100 text-emerald-700 font-bold px-2 py-1 rounded text-xs w-max block">NORMAL</span>}
                      </td>
                      <td className="p-4 border-b border-slate-100 text-right">
                        {(proj.alert_status === 'VENCIDO' || proj.alert_status === 'URGENTE' || proj.alert_status === 'PRÓXIMO') && (
                          <button 
                            onClick={() => handleGenerateOT(proj.plan_id)}
                            className="text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-lg transition-colors"
                          >
                            Generar OT
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
        
      ) : (
        
        /* TAB: PLANES (CRUD) */
        <div className="space-y-6">
          <div className="flex justify-end">
            <button 
              onClick={() => { setEditingId(null); setForm({ name: '', vehicle_plate: '', description: '', frequency_km: '', frequency_days: '', frequency_hours: '', standard_tasks: [], expected_parts: [] }); setIsModalOpen(true) }}
              className="bg-[#002855] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#003566] transition-colors flex items-center gap-2 text-sm"
            >
              <Plus className="w-4 h-4" /> Nuevo Plan Preventivo
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {plans.map((p) => (
              <div key={p.id} className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 relative group">
                <div className="flex justify-between items-start mb-3">
                  <h3 className="font-bold text-slate-900 text-lg">{p.name}</h3>
                  <button onClick={() => handleEdit(p)} className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors opacity-0 group-hover:opacity-100">
                    <Edit2 className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex gap-2 mb-4">
                  <span className="text-[10px] font-bold bg-slate-100 text-slate-600 px-2 py-0.5 rounded uppercase">Placa: {p.vehicle_plate}</span>
                </div>
                
                <div className="space-y-2 text-sm">
                  {p.frequency_km && (
                    <div className="flex items-center gap-2 text-slate-600">
                      <Activity className="w-4 h-4 text-blue-500" />
                      <span>Cada <strong>{p.frequency_km} km</strong></span>
                    </div>
                  )}
                  {p.frequency_days && (
                    <div className="flex items-center gap-2 text-slate-600">
                      <Clock className="w-4 h-4 text-emerald-500" />
                      <span>Cada <strong>{p.frequency_days} días</strong></span>
                    </div>
                  )}
                  {p.frequency_hours && (
                    <div className="flex items-center gap-2 text-slate-600">
                      <Clock className="w-4 h-4 text-purple-500" />
                      <span>Cada <strong>{p.frequency_hours} horas</strong></span>
                    </div>
                  )}
                </div>

                <div className="mt-4 pt-4 border-t border-slate-100">
                  <p className="text-xs text-slate-500 font-medium mb-2">Tareas Incluidas ({p.standard_tasks?.length || 0})</p>
                  <ul className="text-xs text-slate-600 space-y-1 pl-4 list-disc line-clamp-3">
                    {p.standard_tasks?.slice(0, 3).map((t: any, i: number) => <li key={i}>{t.description}</li>)}
                    {p.standard_tasks?.length > 3 && <li>... y {p.standard_tasks.length - 3} más</li>}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* MODAL CREAR/EDITAR PLAN */}
      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={editingId ? 'Editar Plan' : 'Nuevo Plan Preventivo'} maxWidth="max-w-2xl">
        <form onSubmit={handleSavePlan} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Nombre del Plan *</label>
              <input type="text" required value={form.name} onChange={e => setForm({...form, name: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-slate-900" placeholder="Ej. PM1 - Mantenimiento Menor" />
            </div>
            
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Vehículo (Placa) *</label>
              <select required value={form.vehicle_plate} onChange={e => setForm({...form, vehicle_plate: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-slate-900">
                <option value="">Seleccione vehículo...</option>
                {vehicles.map(v => (
                  <option key={v.plate} value={v.plate}>{v.plate} ({v.type})</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Frecuencia (Kilómetros)</label>
              <input type="number" min="0" value={form.frequency_km} onChange={e => setForm({...form, frequency_km: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-slate-900" placeholder="Ej. 10000" />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Frecuencia Alternativa (Días)</label>
              <input type="number" min="0" value={form.frequency_days} onChange={e => setForm({...form, frequency_days: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-slate-900" placeholder="Ej. 90" />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Frecuencia (Horómetro)</label>
              <input type="number" min="0" value={form.frequency_hours} onChange={e => setForm({...form, frequency_hours: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-slate-900" placeholder="Ej. 250" />
            </div>
          </div>

          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="block text-sm font-medium text-slate-700">Checklist de Tareas Estandar</label>
              <button type="button" onClick={addTask} className="text-xs font-bold text-blue-600 flex items-center gap-1 hover:underline">
                <Plus className="w-3 h-3" /> Añadir Tarea
              </button>
            </div>
            <div className="space-y-2 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
              {form.standard_tasks.map((task, index) => (
                <div key={index} className="flex gap-2">
                  <input type="text" required value={task.description} onChange={e => updateTask(index, e.target.value)} className="flex-1 p-2 text-sm border border-slate-300 rounded-lg text-slate-900" placeholder="Ej. Cambio de aceite de motor" />
                  <button type="button" onClick={() => removeTask(index)} className="p-2 text-slate-400 hover:text-red-500 transition-colors">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
              {form.standard_tasks.length === 0 && (
                <p className="text-sm text-slate-500 italic text-center py-2 border border-dashed border-slate-300 rounded-lg">No hay tareas definidas</p>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4 mt-6 border-t border-slate-200">
            <button type="button" onClick={() => setIsModalOpen(false)} className="px-4 py-2 text-slate-700 hover:bg-slate-100 rounded-lg font-medium">Cancelar</button>
            <button type="submit" disabled={isSubmitting} className="px-4 py-2 bg-[#002855] text-white rounded-lg font-medium hover:bg-[#003566]">
              {isSubmitting ? 'Guardando...' : 'Guardar Plan'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
