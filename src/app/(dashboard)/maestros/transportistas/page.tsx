'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Truck, Plus, Search, Building2, Save, X, Edit, Ban, CheckCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'

export default function TransportistasPage() {
  const [carriers, setCarriers] = useState<any[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  
  // Modal states
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [form, setForm] = useState({
    id: '',
    business_name: '',
    tax_id: '',
    type: 'PROVEEDOR',
    contact_phone: '',
    is_active: true
  })

  const supabase = createClient()

  useEffect(() => {
    fetchCarriers()
  }, [])

  const fetchCarriers = async () => {
    setIsLoading(true)
    try {
      const { data, error } = await supabase
        .from('carriers')
        .select('*')
        .order('business_name')
      
      if (error) throw error
      setCarriers(data || [])
    } catch (e: any) {
      toast.error('Error al cargar transportistas: ' + e.message)
    } finally {
      setIsLoading(false)
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    try {
      if (form.id) {
        const { error } = await supabase.from('carriers').update({
          business_name: form.business_name,
          tax_id: form.tax_id,
          type: form.type,
          contact_phone: form.contact_phone,
          is_active: form.is_active
        }).eq('id', form.id)
        if (error) throw error
        toast.success('Transportista actualizado')
      } else {
        const { error } = await supabase.from('carriers').insert([{
          business_name: form.business_name,
          tax_id: form.tax_id,
          type: form.type,
          contact_phone: form.contact_phone,
          is_active: form.is_active
        }])
        if (error) throw error
        toast.success('Transportista registrado')
      }
      setIsModalOpen(false)
      fetchCarriers()
    } catch (e: any) {
      toast.error('Error al guardar: ' + e.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const openNew = () => {
    setForm({
      id: '',
      business_name: '',
      tax_id: '',
      type: 'PROVEEDOR',
      contact_phone: '',
      is_active: true
    })
    setIsModalOpen(true)
  }

  const openEdit = (carrier: any) => {
    setForm({
      id: carrier.id,
      business_name: carrier.business_name,
      tax_id: carrier.tax_id,
      type: carrier.type,
      contact_phone: carrier.contact_phone || '',
      is_active: carrier.is_active
    })
    setIsModalOpen(true)
  }

  const toggleStatus = async (id: string, currentStatus: boolean) => {
    try {
      const { error } = await supabase.from('carriers').update({ is_active: !currentStatus }).eq('id', id)
      if (error) throw error
      toast.success(currentStatus ? 'Proveedor suspendido' : 'Proveedor activado')
      fetchCarriers()
    } catch (e: any) {
      toast.error('Error al cambiar estado: ' + e.message)
    }
  }

  const filtered = carriers.filter(c => 
    c.business_name?.toLowerCase().includes(searchTerm.toLowerCase()) || 
    c.tax_id?.includes(searchTerm)
  )

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <Building2 className="w-8 h-8 text-blue-600" />
            Proveedores de Transporte
          </h1>
          <p className="text-slate-500">
            Gestión de dueños de camiones, asociados y subcontratistas.
          </p>
        </div>
        
        <button 
          onClick={openNew}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium shadow-lg shadow-blue-500/20"
        >
          <Plus className="w-5 h-5" />
          Registrar Proveedor
        </button>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        <div className="p-4 border-b border-slate-100 flex flex-col md:flex-row gap-4 items-center justify-between">
          <div className="relative w-full md:max-w-md">
            <Search className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input 
              type="text"
              placeholder="Buscar por Razón Social o RUC..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none transition-all"
            />
          </div>
          <span className="text-sm font-medium text-slate-500 bg-slate-100 px-3 py-1 rounded-full">
            {filtered.length} Registros
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-500 font-medium">
              <tr>
                <th className="px-6 py-4">RUC</th>
                <th className="px-6 py-4">Razón Social</th>
                <th className="px-6 py-4">Tipo</th>
                <th className="px-6 py-4">Teléfono</th>
                <th className="px-6 py-4">Estado</th>
                <th className="px-6 py-4 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-slate-500">Cargando...</td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-slate-500">No se encontraron resultados.</td>
                </tr>
              ) : (
                filtered.map(c => (
                  <tr key={c.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="px-6 py-4 font-mono font-medium text-slate-700">{c.tax_id}</td>
                    <td className="px-6 py-4 font-bold text-slate-900">{c.business_name}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-semibold ${c.type === 'PROPIO' ? 'bg-indigo-100 text-indigo-700' : 'bg-blue-100 text-blue-700'}`}>
                        {c.type}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-slate-600">{c.contact_phone || '-'}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-semibold ${c.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        {c.is_active ? 'ACTIVO' : 'INACTIVO'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button 
                          onClick={() => openEdit(c)}
                          className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                          title="Editar"
                        >
                          <Edit className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={() => toggleStatus(c.id, c.is_active)}
                          className={`p-2 rounded-lg transition-colors ${
                            c.is_active 
                              ? 'text-slate-400 hover:text-red-600 hover:bg-red-50' 
                              : 'text-slate-400 hover:text-green-600 hover:bg-green-50'
                          }`}
                          title={c.is_active ? "Suspender" : "Activar"}
                        >
                          {c.is_active ? <Ban className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal isOpen={isModalOpen} onClose={() => !isSubmitting && setIsModalOpen(false)} title={form.id ? "Editar Proveedor" : "Registrar Proveedor"}>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">RUC *</label>
            <input 
              required
              maxLength={20}
              type="text" 
              value={form.tax_id} 
              onChange={e => setForm({...form, tax_id: e.target.value})} 
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 outline-none" 
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">Razón Social *</label>
            <input 
              required
              maxLength={200}
              type="text" 
              value={form.business_name} 
              onChange={e => setForm({...form, business_name: e.target.value})} 
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 outline-none" 
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Tipo de Empresa</label>
              <select 
                value={form.type} 
                onChange={e => setForm({...form, type: e.target.value})} 
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 outline-none"
              >
                <option value="PROVEEDOR">Proveedor (Subcontratista)</option>
                <option value="PROPIO">Empresa Propia</option>
              </select>
            </div>
            
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Teléfono (Opcional)</label>
              <input 
                maxLength={20}
                type="text" 
                value={form.contact_phone} 
                onChange={e => setForm({...form, contact_phone: e.target.value})} 
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 outline-none" 
              />
            </div>
          </div>

          <div className="flex items-center gap-2 pt-2">
            <input 
              type="checkbox" 
              id="is_active"
              checked={form.is_active} 
              onChange={e => setForm({...form, is_active: e.target.checked})} 
              className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4"
            />
            <label htmlFor="is_active" className="text-sm font-medium text-slate-700">Proveedor Activo</label>
          </div>

          <div className="pt-4 flex justify-end gap-3">
            <button type="button" onClick={() => setIsModalOpen(false)} className="px-4 py-2 text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200">
              Cancelar
            </button>
            <button type="submit" disabled={isSubmitting} className="px-6 py-2 bg-blue-600 text-white rounded-lg flex items-center gap-2 hover:bg-blue-700">
              <Save className="w-4 h-4" />
              {isSubmitting ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
