"use client"
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Search, Plus, Edit2, Trash2, Users, Star, StarHalf, Phone, MapPin } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { toast } from 'sonner'

export default function ProveedoresPage() {
  const supabase = createClient()
  const [providers, setProviders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  
  // Modal states
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  
  const [form, setForm] = useState({
    ruc: '',
    business_name: '',
    address: '',
    contact_name: '',
    contact_phone: '',
    specialty: '',
    rating: 5,
    is_active: true
  })

  useEffect(() => {
    fetchProviders()
  }, [])

  const fetchProviders = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('maintenance_providers')
        .select('*')
        .order('business_name')
      
      if (error) throw error
      setProviders(data || [])
    } catch (err: any) {
      toast.error('Error al cargar proveedores: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    try {
      if (editingId) {
        const { error } = await supabase.from('maintenance_providers').update(form).eq('id', editingId)
        if (error) throw error
        toast.success('Proveedor actualizado')
      } else {
        const { error } = await supabase.from('maintenance_providers').insert([form])
        if (error) throw error
        toast.success('Proveedor registrado')
      }
      setIsModalOpen(false)
      fetchProviders()
    } catch (err: any) {
      toast.error('Error: ' + err.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const openNew = () => {
    setEditingId(null)
    setForm({
      ruc: '',
      business_name: '',
      address: '',
      contact_name: '',
      contact_phone: '',
      specialty: '',
      rating: 5,
      is_active: true
    })
    setIsModalOpen(true)
  }

  const openEdit = (p: any) => {
    setEditingId(p.id)
    setForm({
      ruc: p.ruc,
      business_name: p.business_name,
      address: p.address || '',
      contact_name: p.contact_name || '',
      contact_phone: p.contact_phone || '',
      specialty: p.specialty || '',
      rating: p.rating,
      is_active: p.is_active
    })
    setIsModalOpen(true)
  }

  const renderStars = (rating: number) => {
    const stars = []
    for (let i = 1; i <= 5; i++) {
      if (i <= rating) stars.push(<Star key={i} className="w-4 h-4 text-amber-400 fill-amber-400" />)
      else stars.push(<Star key={i} className="w-4 h-4 text-slate-300" />)
    }
    return <div className="flex gap-0.5">{stars}</div>
  }

  const filtered = providers.filter(p => 
    p.business_name.toLowerCase().includes(searchTerm.toLowerCase()) || 
    p.ruc.includes(searchTerm) ||
    (p.specialty || '').toLowerCase().includes(searchTerm.toLowerCase())
  )

  return (
    <div className="p-6 w-full max-w-7xl mx-auto space-y-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-black text-[#002855] tracking-tight">Talleres y Proveedores</h1>
          <p className="text-sm text-slate-500 font-medium mt-1">Directorio de contratistas de mantenimiento</p>
        </div>
        <button onClick={openNew} className="bg-[#002855] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#003566] transition-colors flex items-center gap-2">
          <Plus className="w-4 h-4" /> Nuevo Proveedor
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <div className="p-4 border-b border-slate-200 flex gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input 
              type="text" 
              placeholder="Buscar por Razón Social, RUC o Especialidad..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {loading ? (
          <div className="p-12 text-center text-slate-500">Cargando proveedores...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-600">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="p-4 font-semibold text-slate-900">Razón Social / RUC</th>
                  <th className="p-4 font-semibold text-slate-900">Especialidad</th>
                  <th className="p-4 font-semibold text-slate-900">Contacto</th>
                  <th className="p-4 font-semibold text-slate-900">Calificación</th>
                  <th className="p-4 font-semibold text-slate-900 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.length === 0 ? (
                  <tr><td colSpan={5} className="p-8 text-center">No se encontraron proveedores</td></tr>
                ) : (
                  filtered.map(p => (
                    <tr key={p.id} className="hover:bg-slate-50 transition-colors">
                      <td className="p-4">
                        <div className="font-bold text-[#002855]">{p.business_name}</div>
                        <div className="text-xs text-slate-500 font-mono mt-0.5">RUC: {p.ruc}</div>
                      </td>
                      <td className="p-4">
                        <span className="inline-block px-2 py-1 bg-slate-100 text-slate-700 text-xs font-bold rounded">
                          {p.specialty || 'GENERAL'}
                        </span>
                      </td>
                      <td className="p-4">
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-1 text-xs text-slate-700"><Users className="w-3 h-3 text-blue-500"/> {p.contact_name || '-'}</div>
                          <div className="flex items-center gap-1 text-xs text-slate-700"><Phone className="w-3 h-3 text-emerald-500"/> {p.contact_phone || '-'}</div>
                        </div>
                      </td>
                      <td className="p-4">
                        {renderStars(p.rating)}
                      </td>
                      <td className="p-4 text-right">
                        <button onClick={() => openEdit(p)} className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors">
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

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={editingId ? 'Editar Proveedor' : 'Nuevo Proveedor'} maxWidth="max-w-2xl">
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">RUC *</label>
              <input type="text" required value={form.ruc} onChange={e => setForm({...form, ruc: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg" />
            </div>
            <div className="col-span-2 md:col-span-1">
              <label className="block text-sm font-medium text-slate-700 mb-1">Razón Social *</label>
              <input type="text" required value={form.business_name} onChange={e => setForm({...form, business_name: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg" />
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Especialidad</label>
              <input type="text" value={form.specialty} onChange={e => setForm({...form, specialty: e.target.value})} placeholder="Ej. Mecánica Diésel, Llantas, Eléctrico" className="w-full p-2 border border-slate-300 rounded-lg" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Persona de Contacto</label>
              <input type="text" value={form.contact_name} onChange={e => setForm({...form, contact_name: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Teléfono</label>
              <input type="text" value={form.contact_phone} onChange={e => setForm({...form, contact_phone: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg" />
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Dirección</label>
              <input type="text" value={form.address} onChange={e => setForm({...form, address: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Calificación (1 a 5)</label>
              <select value={form.rating} onChange={e => setForm({...form, rating: Number(e.target.value)})} className="w-full p-2 border border-slate-300 rounded-lg">
                <option value="5">5 Estrellas (Excelente)</option>
                <option value="4">4 Estrellas (Muy Bueno)</option>
                <option value="3">3 Estrellas (Bueno)</option>
                <option value="2">2 Estrellas (Regular)</option>
                <option value="1">1 Estrella (Malo)</option>
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200 mt-6">
            <button type="button" onClick={() => setIsModalOpen(false)} className="px-4 py-2 text-slate-700 hover:bg-slate-100 rounded-lg font-medium">Cancelar</button>
            <button type="submit" disabled={isSubmitting} className="px-4 py-2 bg-[#002855] text-white rounded-lg font-medium hover:bg-[#003566]">
              {isSubmitting ? 'Guardando...' : 'Guardar Proveedor'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}