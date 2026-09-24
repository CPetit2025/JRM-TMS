"use client"
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Plus, Search, BookOpen, Truck, Filter } from 'lucide-react'
import { Modal } from '@/components/ui/modal'

interface SparePart {
  id: string
  code: string
  name: string
  category: string
  unit: string
  current_stock: number
  min_stock: number
  max_stock: number
  unit_cost: number
}

export default function CatalogoMaestroPage() {
  const supabase = createClient()
  const [parts, setParts] = useState<SparePart[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  
  const [isFormModalOpen, setIsFormModalOpen] = useState(false)
  const [selectedPart, setSelectedPart] = useState<SparePart | null>(null)
  
  const [formData, setFormData] = useState({
    code: '',
    name: '',
    category: '',
    unit: 'UNIDAD',
    min_stock: 0,
    max_stock: 0,
    unit_cost: 0
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
      fetchParts()
    } catch (err: any) {
      toast.error('Error: ' + err.message)
    }
  }

  const openNewForm = () => {
    setSelectedPart(null)
    setFormData({
      code: '',
      name: '',
      category: '',
      unit: 'UNIDAD',
      min_stock: 0,
      max_stock: 0,
      unit_cost: 0
    })
    setIsFormModalOpen(true)
  }

  const openEditForm = (part: SparePart) => {
    setSelectedPart(part)
    setFormData({
      code: part.code,
      name: part.name,
      category: part.category || '',
      unit: part.unit || 'UNIDAD',
      min_stock: part.min_stock || 0,
      max_stock: part.max_stock || 0,
      unit_cost: part.unit_cost || 0
    })
    setIsFormModalOpen(true)
  }

  const [filterCategory, setFilterCategory] = useState('TODOS')

  const filtered = parts.filter(p => {
    const matchSearch = searchTerm === '' || 
      p.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
      p.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.category && p.category.toLowerCase().includes(searchTerm.toLowerCase()));
    const matchCategory = filterCategory === 'TODOS' || p.category === filterCategory;
    return matchSearch && matchCategory;
  })

  return (
    <div className="space-y-6 w-full mx-auto">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-[#002855] tracking-tight">Kardex e Inventario</h1>
          <p className="text-sm text-slate-500">Gestión de repuestos, stock y costos.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[250px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input 
              type="text" 
              placeholder="Buscar repuesto..." 
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
            Nuevo Repuesto
          </button>
        </div>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
          <div className="p-3 bg-blue-100 text-blue-600 rounded-lg">
            <BookOpen className="w-6 h-6" />
          </div>
          <div>
            <p className="text-sm font-medium text-slate-500">Total Repuestos</p>
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
                <th className="px-6 py-4 font-semibold">Nombre</th>
                <th className="px-6 py-4 font-semibold">Categoría</th>
                <th className="px-6 py-4 font-semibold">Unidad</th>
                <th className="px-6 py-4 font-semibold text-right">Stock Actual</th>
                <th className="px-6 py-4 font-semibold text-right">Costo Un.</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-slate-500">Cargando inventario...</td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-slate-500 italic">No hay repuestos registrados.</td>
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
                        {part.code}
                      </span>
                    </td>
                    <td className="px-6 py-4 font-bold text-slate-900">{part.name}</td>
                    <td className="px-6 py-4 text-slate-700">{part.category || '-'}</td>
                    <td className="px-6 py-4 text-slate-600">{part.unit}</td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex flex-col items-end">
                        <span className={`font-bold ${part.current_stock <= part.min_stock ? 'text-red-600' : 'text-slate-700'}`}>
                          {part.current_stock}
                        </span>
                        <span className="text-xs text-slate-400">Min: {part.min_stock} / Max: {part.max_stock}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right text-slate-700 font-medium">
                      S/ {Number(part.unit_cost).toFixed(2)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      
      {/* Modal Formularios */}
      <Modal isOpen={isFormModalOpen} onClose={() => setIsFormModalOpen(false)} title={selectedPart ? 'Editar Repuesto' : 'Nuevo Repuesto'} maxWidth="max-w-xl">
        <form onSubmit={handleSavePart} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Código *</label>
              <input required type="text" value={formData.code} onChange={e => setFormData({...formData, code: e.target.value})} className="w-full px-3 py-2 border rounded-lg focus:ring-1 focus:ring-blue-500 outline-none uppercase font-mono text-sm" placeholder="Ej. FIL-001" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Nombre *</label>
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
                <option value="Llantas">Llantas</option>
                <option value="Otros">Otros</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Unidad *</label>
              <input required type="text" value={formData.unit} onChange={e => setFormData({...formData, unit: e.target.value})} className="w-full px-3 py-2 border rounded-lg focus:ring-1 focus:ring-blue-500 outline-none text-sm uppercase" placeholder="Ej. UNIDAD, GALON, LITRO" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Stock Mínimo</label>
              <input type="number" min="0" step="0.01" value={formData.min_stock} onChange={e => setFormData({...formData, min_stock: parseFloat(e.target.value) || 0})} className="w-full px-3 py-2 border rounded-lg focus:ring-1 focus:ring-blue-500 outline-none text-sm" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Stock Máximo</label>
              <input type="number" min="0" step="0.01" value={formData.max_stock} onChange={e => setFormData({...formData, max_stock: parseFloat(e.target.value) || 0})} className="w-full px-3 py-2 border rounded-lg focus:ring-1 focus:ring-blue-500 outline-none text-sm" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1">Costo Unitario (S/)</label>
              <input type="number" min="0" step="0.01" value={formData.unit_cost} onChange={e => setFormData({...formData, unit_cost: parseFloat(e.target.value) || 0})} className="w-full px-3 py-2 border rounded-lg focus:ring-1 focus:ring-blue-500 outline-none text-sm" />
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