'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { FileSignature, Plus, Search, Calendar, DollarSign, Activity, AlertCircle, Edit, Save, X } from 'lucide-react'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { SearchableSelect } from '@/components/ui/SearchableSelect'

export default function ContratosAlquilerPage() {
  const [contracts, setContracts] = useState<any[]>([])
  const [vehicles, setVehicles] = useState<any[]>([])
  const [providers, setProviders] = useState<any[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')

  const supabase = createClient()

  const [form, setForm] = useState({
    vehicle_id: '',
    provider_id: '',
    monthly_base_fee: '3676.92',
    included_km: '3900',
    excess_km_rate: '1.00',
    guaranteed_km: '2000',
    start_date: new Date().toISOString().split('T')[0],
    end_date: '',
    status: 'ACTIVO'
  })

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    try {
      setIsLoading(true)
      
      const [contRes, vehRes, provRes] = await Promise.all([
        supabase.from('vehicle_lease_contracts').select('*, vehicles(plate), carriers(business_name)').order('created_at', { ascending: false }),
        supabase.from('vehicles').select('id, plate').order('plate'),
        supabase.from('carriers').select('id, business_name').neq('type', 'PROPIO').eq('is_active', true).order('business_name')
      ])
      
      setContracts(contRes.data || [])
      setVehicles(vehRes.data || [])
      setProviders(provRes.data || [])
    } catch (e) {
      console.error(e)
      toast.error('Error al cargar datos')
    } finally {
      setIsLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    try {
      const { error } = await supabase.from('vehicle_lease_contracts').insert([{
        vehicle_id: form.vehicle_id,
        provider_id: form.provider_id,
        monthly_base_fee: parseFloat(form.monthly_base_fee),
        included_km: parseInt(form.included_km),
        excess_km_rate: parseFloat(form.excess_km_rate),
        guaranteed_km: parseInt(form.guaranteed_km),
        start_date: form.start_date,
        end_date: form.end_date || null,
        status: form.status
      }])

      if (error) throw error
      toast.success('Contrato registrado correctamente')
      setIsModalOpen(false)
      fetchData()
    } catch (e: any) {
      toast.error('Error al guardar: ' + e.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const filtered = contracts.filter(c => 
    c.vehicles?.plate?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.carriers?.business_name?.toLowerCase().includes(searchTerm.toLowerCase())
  )

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <FileSignature className="w-8 h-8 text-blue-600" />
            Contratos de Alquiler en Seco
          </h1>
          <p className="text-slate-500">
            Acuerdos de unidades subcontratadas.
          </p>
        </div>
        
        <button 
          onClick={() => setIsModalOpen(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium shadow-lg shadow-blue-500/20"
        >
          <Plus className="w-5 h-5" />
          Registrar Contrato
        </button>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        <div className="p-4 border-b border-slate-100">
          <div className="relative max-w-md">
            <Search className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input 
              type="text"
              placeholder="Buscar por placa o proveedor..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none transition-all"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-500 font-medium">
              <tr>
                <th className="px-6 py-4">Vehículo</th>
                <th className="px-6 py-4">Proveedor</th>
                <th className="px-6 py-4">Tarifa Base (S/)</th>
                <th className="px-6 py-4">KM Incluidos</th>
                <th className="px-6 py-4">KM Garantizado</th>
                <th className="px-6 py-4">Exceso (S//KM)</th>
                <th className="px-6 py-4">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center text-slate-500">Cargando...</td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center text-slate-500">No se encontraron contratos.</td>
                </tr>
              ) : (
                filtered.map(c => (
                  <tr key={c.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="px-6 py-4 font-bold text-slate-900">{c.vehicles?.plate}</td>
                    <td className="px-6 py-4 text-slate-700">{c.carriers?.business_name}</td>
                    <td className="px-6 py-4 font-mono text-blue-600 font-medium">S/ {c.monthly_base_fee.toFixed(2)}</td>
                    <td className="px-6 py-4 font-mono">{c.included_km}</td>
                    <td className="px-6 py-4 font-mono text-slate-500">{c.guaranteed_km}</td>
                    <td className="px-6 py-4 font-mono text-red-500">S/ {c.excess_km_rate.toFixed(2)}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-semibold ${c.status === 'ACTIVO' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-700'}`}>
                        {c.status}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal isOpen={isModalOpen} onClose={() => !isSubmitting && setIsModalOpen(false)} title="Registrar Contrato de Alquiler">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Vehículo *</label>
              <SearchableSelect
                value={form.vehicle_id}
                onChange={val => setForm({...form, vehicle_id: val})}
                options={vehicles.map(v => ({ value: v.id, label: v.plate }))}
                placeholder="Seleccionar..."
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Proveedor *</label>
              <SearchableSelect
                value={form.provider_id}
                onChange={val => setForm({...form, provider_id: val})}
                options={providers.map(p => ({ value: p.id, label: p.business_name }))}
                placeholder="Seleccionar..."
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Tarifa Mensual (S/) *</label>
              <input required type="number" step="0.01" value={form.monthly_base_fee} onChange={e => setForm({...form, monthly_base_fee: e.target.value})} className="w-full px-3 py-2 border rounded-lg" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">KM Incluidos *</label>
              <input required type="number" value={form.included_km} onChange={e => setForm({...form, included_km: e.target.value})} className="w-full px-3 py-2 border rounded-lg" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Garantía KM *</label>
              <input required type="number" value={form.guaranteed_km} onChange={e => setForm({...form, guaranteed_km: e.target.value})} className="w-full px-3 py-2 border rounded-lg" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Tarifa Exceso (S//KM) *</label>
              <input required type="number" step="0.01" value={form.excess_km_rate} onChange={e => setForm({...form, excess_km_rate: e.target.value})} className="w-full px-3 py-2 border rounded-lg" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Fecha Inicio *</label>
              <input required type="date" value={form.start_date} onChange={e => setForm({...form, start_date: e.target.value})} className="w-full px-3 py-2 border rounded-lg" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Fecha Fin (Opcional)</label>
              <input type="date" value={form.end_date} onChange={e => setForm({...form, end_date: e.target.value})} className="w-full px-3 py-2 border rounded-lg" />
            </div>
          </div>

          <div className="pt-4 flex justify-end gap-3">
            <button type="button" onClick={() => setIsModalOpen(false)} className="px-4 py-2 text-slate-600 bg-slate-100 rounded-lg">Cancelar</button>
            <button type="submit" disabled={isSubmitting} className="px-6 py-2 bg-blue-600 text-white rounded-lg flex items-center gap-2">
              <Save className="w-4 h-4" />
              {isSubmitting ? 'Guardando...' : 'Guardar Contrato'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
