"use client"
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Search, Map as MapIcon, Wrench, ShieldAlert, Calendar, DollarSign, Activity, Eye, FileText } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { toast } from 'sonner'

export default function MantenimientoFlotaPage() {
  const supabase = createClient()
  const [vehicles, setVehicles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState("")
  const [selectedVehicle, setSelectedVehicle] = useState<any>(null)
  const [isDetailsModalOpen, setIsDetailsModalOpen] = useState(false)

  useEffect(() => {
    fetchVehicles()
  }, [])

  const fetchVehicles = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('vehicles')
        .select('*, carriers(business_name)')
        .order('plate')
      
      if (error) throw error
      setVehicles(data || [])
    } catch (err: any) {
      toast.error('Error al cargar unidades: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const getStatusColor = (status: string) => {
    switch(status) {
      case 'AL_DIA': return 'bg-green-100 text-green-700'
      case 'PROXIMO': return 'bg-yellow-100 text-yellow-700'
      case 'VENCIDO': return 'bg-red-100 text-red-700'
      default: return 'bg-slate-100 text-slate-700'
    }
  }

  const getOpStatusColor = (status: string) => {
    switch(status) {
      case 'DISPONIBLE': return 'bg-blue-100 text-blue-700'
      case 'MANTENIMIENTO': return 'bg-orange-100 text-orange-700'
      case 'FUERA_DE_SERVICIO': return 'bg-red-100 text-red-700'
      case 'BLOQUEADA': return 'bg-slate-800 text-white'
      default: return 'bg-slate-100 text-slate-700'
    }
  }

  const filteredVehicles = vehicles.filter(v => 
    v.plate.toLowerCase().includes(searchTerm.toLowerCase()) ||
    v.brand?.toLowerCase().includes(searchTerm.toLowerCase())
  )

  const openDetails = (v: any) => {
    setSelectedVehicle(v)
    setIsDetailsModalOpen(true)
  }

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Estado de Flota (Mantenimiento)</h1>
          <p className="text-sm text-slate-500">Vista 360° de la condición operativa de las unidades</p>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <div className="p-4 border-b border-slate-200">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
            <input 
              type="text"
              placeholder="Buscar por placa o marca..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {loading ? (
          <div className="p-8 text-center text-slate-500">Cargando unidades...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-600">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="p-4 font-semibold text-slate-900">Unidad</th>
                  <th className="p-4 font-semibold text-slate-900">Estado Op.</th>
                  <th className="p-4 font-semibold text-slate-900">Mantenimiento</th>
                  <th className="p-4 font-semibold text-slate-900">Kilometraje</th>
                  <th className="p-4 font-semibold text-slate-900">Último Mant.</th>
                  <th className="p-4 font-semibold text-slate-900 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredVehicles.map((v) => (
                  <tr key={v.id} className="hover:bg-slate-50">
                    <td className="p-4">
                      <div className="font-semibold text-slate-900">{v.plate}</div>
                      <div className="text-xs text-slate-500">{v.brand} {v.model}</div>
                    </td>
                    <td className="p-4">
                      <span className={`px-2 py-1 rounded text-xs font-semibold ${getOpStatusColor(v.status)}`}>
                        {v.status}
                      </span>
                    </td>
                    <td className="p-4">
                      <span className={`px-2 py-1 rounded text-xs font-semibold ${getStatusColor(v.maintenance_status)}`}>
                        {v.maintenance_status}
                      </span>
                    </td>
                    <td className="p-4 font-medium">
                      {v.current_mileage?.toLocaleString() || 0} KM
                    </td>
                    <td className="p-4">
                      {v.last_maintenance_date ? new Date(v.last_maintenance_date).toLocaleDateString() : 'N/A'}
                      <div className="text-xs text-slate-500">{v.last_maintenance_mileage ? `${v.last_maintenance_mileage.toLocaleString()} KM` : ''}</div>
                    </td>
                    <td className="p-4 text-right">
                      <button 
                        onClick={() => openDetails(v)}
                        className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                        title="Ver 360°"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
                {filteredVehicles.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-slate-500">
                      No se encontraron unidades.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal isOpen={isDetailsModalOpen} onClose={() => setIsDetailsModalOpen(false)} title={`Vista 360° - ${selectedVehicle?.plate}`}>
        {selectedVehicle && (
          <div className="p-4 space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
                <p className="text-sm text-slate-500 mb-1">Estado Operativo</p>
                <p className={`font-semibold ${getOpStatusColor(selectedVehicle.status).split(' ')[1]}`}>{selectedVehicle.status}</p>
              </div>
              <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
                <p className="text-sm text-slate-500 mb-1">Estado de Mantenimiento</p>
                <p className={`font-semibold ${getStatusColor(selectedVehicle.maintenance_status).split(' ')[1]}`}>{selectedVehicle.maintenance_status}</p>
              </div>
              <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
                <p className="text-sm text-slate-500 mb-1">Kilometraje Actual</p>
                <p className="font-semibold text-slate-900">{selectedVehicle.current_mileage?.toLocaleString() || 0} KM</p>
              </div>
              <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
                <p className="text-sm text-slate-500 mb-1">Costo Acumulado</p>
                <p className="font-semibold text-red-600">S/ {selectedVehicle.accumulated_cost?.toLocaleString() || '0.00'}</p>
              </div>
            </div>

            <div className="border-t border-slate-200 pt-4">
              <h3 className="font-semibold text-slate-900 mb-4 flex items-center gap-2">
                <Wrench className="w-4 h-4" /> Último Mantenimiento
              </h3>
              <p className="text-sm text-slate-600">Fecha: <span className="font-medium text-slate-900">{selectedVehicle.last_maintenance_date ? new Date(selectedVehicle.last_maintenance_date).toLocaleDateString() : 'No registrado'}</span></p>
              <p className="text-sm text-slate-600">Kilometraje: <span className="font-medium text-slate-900">{selectedVehicle.last_maintenance_mileage?.toLocaleString() || 0} KM</span></p>
            </div>
            
            {/* Here we can load history dynamically later */}
            <div className="bg-blue-50 p-4 rounded-lg text-blue-800 text-sm flex items-start gap-3">
              <Activity className="w-5 h-5 shrink-0" />
              <p>El historial de fallas, OTs y documentos se está cargando desde los submódulos correspondientes...</p>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
