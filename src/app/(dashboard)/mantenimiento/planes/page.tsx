"use client"
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Search, Plus, Settings, Calendar, Activity, Edit2, Trash2 } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { toast } from 'sonner'

export default function MaintenancePlansPage() {
  const supabase = createClient()
  const [plans, setPlans] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
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
    responsible_role: 'MECANICO'
  })

  useEffect(() => {
    fetchPlans()
  }, [])

  const fetchPlans = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('maintenance_plans')
        .select('*')
        .order('created_at', { ascending: false })
      
      if (error) throw error
      setPlans(data || [])
    } catch (err: any) {
      toast.error('Error al cargar planes: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    
    const payload = {
      name: form.name,
      vehicle_type: form.vehicle_type,
      activity_description: form.activity_description,
      frequency_km: parseInt(form.frequency_km) || 0,
      frequency_days: parseInt(form.frequency_days) || 0,
      criticality: form.criticality,
      responsible_role: form.responsible_role
    }

    try {
      if (editingId) {
        const { error } = await supabase.from('maintenance_plans').update(payload).eq('id', editingId)
        if (error) throw error
        toast.success('Plan actualizado')
      } else {
        const { error } = await supabase.from('maintenance_plans').insert([payload])
        if (error) throw error
        toast.success('Plan creado exitosamente')
      }
      setIsModalOpen(false)
      fetchPlans()
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
      responsible_role: plan.responsible_role
    })
    setEditingId(plan.id)
    setIsModalOpen(true)
  }

  const handleToggleStatus = async (id: string, currentStatus: boolean) => {
    try {
      await supabase.from('maintenance_plans').update({ is_active: !currentStatus }).eq('id', id)
      toast.success(currentStatus ? 'Plan desactivado' : 'Plan activado')
      fetchPlans()
    } catch (err: any) {
      toast.error('Error al actualizar estado')
    }
  }

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Planes Preventivos</h1>
          <p className="text-sm text-slate-500">Configura la frecuencia de mantenimiento por tipo de vehículo</p>
        </div>
        <button 
          onClick={() => { setEditingId(null); setForm({ name: '', vehicle_type: 'CAMION', activity_description: '', frequency_km: '', frequency_days: '', criticality: 'MEDIA', responsible_role: 'MECANICO' }); setIsModalOpen(true) }}
          className="bg-[#002855] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#003566] transition-colors flex items-center gap-2"
        >
          <Plus className="w-5 h-5" /> Nuevo Plan
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        {loading ? (
          <div className="p-8 text-center text-slate-500">Cargando planes...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-600">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="p-4 font-semibold text-slate-900">Nombre del Plan</th>
                  <th className="p-4 font-semibold text-slate-900">Frecuencia</th>
                  <th className="p-4 font-semibold text-slate-900">Criticidad</th>
                  <th className="p-4 font-semibold text-slate-900">Estado</th>
                  <th className="p-4 font-semibold text-slate-900 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {plans.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="p-4">
                      <div className="font-semibold text-slate-900">{p.name}</div>
                      <div className="text-xs text-slate-500">{p.vehicle_type} - {p.responsible_role}</div>
                    </td>
                    <td className="p-4">
                      <div className="flex items-center gap-1"><Activity className="w-4 h-4 text-slate-400" /> {p.frequency_km.toLocaleString()} KM</div>
                      {p.frequency_days > 0 && <div className="flex items-center gap-1 text-xs text-slate-500 mt-1"><Calendar className="w-3 h-3 text-slate-400" /> {p.frequency_days} Días</div>}
                    </td>
                    <td className="p-4">
                      <span className={`px-2 py-1 rounded text-[10px] font-bold tracking-wider ${p.criticality === 'ALTA' || p.criticality === 'CRITICA' ? 'bg-red-100 text-red-700' : p.criticality === 'MEDIA' ? 'bg-yellow-100 text-yellow-700' : 'bg-slate-100 text-slate-700'}`}>
                        {p.criticality}
                      </span>
                    </td>
                    <td className="p-4">
                      <button 
                        onClick={() => handleToggleStatus(p.id, p.is_active)}
                        className={`px-2 py-1 rounded text-xs font-semibold ${p.is_active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-700'}`}
                      >
                        {p.is_active ? 'Activo' : 'Inactivo'}
                      </button>
                    </td>
                    <td className="p-4 text-right">
                      <button onClick={() => handleEdit(p)} className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg">
                        <Edit2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={editingId ? 'Editar Plan' : 'Nuevo Plan'}>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Nombre del Plan</label>
              <input type="text" required value={form.name} onChange={e => setForm({...form, name: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400" placeholder="Ej. Mantenimiento 10K" />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Tipo de Vehículo</label>
              <select value={form.vehicle_type} onChange={e => setForm({...form, vehicle_type: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-slate-900">
                <option value="CAMION">CAMION</option>
                <option value="FURGON">FURGON</option>
                <option value="CAMIONETA">CAMIONETA</option>
                <option value="TODOS">TODOS</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Criticidad</label>
              <select value={form.criticality} onChange={e => setForm({...form, criticality: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-slate-900">
                <option value="BAJA">BAJA</option>
                <option value="MEDIA">MEDIA</option>
                <option value="ALTA">ALTA</option>
                <option value="CRITICA">CRÍTICA</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Frecuencia (KM)</label>
              <input type="number" required min="0" value={form.frequency_km} onChange={e => setForm({...form, frequency_km: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-slate-900" />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Frecuencia (Días) <span className="text-slate-400 font-normal">- Opcional</span></label>
              <input type="number" min="0" value={form.frequency_days} onChange={e => setForm({...form, frequency_days: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-slate-900" />
            </div>

            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Actividades (Descripción corta)</label>
              <textarea value={form.activity_description} onChange={e => setForm({...form, activity_description: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg h-24 text-slate-900 placeholder:text-slate-400" placeholder="Cambio de aceite, filtros, etc." />
            </div>
          </div>
          
          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
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
