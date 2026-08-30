"use client"
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { AlertTriangle, Search, Eye, Wrench, CheckCircle, Clock } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { toast } from 'sonner'

export default function VehicleFailuresPage() {
  const supabase = createClient()
  const [failures, setFailures] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedRecord, setSelectedRecord] = useState<any>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [statusUpdating, setStatusUpdating] = useState(false)

  useEffect(() => {
    fetchFailures()
  }, [])

  const fetchFailures = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('vehicle_maintenance_records')
        .select('*')
        .order('created_at', { ascending: false })
      
      if (error) throw error
      setFailures(data || [])
    } catch (err: any) {
      toast.error('Error al cargar reportes: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleUpdateStatus = async (id: string, newStatus: string, vehicle_plate: string) => {
    setStatusUpdating(true)
    try {
      const { error } = await supabase
        .from('vehicle_maintenance_records')
        .update({ status: newStatus })
        .eq('id', id)

      if (error) throw error

      toast.success(`Estado actualizado a ${newStatus}`)
      
      if (newStatus === 'EN_MANTENIMIENTO') {
        toast.info(`La unidad ${vehicle_plate} ha sido bloqueada y ya no está disponible para despachos.`)
      } else if (newStatus === 'COMPLETADO' || newStatus === 'DESCARTADO') {
        toast.success(`La unidad ${vehicle_plate} vuelve a estar disponible para despachos.`)
      }

      setIsModalOpen(false)
      fetchFailures()
    } catch (err: any) {
      toast.error('Error al actualizar: ' + err.message)
    } finally {
      setStatusUpdating(false)
    }
  }

  const getStatusBadge = (status: string) => {
    switch(status) {
      case 'PENDIENTE': return <span className="bg-yellow-100 text-yellow-800 px-2 py-1 rounded text-xs font-bold">Pendiente</span>
      case 'EN_REVISION': return <span className="bg-orange-100 text-orange-800 px-2 py-1 rounded text-xs font-bold">En Revisión</span>
      case 'EN_MANTENIMIENTO': return <span className="bg-red-100 text-red-800 px-2 py-1 rounded text-xs font-bold">En Taller</span>
      case 'COMPLETADO': return <span className="bg-green-100 text-green-800 px-2 py-1 rounded text-xs font-bold">Completado</span>
      case 'DESCARTADO': return <span className="bg-slate-100 text-slate-800 px-2 py-1 rounded text-xs font-bold">Descartado</span>
      default: return <span>{status}</span>
    }
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Taller y Mantenimiento</h1>
          <p className="text-slate-500">Gestión de fallas reportadas y vehículos en taller</p>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <div className="p-4 border-b border-slate-200 flex gap-4 bg-slate-50/50 rounded-t-xl">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input 
              type="text"
              placeholder="Buscar por placa..."
              className="w-full pl-9 pr-4 py-2 rounded-lg border-slate-300 text-sm focus:ring-[#002855]"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
              <tr>
                <th className="px-6 py-3">Placa / Unidad</th>
                <th className="px-6 py-3">Tipo de Registro</th>
                <th className="px-6 py-3">Descripción</th>
                <th className="px-6 py-3">Fecha Reporte</th>
                <th className="px-6 py-3">Estado</th>
                <th className="px-6 py-3 text-center">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-slate-500">
                    Cargando reportes...
                  </td>
                </tr>
              ) : failures.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-slate-500">
                    No hay fallas reportadas.
                  </td>
                </tr>
              ) : (
                failures.map((record) => (
                  <tr key={record.id} className="hover:bg-slate-50">
                    <td className="px-6 py-3 font-bold text-[#002855]">{record.vehicle_plate}</td>
                    <td className="px-6 py-3">
                      <span className="text-xs font-semibold bg-slate-100 px-2 py-1 rounded">
                        {record.record_type.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-slate-600 max-w-xs truncate" title={record.description}>
                      {record.description}
                    </td>
                    <td className="px-6 py-3 text-slate-500">
                      {new Date(record.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-3">
                      {getStatusBadge(record.status)}
                    </td>
                    <td className="px-6 py-3 text-center">
                      <button 
                        onClick={() => { setSelectedRecord(record); setIsModalOpen(true); }}
                        className="p-1 text-slate-400 hover:text-[#002855]"
                      >
                        <Eye className="w-5 h-5" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={`Falla - ${selectedRecord?.vehicle_plate}`}>
        {selectedRecord && (
          <div className="space-y-6">
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-slate-500 block text-xs">Unidad</span>
                  <span className="font-bold text-[#002855] text-lg">{selectedRecord.vehicle_plate}</span>
                </div>
                <div>
                  <span className="text-slate-500 block text-xs">Estado Actual</span>
                  <div className="mt-1">{getStatusBadge(selectedRecord.status)}</div>
                </div>
                <div className="col-span-2">
                  <span className="text-slate-500 block text-xs">Descripción del Chofer</span>
                  <p className="mt-1 font-medium">{selectedRecord.description}</p>
                </div>
                {selectedRecord.reported_by && (
                  <div className="col-span-2">
                    <span className="text-slate-500 block text-xs">Reportado Por (ID)</span>
                    <p className="mt-1 text-xs text-slate-600 font-mono">{selectedRecord.reported_by}</p>
                  </div>
                )}
              </div>
            </div>

            <div className="border-t border-slate-200 pt-4">
              <h4 className="font-bold text-slate-800 mb-3">Acciones de Mantenimiento</h4>
              
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => handleUpdateStatus(selectedRecord.id, 'EN_REVISION', selectedRecord.vehicle_plate)}
                  disabled={statusUpdating}
                  className="bg-orange-50 border border-orange-200 text-orange-700 py-2 rounded-lg font-bold flex justify-center items-center gap-2 hover:bg-orange-100 transition-colors"
                >
                  <Clock className="w-4 h-4" /> En Revisión
                </button>
                <button
                  onClick={() => handleUpdateStatus(selectedRecord.id, 'EN_MANTENIMIENTO', selectedRecord.vehicle_plate)}
                  disabled={statusUpdating}
                  className="bg-red-50 border border-red-200 text-red-700 py-2 rounded-lg font-bold flex justify-center items-center gap-2 hover:bg-red-100 transition-colors"
                >
                  <Wrench className="w-4 h-4" /> En Taller (Bloquear)
                </button>
                <button
                  onClick={() => handleUpdateStatus(selectedRecord.id, 'COMPLETADO', selectedRecord.vehicle_plate)}
                  disabled={statusUpdating}
                  className="bg-green-50 border border-green-200 text-green-700 py-2 rounded-lg font-bold flex justify-center items-center gap-2 hover:bg-green-100 transition-colors col-span-2"
                >
                  <CheckCircle className="w-4 h-4" /> Completado (Liberar)
                </button>
                <button
                  onClick={() => handleUpdateStatus(selectedRecord.id, 'DESCARTADO', selectedRecord.vehicle_plate)}
                  disabled={statusUpdating}
                  className="bg-slate-100 border border-slate-200 text-slate-600 py-2 rounded-lg font-bold flex justify-center items-center gap-2 hover:bg-slate-200 transition-colors col-span-2"
                >
                  Falsa Alarma (Descartar)
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
