"use client"
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Plus, Search, BookOpen, Truck } from 'lucide-react'
import { Modal } from '@/components/ui/modal'

interface SparePart {
  id: string
  internal_code: string
  name: string
  brand: string
  category: string
  compatibility: string
  is_active: boolean
}

export default function CatalogoMaestroPage() {
  const supabase = createClient()
  const [parts, setParts] = useState<SparePart[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  
  const [isFormModalOpen, setIsFormModalOpen] = useState(false)
  const [selectedPart, setSelectedPart] = useState<SparePart | null>(null)
  
  const [formData, setFormData] = useState({
    internal_code: '',
    name: '',
    brand: '',
    category: '',
    compatibility: ''
  })

  useEffect(() => {
    fetchParts()
    
    const channel = supabase.channel('spare_parts_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'spare_parts' }, () => {
        fetchParts()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  const fetchParts = async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('spare_parts')
        .select('*')
        .order('category', { ascending: true })
        .order('name', { ascending: true })

      if (error) throw error
      setParts(data as SparePart[])
    } catch (err: any) {
      toast.error('Error al cargar catálogo: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSavePart = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      if (selectedPart) {
        const { error } = await supabase
          .from('spare_parts')
          .update(formData)
          .eq('id', selectedPart.id)
        if (error) throw error
        toast.success('Registro actualizado')
      } else {
        const { error } = await supabase
          .from('spare_parts')
          .insert([formData])
        if (error) throw error
        toast.success('Registro creado exitosamente')
      }
      setIsFormModalOpen(false)
    } catch (err: any) {
      toast.error('Error: ' + err.message)
    }
  }

  const openNewForm = () => {
    setSelectedPart(null)
    setFormData({
      internal_code: '',
      name: '',
      brand: '',
      category: '',
      compatibility: ''
    })
    setIsFormModalOpen(true)
  }

  const openEditForm = (part: SparePart) => {
    setSelectedPart(part)
    setFormData({
      internal_code: part.internal_code,
      name: part.name,
      brand: part.brand || '',
      category: part.category || '',
      compatibility: part.compatibility || ''
    })
    setIsFormModalOpen(true)
  }

  const filtered = parts.filter(p => 
    p.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
    p.internal_code.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (p.category && p.category.toLowerCase().includes(searchTerm.toLowerCase()))
  )

  return (
    <div className="space-y-6 w-full mx-auto max-w-7xl p-6">
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <h1 className="text-2xl font-bold text-[#002855] tracking-tight">Catálogo Maestro</h1>
          <p className="text-sm text-slate-500 mt-1">Diccionario estandarizado de Repuestos y Servicios para imputar en las OTs.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[250px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input 
              type="text" 
              placeholder="Buscar por código, nombre o categoría..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-2.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none transition-all bg-slate-50"
            />
          </div>
          <button 
            onClick={openNewForm}
            className="flex items-center gap-2 px-4 py-2.5 bg-[#cf152d] text-white rounded-lg hover:bg-red-700 transition-colors shadow-sm font-semibold text-sm"
          >
            <Plus className="w-4 h-4" />
            Nuevo Ítem
          </button>
        </div>
      </div>
      
      {/* KPI Rápido */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
          <div className="p-3 bg-blue-100 text-blue-600 rounded-lg">
            <BookOpen className="w-6 h-6" />
          </div>
          <div>
            <p className="text-sm font-medium text-slate-500">Total Ítems Estandarizados</p>
            <h3 className="text-2xl font-bold text-slate-800">{parts.length}</h3>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        <div className="overflow-auto max-h-[calc(100vh-220px)]">
          <table className="w-full text-sm text-left relative">
            <thead className="text-xs text-slate-500 uppercase bg-slate-50 sticky top-0 z-10 shadow-[0_1px_0_0_#e2e8f0] border-slate-200">
              <tr>
                <th className="px-6 py-4 font-semibold">Código</th>
                <th className="px-6 py-4 font-semibold">Nombre / Descripción</th>
                <th className="px-6 py-4 font-semibold">Categoría / Marca</th>
                <th className="px-6 py-4 font-semibold">Compatibilidad</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-slate-500">Cargando catálogo...</td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-slate-500 italic">No hay ítems registrados.</td>
                </tr>
              ) : (
                filtered.map((part) => (
                  <tr 
                    key={part.id} 
                    className="hover:bg-slate-50 transition-colors cursor-pointer"
                    onClick={() => openEditForm(part)}
                  >
                    <td className="px-6 py-4">
                      <span className="font-mono text-xs bg-slate-100 text-slate-700 px-2 py-1 rounded font-bold border border-slate-200">
                        {part.internal_code}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="font-bold text-slate-900">{part.name}</span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-col">
                        <span className="text-slate-700 font-medium">{part.category || '-'}</span>
                        <span className="text-xs text-slate-400">{part.brand || '-'}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-slate-600">
                      {part.compatibility ? (
                        <div className="flex items-center gap-1.5" title={part.compatibility}>
                          <Truck className="w-3 h-3 text-slate-400" />
                          <span className="truncate max-w-[200px]">{part.compatibility}</span>
                        </div>
                      ) : '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      
      {/* Modal Formularios */}
      <Modal isOpen={isFormModalOpen} onClose={() => setIsFormModalOpen(false)} title={selectedPart ? 'Editar Ítem' : 'Nuevo Ítem de Catálogo'} maxWidth="max-w-xl">
        <form onSubmit={handleSavePart} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Código Interno *</label>
              <input required type="text" value={formData.internal_code} onChange={e => setFormData({...formData, internal_code: e.target.value})} className="w-full px-3 py-2 border rounded-lg focus:ring-1 focus:ring-blue-500 outline-none uppercase font-mono text-sm" placeholder="Ej. FIL-001" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Nombre / Descripción *</label>
              <input required type="text" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} className="w-full px-3 py-2 border rounded-lg focus:ring-1 focus:ring-blue-500 outline-none text-sm" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Categoría</label>
              <select value={formData.category} onChange={e => setFormData({...formData, category: e.target.value})} className="w-full px-3 py-2 border rounded-lg focus:ring-1 focus:ring-blue-500 outline-none text-sm bg-white">
                <option value="">Seleccione...</option>
                <option value="Filtros">Filtros</option>
                <option value="Lubricantes">Lubricantes</option>
                <option value="Frenos">Frenos</option>
                <option value="Suspensión">Suspensión</option>
                <option value="Eléctrico">Eléctrico</option>
                <option value="Transmisión">Transmisión</option>
                <option value="Dirección">Dirección</option>
                <option value="Consumibles">Consumibles Generales</option>
                <option value="Servicios">Servicios / Mano de Obra</option>
                <option value="Llantas">Llantas</option>
                <option value="Otros">Otros</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Marca Referencial</label>
              <input type="text" value={formData.brand} onChange={e => setFormData({...formData, brand: e.target.value})} className="w-full px-3 py-2 border rounded-lg focus:ring-1 focus:ring-blue-500 outline-none text-sm" placeholder="Ej. Genérico, Mobil, Bosch" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1">Compatibilidad (Modelos de Vehículo)</label>
              <input type="text" value={formData.compatibility} onChange={e => setFormData({...formData, compatibility: e.target.value})} className="w-full px-3 py-2 border rounded-lg focus:ring-1 focus:ring-blue-500 outline-none text-sm" placeholder="Ej. Camiones, Autos, Montacargas, Todos" />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-4">
            <button type="button" onClick={() => setIsFormModalOpen(false)} className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg text-sm font-medium">Cancelar</button>
            <button type="submit" className="px-4 py-2 bg-[#002855] text-white rounded-lg hover:bg-blue-900 text-sm font-bold">Guardar</button>
          </div>
        </form>
      </Modal>

    </div>
  )
}