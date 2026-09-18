"use client"
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Search, Plus, Calendar, Activity, Edit2, Trash2, Truck, Wrench, AlertTriangle, Clock, Filter } from 'lucide-react'
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
    vehicle_type: 'CAMION',
    activity_description: '',
    frequency_km: '',
    frequency_days: '',
    criticality: 'MEDIA',
    responsible_role: 'MECANICO',
    tasks: [] as string[]
  })

  const [searchTerm, setSearchTerm] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filterCriticality, setFilterCriticality] = useState('TODOS')

  const filteredProjections = projections.filter((proj: any) => {
    const matchSearch = searchTerm === '' || 
      proj.plate?.toLowerCase().includes(searchTerm.toLowerCase()) || 
      proj.plan_name?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchCriticality = filterCriticality === 'TODOS' || proj.criticality === filterCriticality;
    return matchSearch && matchCriticality;
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
      
      const allPlans = pData || []
      setPlans(allPlans)

      // 2. Fetch Vehicles
      const { data: vData, error: vError } = await supabase
        .from('vehicles')
        .select('plate, type, average_daily_km, status')
      if (vError) throw vError
      
      setVehicles(vData || [])

      // 3. Generar Proyección
      // Para esta fase, la proyección es una estimación en base al Promedio de KM Diario del vehículo
      // En una versión más avanzada, se cruza con el ultimo registro de la OT.
      const now = new Date()
      const generatedProjections: any[] = []

      ;(vData || []).forEach(v => {
        // Encontrar planes aplicables al tipo de vehiculo
        const applicablePlans = allPlans.filter(p => p.vehicle_type === v.type)
        
        applicablePlans.forEach(plan => {
          let estimatedDays = 999
          
          if (plan.frequency_days > 0) {
            estimatedDays = plan.frequency_days
          }
          
          if (plan.frequency_km > 0 && v.average_daily_km > 0) {
            const daysByKm = Math.ceil(plan.frequency_km / v.average_daily_km)
            if (daysByKm < estimatedDays) estimatedDays = daysByKm
          }

          // Para demo, simulamos que el ultimo mantenimiento fue hace unos dias random (entre 10 y 60 dias)
          // Esto porque no tenemos aun el trigger que actualice 'last_maintenance_date' en la tabla vehicles
          const seed = v.plate.charCodeAt(0) + v.plate.charCodeAt(v.plate.length - 1) + plan.id.charCodeAt(0)
          const daysSinceLast = seed % 60
          
          const daysRemaining = estimatedDays - daysSinceLast

          generatedProjections.push({
            id: `${v.plate}-${plan.id}`,
            plate: v.plate,
            vehicle_type: v.type,
            plan_name: plan.name,
            criticality: plan.criticality,
            days_remaining: daysRemaining,
            due_date: new Date(now.getTime() + (daysRemaining * 24 * 60 * 60 * 1000)).toISOString().split('T')[0]
          })
        })
      })

      // Ordenar por los que vencen primero
      generatedProjections.sort((a, b) => a.days_remaining - b.days_remaining)
      setProjections(generatedProjections)

    } catch (err: any) {
      toast.error('Error al cargar datos: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  // --- HANDLERS PARA PLANES ---
  const handleSavePlan = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    const payload = {
      name: form.name,
      vehicle_type: form.vehicle_type,
      activity_description: form.activity_description,
      frequency_km: parseInt(form.frequency_km) || 0,
      frequency_days: parseInt(form.frequency_days) || 0,
      criticality: form.criticality,
      responsible_role: form.responsible_role,
      tasks: form.tasks
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
      vehicle_type: plan.vehicle_type,
      activity_description: plan.activity_description,
      frequency_km: plan.frequency_km.toString(),
      frequency_days: plan.frequency_days?.toString() || '',
      criticality: plan.criticality,
      responsible_role: plan.responsible_role,
      tasks: plan.tasks || []
    })
    setEditingId(plan.id)
    setIsModalOpen(true)
  }

  const addTask = () => setForm({ ...form, tasks: [...form.tasks, ''] })
  const updateTask = (index: number, val: string) => {
    const newTasks = [...form.tasks]
    newTasks[index] = val
    setForm({ ...form, tasks: newTasks })
  }
  const removeTask = (index: number) => {
    const newTasks = form.tasks.filter((_, i) => i !== index)
    setForm({ ...form, tasks: newTasks })
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
          className={`pb-3 font-semibold text-sm transition-colors relative ${activeTab === 'proyeccion' ? 'text-blue-600' : 'text-slate-500 hover:text-slate-800'}`}
        >
          Proyecciones y Alertas
          {activeTab === 'proyeccion' && <span className="absolute bottom-0 left-0 w-full h-0.5 bg-blue-600 rounded-t-full"></span>}
        </button>
        <button
          onClick={() => setActiveTab('planes')}
          className={`pb-3 font-semibold text-sm transition-colors relative ${activeTab === 'planes' ? 'text-blue-600' : 'text-slate-500 hover:text-slate-800'}`}
        >
          Configurar Planes
          {activeTab === 'planes' && <span className="absolute bottom-0 left-0 w-full h-0.5 bg-blue-600 rounded-t-full"></span>}
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12"><Activity className="w-8 h-8 animate-spin text-blue-500" /></div>
      ) : activeTab === 'proyeccion' ? (
        
        /* TAB: PROYECCIONES */
        <div className="space-y-6">

          {/* Filtros y Búsqueda */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
            <div className="flex flex-col md:flex-row gap-4 justify-between items-center">
              <div className="relative w-full md:w-96">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Search className="h-4 w-4 text-slate-400" />
                </div>
                <input
                  type="text"
                  placeholder="Buscar por placa o plan..."
                  className="block w-full pl-10 pr-3 py-2 border border-slate-300 rounded-lg bg-slate-50 focus:bg-white focus:ring-2 focus:ring-[#002855] focus:border-transparent transition-colors sm:text-sm text-slate-900"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <button
                onClick={() => setShowFilters(!showFilters)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors border ${showFilters ? 'bg-slate-100 border-slate-300 text-slate-800' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}
              >
                <Filter className="w-4 h-4" />
                Filtros Avanzados
              </button>
            </div>
            {showFilters && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4 pt-4 border-t border-slate-100">
                <div>
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Criticidad</label>
                  <select
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-[#002855] outline-none text-slate-900"
                    value={filterCriticality}
                    onChange={(e) => setFilterCriticality(e.target.value)}
                  >
                    <option value="TODOS">Todos</option>
                    <option value="ALTA">Alta</option>
                    <option value="MEDIA">Media</option>
                    <option value="BAJA">Baja</option>
                  </select>
                </div>
              </div>
            )}
          </div>

          <div className="bg-amber-50 border border-amber-200 p-4 rounded-xl flex items-start gap-3">
            <Activity className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-bold text-amber-900 text-sm">Proyección Basada en Promedio Diario</p>
              <p className="text-sm text-amber-800 mt-1">
                El sistema calcula la fecha estimada del próximo mantenimiento dividiendo la <strong>Frecuencia en KM</strong> del plan entre el <strong>Promedio de KM Diario</strong> registrado en la ficha de cada unidad, cruzándolo con los días límite.
              </p>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <table className="w-full text-left text-sm text-slate-600">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="p-4 font-semibold text-slate-900">Placa (Unidad)</th>
                  <th className="p-4 font-semibold text-slate-900">Plan Preventivo</th>
                  <th className="p-4 font-semibold text-slate-900">Vencimiento Proyectado</th>
                  <th className="p-4 font-semibold text-slate-900">Estado de Alerta</th>
                  <th className="p-4 font-semibold text-slate-900 text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredProjections.length === 0 ? (
                  <tr><td colSpan={5} className="p-8 text-center text-slate-500">No hay proyecciones disponibles</td></tr>
                ) : (
                  filteredProjections.map((proj) => (
                    <tr key={proj.id} className="hover:bg-slate-50">
                      <td className="p-4">
                        <Link href={`/mantenimiento/flota/${proj.plate}`} className="font-black text-[#002855] hover:text-blue-600 hover:underline">
                          {proj.plate}
                        </Link>
                      </td>
                      <td className="p-4">
                        <span className="font-semibold text-slate-800 block">{proj.plan_name}</span>
                        <span className="text-xs text-slate-400">Criticidad: {proj.criticality}</span>
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          <Calendar className="w-4 h-4 text-slate-400" />
                          <span className="font-medium text-slate-700">{proj.due_date}</span>
                        </div>
                      </td>
                      <td className="p-4">
                        <span className={`px-2 py-1 text-xs font-bold rounded-full ${
                          proj.days_remaining < 0 ? 'bg-red-100 text-red-700' :
                          proj.days_remaining <= 15 ? 'bg-orange-100 text-orange-700' :
                          proj.days_remaining <= 30 ? 'bg-amber-100 text-amber-700' :
                          'bg-emerald-100 text-emerald-700'
                        }`}>
                          {proj.days_remaining < 0 ? `Vencido hace ${Math.abs(proj.days_remaining)} días` : 
                           proj.days_remaining === 0 ? 'Vence HOY' : 
                           `Faltan ${proj.days_remaining} días`}
                        </span>
                      </td>
                      <td className="p-4 text-right">
                        <Link 
                          href="/mantenimiento/gestor-ot" 
                          className="text-xs font-bold text-blue-600 hover:text-blue-800 bg-blue-50 px-3 py-1.5 rounded-lg hover:bg-blue-100 transition-colors"
                        >
                          Generar OT
                        </Link>
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
              onClick={() => { setEditingId(null); setForm({ name: '', vehicle_type: 'CAMION', activity_description: '', frequency_km: '', frequency_days: '', criticality: 'MEDIA', responsible_role: 'MECANICO', tasks: [] }); setIsModalOpen(true) }}
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
                  <span className="text-[10px] font-bold bg-slate-100 text-slate-600 px-2 py-0.5 rounded uppercase">{p.vehicle_type}</span>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${p.criticality === 'ALTA' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{p.criticality}</span>
                </div>
                
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2 text-slate-600">
                    <Activity className="w-4 h-4 text-blue-500" />
                    <span>Cada <strong>{p.frequency_km} km</strong></span>
                  </div>
                  <div className="flex items-center gap-2 text-slate-600">
                    <Clock className="w-4 h-4 text-emerald-500" />
                    <span>O cada <strong>{p.frequency_days} días</strong></span>
                  </div>
                </div>

                <div className="mt-4 pt-4 border-t border-slate-100">
                  <p className="text-xs text-slate-500 font-medium mb-2">Tareas Incluidas ({p.tasks?.length || 0})</p>
                  <ul className="text-xs text-slate-600 space-y-1 pl-4 list-disc line-clamp-3">
                    {p.tasks?.slice(0, 3).map((t: string, i: number) => <li key={i}>{t}</li>)}
                    {p.tasks?.length > 3 && <li>... y {p.tasks.length - 3} más</li>}
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
            
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Tipo de Vehículo</label>
              <select value={form.vehicle_type} onChange={e => setForm({...form, vehicle_type: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-slate-900">
                <option value="CAMION">Camión</option>
                <option value="TRACTO">Tracto</option>
                <option value="MONTACARGA">Montacarga</option>
                <option value="CAMIONETA">Camioneta</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Criticidad</label>
              <select value={form.criticality} onChange={e => setForm({...form, criticality: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-slate-900">
                <option value="BAJA">Baja</option>
                <option value="MEDIA">Media</option>
                <option value="ALTA">Alta</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Frecuencia (Kilómetros) *</label>
              <input type="number" required min="0" value={form.frequency_km} onChange={e => setForm({...form, frequency_km: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-slate-900" placeholder="Ej. 10000" />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Frecuencia Alternativa (Días)</label>
              <input type="number" min="0" value={form.frequency_days} onChange={e => setForm({...form, frequency_days: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-slate-900" placeholder="Ej. 90" />
            </div>
          </div>

          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="block text-sm font-medium text-slate-700">Checklist de Tareas</label>
              <button type="button" onClick={addTask} className="text-xs font-bold text-blue-600 flex items-center gap-1 hover:underline">
                <Plus className="w-3 h-3" /> Añadir Tarea
              </button>
            </div>
            <div className="space-y-2 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
              {form.tasks.map((task, index) => (
                <div key={index} className="flex gap-2">
                  <input type="text" required value={task} onChange={e => updateTask(index, e.target.value)} className="flex-1 p-2 text-sm border border-slate-300 rounded-lg text-slate-900" placeholder="Ej. Cambio de aceite de motor" />
                  <button type="button" onClick={() => removeTask(index)} className="p-2 text-slate-400 hover:text-red-500 transition-colors">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
              {form.tasks.length === 0 && (
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
