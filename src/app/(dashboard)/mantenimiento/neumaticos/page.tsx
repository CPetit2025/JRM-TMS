"use client"
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Search, Plus, Edit2, Activity, Settings2, ShieldCheck, MapPin } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { toast } from 'sonner'

export default function NeumaticosPage() {
  const supabase = createClient()
  const [tires, setTires] = useState<any[]>([])
  const [vehicles, setVehicles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  
  // Modal
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  
  const [form, setForm] = useState({
    internal_code: '',
    brand: '',
    model: '',
    size: '',
    status: 'ALMACEN',
    current_vehicle_plate: '',
    current_position: '',
    initial_tread_depth_mm: '',
    current_tread_depth_mm: ''
  })

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    setLoading(true)
    try {
      const { data: tData, error: tError } = await supabase.from('tires').select('*').order('created_at', { ascending: false })
      if (tError) throw tError
      setTires(tData || [])

      const { data: vData } = await supabase.from('vehicles').select('plate').order('plate')
      setVehicles(vData || [])
    } catch (err: any) {
      toast.error('Error al cargar neumáticos: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    
    const payload = {
      ...form,
      current_vehicle_plate: form.status === 'INSTALADA' ? form.current_vehicle_plate : null,
      current_position: form.status === 'INSTALADA' ? form.current_position : null,
      initial_tread_depth_mm: form.initial_tread_depth_mm ? parseFloat(form.initial_tread_depth_mm) : null,
      current_tread_depth_mm: form.current_tread_depth_mm ? parseFloat(form.current_tread_depth_mm) : null
    }

    try {
      if (editingId) {
        const { error } = await supabase.from('tires').update(payload).eq('id', editingId)
        if (error) throw error
        toast.success('Neumático actualizado')
      } else {
        const { error } = await supabase.from('tires').insert([payload])
        if (error) throw error
        toast.success('Neumático registrado')
      }
      setIsModalOpen(false)
      fetchData()
    } catch (err: any) {
      toast.error('Error: ' + err.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const openNew = () => {
    setEditingId(null)
    setForm({
      internal_code: '', brand: '', model: '', size: '', status: 'ALMACEN',
      current_vehicle_plate: '', current_position: '',
      initial_tread_depth_mm: '', current_tread_depth_mm: ''
    })
    setIsModalOpen(true)
  }

  const openEdit = (t: any) => {
    setEditingId(t.id)
    setForm({
      internal_code: t.internal_code,
      brand: t.brand || '',
      model: t.model || '',
      size: t.size || '',
      status: t.status,
      current_vehicle_plate: t.current_vehicle_plate || '',
      current_position: t.current_position || '',
      initial_tread_depth_mm: t.initial_tread_depth_mm?.toString() || '',
      current_tread_depth_mm: t.current_tread_depth_mm?.toString() || ''
    })
    setIsModalOpen(true)
  }

  const filtered = tires.filter(t => 
    t.internal_code.toLowerCase().includes(searchTerm.toLowerCase()) || 
    (t.brand || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    (t.current_vehicle_plate || '').toLowerCase().includes(searchTerm.toLowerCase())
  )

  return (
    <div className="p-6 w-full max-w-7xl mx-auto space-y-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-black text-[#002855] tracking-tight">Gestión de Neumáticos</h1>
          <p className="text-sm text-slate-500 font-medium mt-1">Control de llantas, cocada y posiciones</p>
        </div>
        <button onClick={openNew} className="bg-[#002855] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#003566] transition-colors flex items-center gap-2">
          <Plus className="w-4 h-4" /> Registrar Neumático
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <div className="p-4 border-b border-slate-200 flex gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input 
              type="text" 
              placeholder="Buscar por código, marca o placa..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {loading ? (
          <div className="p-12 flex justify-center"><Activity className="w-8 h-8 animate-spin text-blue-500" /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-600">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="p-4 font-semibold text-slate-900">Código interno</th>
                  <th className="p-4 font-semibold text-slate-900">Detalle</th>
                  <th className="p-4 font-semibold text-slate-900">Estado / Ubicación</th>
                  <th className="p-4 font-semibold text-slate-900">Desgaste (Cocada)</th>
                  <th className="p-4 font-semibold text-slate-900 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.length === 0 ? (
                  <tr><td colSpan={5} className="p-8 text-center text-slate-500">No se encontraron neumáticos</td></tr>
                ) : (
                  filtered.map(t => (
                    <tr key={t.id} className="hover:bg-slate-50 transition-colors">
                      <td className="p-4">
                        <div className="font-bold text-[#002855] text-base">{t.internal_code}</div>
                        <div className="text-xs text-slate-400 mt-1 font-medium">{t.size || 'Medida N/A'}</div>
                      </td>
                      <td className="p-4">
                        <div className="font-semibold text-slate-700">{t.brand || 'S/M'}</div>
                        <div className="text-xs text-slate-500">{t.model || 'S/M'}</div>
                      </td>
                      <td className="p-4">
                        <span className={`inline-block px-2 py-1 text-xs font-bold rounded-full mb-1 ${
                          t.status === 'INSTALADA' ? 'bg-blue-100 text-blue-700' :
                          t.status === 'ALMACEN' ? 'bg-emerald-100 text-emerald-700' :
                          t.status === 'REENCAUCHE' ? 'bg-amber-100 text-amber-700' :
                          'bg-red-100 text-red-700'
                        }`}>
                          {t.status}
                        </span>
                        {t.status === 'INSTALADA' && (
                          <div className="flex items-center gap-1 text-xs text-slate-600 font-medium mt-1">
                            <MapPin className="w-3 h-3 text-blue-500" /> {t.current_vehicle_plate} ({t.current_position})
                          </div>
                        )}
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          <Settings2 className="w-4 h-4 text-slate-400" />
                          <span className="font-semibold text-slate-700">{t.current_tread_depth_mm || '-'} mm</span>
                          {t.initial_tread_depth_mm && (
                            <span className="text-xs text-slate-400">/ {t.initial_tread_depth_mm} mm orig.</span>
                          )}
                        </div>
                      </td>
                      <td className="p-4 text-right">
                        <button onClick={() => openEdit(t)} className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors">
                          <Edit2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={editingId ? 'Editar Neumático' : 'Registrar Neumático'} maxWidth="max-w-2xl">
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Código Interno *</label>
              <input type="text" required value={form.internal_code} onChange={e => setForm({...form, internal_code: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg" placeholder="Ej. LLA-1001" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Marca</label>
              <input type="text" value={form.brand} onChange={e => setForm({...form, brand: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg" placeholder="Ej. Michelin" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Modelo</label>
              <input type="text" value={form.model} onChange={e => setForm({...form, model: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg" placeholder="Ej. X Multi Z" />
            </div>
            <div className="col-span-2 md:col-span-1">
              <label className="block text-sm font-medium text-slate-700 mb-1">Medida</label>
              <input type="text" value={form.size} onChange={e => setForm({...form, size: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg" placeholder="Ej. 295/80R22.5" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Estado *</label>
              <select required value={form.status} onChange={e => setForm({...form, status: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg">
                <option value="ALMACEN">En Almacén</option>
                <option value="INSTALADA">Instalada en Vehículo</option>
                <option value="REENCAUCHE">En Reencauche</option>
                <option value="BAJA">De Baja</option>
              </select>
            </div>

            {form.status === 'INSTALADA' && (
              <>
                <div className="p-3 bg-blue-50 border border-blue-100 rounded-lg col-span-2 grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-blue-900 mb-1">Placa del Vehículo</label>
                    <select value={form.current_vehicle_plate} onChange={e => setForm({...form, current_vehicle_plate: e.target.value})} className="w-full p-2 border border-blue-200 rounded-lg">
                      <option value="">Seleccionar Placa</option>
                      {vehicles.map(v => <option key={v.plate} value={v.plate}>{v.plate}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-blue-900 mb-1">Posición</label>
                    <input type="text" value={form.current_position} onChange={e => setForm({...form, current_position: e.target.value})} className="w-full p-2 border border-blue-200 rounded-lg" placeholder="Ej. EJE1-IZQ" />
                  </div>
                </div>
              </>
            )}

            <div className="col-span-2 pt-2 border-t border-slate-100">
              <h4 className="text-sm font-bold text-slate-800 flex items-center gap-2 mb-3">
                <ShieldCheck className="w-4 h-4 text-emerald-500" /> Control de Desgaste
              </h4>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Cocada Inicial (mm)</label>
                  <input type="number" step="0.1" value={form.initial_tread_depth_mm} onChange={e => setForm({...form, initial_tread_depth_mm: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Cocada Actual (mm)</label>
                  <input type="number" step="0.1" value={form.current_tread_depth_mm} onChange={e => setForm({...form, current_tread_depth_mm: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg" />
                </div>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200 mt-6">
            <button type="button" onClick={() => setIsModalOpen(false)} className="px-4 py-2 text-slate-700 hover:bg-slate-100 rounded-lg font-medium">Cancelar</button>
            <button type="submit" disabled={isSubmitting} className="px-4 py-2 bg-[#002855] text-white rounded-lg font-medium hover:bg-[#003566]">
              {isSubmitting ? 'Guardando...' : 'Guardar Neumático'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}