"use client"
import { useState, useEffect } from 'react'
import { Truck, Loader2, MapPin, Package, AlertTriangle, CheckCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { usePermissions } from '@/hooks/usePermissions'

interface DispatchRequest {
  transport_request_id: string
  status: string
  transport_requests: {
    request_number: string
    pickup_address: string
    delivery_address: string
    requester_name: string
  }
}

interface Dispatch {
  id: string
  dispatch_number: string
  driver_name: string
  vehicle_plate: string
  status: string
  estimated_distance_km: number
  scheduled_departure: string
  dispatch_requests?: DispatchRequest[]
}

const KANBAN_COLUMNS = [
  { id: 'PROGRAMADO', title: 'Programado', color: 'border-yellow-200', bg: 'bg-yellow-50', text: 'text-yellow-700' },
  { id: 'EN_CURSO', title: 'En Ruta', color: 'border-blue-200', bg: 'bg-blue-50', text: 'text-blue-700' },
  { id: 'ESPERANDO_AUTORIZACION', title: 'Esperando Aut.', color: 'border-orange-200', bg: 'bg-orange-50', text: 'text-orange-700' },
  { id: 'RETORNO', title: 'Retorno', color: 'border-indigo-200', bg: 'bg-indigo-50', text: 'text-indigo-700' },
  { id: 'LIQUIDADO', title: 'Liquidado/Entregado', color: 'border-green-200', bg: 'bg-green-50', text: 'text-green-700' }
]

export default function TorreControlPage() {
  const supabase = createClient()
  const [dispatches, setDispatches] = useState<Dispatch[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchDispatches()

    // Real-time updates
    const channel = supabase.channel('torre_control_changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'dispatches' },
        (payload) => {
          fetchDispatches() // Refresh on any change
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  const fetchDispatches = async () => {
    try {
      const { data, error } = await supabase
        .from('dispatches')
        .select(`
          id, dispatch_number, driver_name, vehicle_plate, status, estimated_distance_km, scheduled_departure,
          dispatch_requests (
            status,
            transport_request_id,
            transport_requests (
              request_number,
              pickup_address,
              delivery_address,
              requester_name
            )
          )
        `)
        .order('scheduled_departure', { ascending: false })
        .limit(50)

      if (error) throw error
      
      // Mapear EN RUTA a EN_CURSO para la columna visual (o mantenerlo según como venga)
      const mapped = (data || []).map(d => ({
        ...d,
        status: d.status === 'EN RUTA' ? 'EN_CURSO' : d.status
      }))
      
      setDispatches(mapped as any)
    } catch (err: any) {
      toast.error('Error al cargar torre de control: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const getDispatchesByStatus = (status: string) => {
    if (status === 'LIQUIDADO') {
      return dispatches.filter(d => d.status === 'LIQUIDADO' || d.status === 'ENTREGADO')
    }
    return dispatches.filter(d => d.status === status)
  }

  return (
    <div className="space-y-6 w-full mx-auto h-[calc(100vh-100px)] flex flex-col">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Torre de Control</h1>
        <p className="text-sm text-slate-500">Visualización en tiempo real de los servicios programados</p>
      </div>

      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        {loading ? (
          <div className="flex justify-center items-center h-full text-slate-500">
            <Loader2 className="w-8 h-8 animate-spin" />
          </div>
        ) : (
          <div className="flex gap-4 h-full min-w-max pb-4">
            {KANBAN_COLUMNS.map(col => {
              const columnDispatches = getDispatchesByStatus(col.id)
              return (
                <div key={col.id} className="flex flex-col w-[320px] bg-slate-50 rounded-xl border border-slate-200 overflow-hidden flex-shrink-0">
                  <div className={`p-3 border-b border-slate-200 ${col.bg} flex justify-between items-center`}>
                    <h3 className={`font-bold text-sm ${col.text}`}>{col.title}</h3>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full bg-white/50 border ${col.color}`}>
                      {columnDispatches.length}
                    </span>
                  </div>
                  
                  <div className="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar">
                    {columnDispatches.length === 0 ? (
                      <div className="text-center text-slate-400 text-sm py-4 italic">
                        Sin despachos
                      </div>
                    ) : (
                      columnDispatches.map(dispatch => (
                        <div key={dispatch.id} className={`bg-white p-3 rounded-lg border-l-4 border ${col.color} shadow-sm flex flex-col gap-2 hover:shadow-md transition-shadow cursor-default`}>
                          <div className="flex justify-between items-start">
                            <span className="font-bold text-[#002855] text-sm">{dispatch.dispatch_number}</span>
                            <span className="text-[10px] font-semibold text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                              {dispatch.estimated_distance_km ? `${dispatch.estimated_distance_km} KM` : '-'}
                            </span>
                          </div>
                          
                          <div className="text-xs text-slate-600 flex flex-col gap-1">
                            <div className="flex items-center gap-1.5">
                              <Truck className="w-3.5 h-3.5 text-slate-400" />
                              <span className="font-medium text-slate-700">{dispatch.vehicle_plate}</span>
                              <span className="text-slate-300">|</span>
                              <span className="truncate" title={dispatch.driver_name}>{dispatch.driver_name}</span>
                            </div>
                          </div>
                          
                          <div className="mt-2 space-y-2">
                            {(dispatch.dispatch_requests || []).map((req, idx) => (
                              <div key={idx} className="bg-slate-50 p-2 rounded border border-slate-100 text-[10px]">
                                <div className="font-semibold text-[#002855] mb-1">
                                  {req.transport_requests.request_number}
                                </div>
                                <div className="flex flex-col gap-0.5 text-slate-500">
                                  <div className="flex items-start gap-1 truncate" title={req.transport_requests.pickup_address}>
                                    <MapPin className="w-3 h-3 text-blue-400 flex-shrink-0" />
                                    <span>{req.transport_requests.pickup_address}</span>
                                  </div>
                                  <div className="flex items-start gap-1 truncate" title={req.transport_requests.delivery_address}>
                                    <MapPin className="w-3 h-3 text-red-400 flex-shrink-0" />
                                    <span>{req.transport_requests.delivery_address}</span>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
        .custom-scrollbar:hover::-webkit-scrollbar-thumb { background: #94a3b8; }
      `}} />
    </div>
  )
}
