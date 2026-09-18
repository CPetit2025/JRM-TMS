"use client"
import { useState, useEffect } from 'react'
import { Truck, Search, Filter, Calendar, MapPin, ChevronRight, Package, Loader2, Share2, ShieldCheck } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'

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

const STATUS_BADGE = {
  'PROGRAMADO': 'bg-yellow-100 text-yellow-800 border-yellow-200',
  'EN_CURSO': 'bg-blue-100 text-blue-800 border-blue-200',
  'EN RUTA': 'bg-blue-100 text-blue-800 border-blue-200',
  'ESPERANDO_AUTORIZACION': 'bg-orange-100 text-orange-800 border-orange-200',
  'RETORNO': 'bg-indigo-100 text-indigo-800 border-indigo-200',
  'LIQUIDADO': 'bg-emerald-100 text-emerald-800 border-emerald-200',
  'ENTREGADO': 'bg-emerald-100 text-emerald-800 border-emerald-200'
} as Record<string, string>

export default function TorreControlPage() {
  const supabase = createClient()
  const [dispatches, setDispatches] = useState<Dispatch[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedDispatch, setSelectedDispatch] = useState<Dispatch | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [statusFilter, setStatusFilter] = useState('ACTIVOS')
  const [dateFilter, setDateFilter] = useState('')

  useEffect(() => {
    fetchDispatches()
  }, [statusFilter, dateFilter])

  useEffect(() => {
    const channel = supabase.channel('torre_control_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dispatches' }, () => {
        fetchDispatches()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [statusFilter, dateFilter])

  const [isSharing, setIsSharing] = useState(false)

  const handleShareTracking = async () => {
    // Tomar fecha del filtro o la fecha actual si está vacío
    const targetDate = dateFilter || new Date().toISOString().split('T')[0]
    setIsSharing(true)
    
    try {
      const { data, error } = await supabase.rpc('generate_daily_tracking_link', {
        p_date: targetDate
      })
      
      if (error) throw error

      if (data && data.length > 0) {
        const { token, pin } = data[0]
        const trackingUrl = `https://jrm-tms.vercel.app/tracking/${token}`
        
        const mailBody = `Estimado equipo,
        
Se adjunta el enlace de seguimiento para la planificación de ruta del día ${targetDate}. Puede realizar el monitoreo en tiempo real de todas las unidades accediendo al siguiente portal de visibilidad.

🔗 Enlace de Seguimiento: ${trackingUrl}
🔑 Contraseña de Acceso: ${pin}
⏱️ Este enlace caducará en 24 horas por motivos de seguridad.

⚠️ Recomendación: Tenga en cuenta que el monitoreo GPS satelital puede presentar breves latencias o discrepancias de señal dependiendo de la cobertura geográfica en ruta.

Saludos cordiales,
Equipo JRM TMS`

        const formattedDate = new Date(`${targetDate}T00:00:00`).toLocaleDateString('es-PE')
        window.open(`mailto:?subject=Seguimiento de Planificación JRM - ${formattedDate}&body=${encodeURIComponent(mailBody)}`, '_blank')
        toast.success('Enlace de planificación generado y copiado al correo.')
      }
    } catch (error: any) {
      toast.error('Error al generar enlace de planificación: ' + error.message)
    } finally {
      setIsSharing(false)
    }
  }

  const fetchDispatches = async () => {
    try {
      setLoading(true)
      let query = supabase
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
        .limit(200)

      if (statusFilter === 'ACTIVOS') {
        query = query.not('status', 'in', '("LIQUIDADO","ENTREGADO")')
      } else if (statusFilter === 'HISTORIAL') {
        query = query.in('status', ['LIQUIDADO', 'ENTREGADO'])
      } else if (statusFilter !== 'TODOS') {
        query = query.eq('status', statusFilter)
      }

      if (dateFilter) {
        query = query.gte('scheduled_departure', `${dateFilter}T00:00:00`).lte('scheduled_departure', `${dateFilter}T23:59:59`)
      }

      const { data, error } = await query

      if (error) throw error
      setDispatches((data || []) as any)
    } catch (err: any) {
      toast.error('Error al cargar torre de control: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const getStatusBadge = (status: string) => {
    const defaultStyle = 'bg-slate-100 text-slate-800 border-slate-200'
    const style = STATUS_BADGE[status] || defaultStyle
    return (
      <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${style}`}>
        {status.replace('_', ' ')}
      </span>
    )
  }

  const formatDate = (isoStr: string) => {
    if (!isoStr) return '-'
    const d = new Date(isoStr)
    return d.toLocaleString('es-PE', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })
  }

  const filteredDispatches = dispatches.filter(d => 
    d.vehicle_plate.toLowerCase().includes(searchTerm.toLowerCase()) ||
    d.driver_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    d.dispatch_number.toLowerCase().includes(searchTerm.toLowerCase())
  )

  return (
    <div className="space-y-6 w-full mx-auto">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Torre de Control</h1>
          <p className="text-sm text-slate-500">Visualización lineal y dinámica de los servicios programados</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="date"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            className="px-3 py-2.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] focus:border-[#002855] outline-none text-slate-600 bg-slate-50"
            title="Filtrar por fecha programada"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] focus:border-[#002855] outline-none text-slate-600 bg-slate-50"
          >
            <option value="ACTIVOS">Activos (En Proceso)</option>
            <option value="HISTORIAL">Historial (Liquidados/Entregados)</option>
            <option value="TODOS">Todos los Estados</option>
            <option value="PROGRAMADO">Solo Programados</option>
            <option value="EN RUTA">Solo En Ruta</option>
          </select>

          <div className="relative flex-1 min-w-[250px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input 
              type="text" 
              placeholder="Buscar placa, conductor o N°..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-2.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] focus:border-[#002855] outline-none transition-all bg-slate-50"
            />
          </div>

          <button 
            onClick={handleShareTracking}
            disabled={isSharing}
            className="flex items-center gap-2 bg-[#002855] text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-[#001f42] transition-colors disabled:opacity-50 shadow-sm"
          >
            {isSharing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />}
            Compartir Planificación
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        <div className="overflow-auto max-h-[calc(100vh-220px)]">
          <table className="w-full text-sm text-left relative">
            <thead className="text-xs text-slate-500 uppercase bg-slate-50 sticky top-0 z-10 shadow-[0_1px_0_0_#e2e8f0] border-slate-200">
              <tr>
                <th className="px-6 py-4 font-semibold">Despacho</th>
                <th className="px-6 py-4 font-semibold">Salida Programada</th>
                <th className="px-6 py-4 font-semibold">Vehículo y Conductor</th>
                <th className="px-6 py-4 font-semibold">Estado</th>
                <th className="px-6 py-4 font-semibold text-center">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-slate-500">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-[#002855]" />
                    Cargando servicios...
                  </td>
                </tr>
              ) : filteredDispatches.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-slate-500 italic">
                    No hay despachos encontrados.
                  </td>
                </tr>
              ) : (
                filteredDispatches.map((dispatch) => (
                  <tr 
                    key={dispatch.id} 
                    className="hover:bg-[#002855]/5 transition-colors cursor-pointer group"
                    onClick={() => setSelectedDispatch(dispatch)}
                  >
                    <td className="px-6 py-4">
                      <div className="flex flex-col">
                        <span className="font-bold text-slate-900">{dispatch.dispatch_number}</span>
                        <span className="text-xs text-slate-500 mt-0.5">
                          {dispatch.dispatch_requests?.length || 0} Solicitudes de Transporte
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-slate-600 font-medium">
                      <div className="flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-slate-400" />
                        {formatDate(dispatch.scheduled_departure)}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2 font-semibold text-[#002855]">
                          <Truck className="w-4 h-4 text-[#002855]" />
                          {dispatch.vehicle_plate}
                        </div>
                        <span className="text-xs text-slate-500 ml-6">{dispatch.driver_name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      {getStatusBadge(dispatch.status)}
                    </td>
                    <td className="px-6 py-4 text-center">
                      <button className="p-2 text-slate-400 group-hover:text-[#002855] hover:bg-slate-200 rounded-full transition-colors">
                        <ChevronRight className="w-5 h-5" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal 
        isOpen={!!selectedDispatch} 
        onClose={() => setSelectedDispatch(null)} 
        title={`Detalle de Despacho: ${selectedDispatch?.dispatch_number}`}
        maxWidth="max-w-4xl"
      >
        {selectedDispatch && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-5 bg-slate-50 rounded-xl border border-slate-200 shadow-inner">
              <div>
                <p className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Vehículo</p>
                <div className="flex items-center gap-2 mt-1">
                  <Truck className="w-4 h-4 text-slate-400" />
                  <p className="font-bold text-[#002855] text-lg">{selectedDispatch.vehicle_plate}</p>
                </div>
              </div>
              <div>
                <p className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Conductor</p>
                <p className="font-semibold text-slate-700 mt-1 line-clamp-1" title={selectedDispatch.driver_name}>{selectedDispatch.driver_name}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Estado Actual</p>
                <div className="mt-1">{getStatusBadge(selectedDispatch.status)}</div>
              </div>
              <div>
                <p className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Salida / Distancia</p>
                <div className="mt-1 flex flex-col">
                  <span className="font-semibold text-slate-700 text-sm">{formatDate(selectedDispatch.scheduled_departure)}</span>
                  <span className="text-xs text-slate-500">{selectedDispatch.estimated_distance_km ? `${selectedDispatch.estimated_distance_km} KM` : 'N/A'}</span>
                </div>
              </div>
            </div>

            <div>
              <h3 className="font-bold text-slate-800 mb-4 text-sm border-b border-slate-100 pb-2 flex items-center justify-between">
                <span>Rutas y Entregas Asociadas</span>
                <span className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full text-xs">
                  {selectedDispatch.dispatch_requests?.length || 0} Solicitudes
                </span>
              </h3>
              
              {selectedDispatch.dispatch_requests?.length === 0 ? (
                <div className="text-center py-6 text-slate-400 bg-slate-50 rounded-lg border border-dashed border-slate-200">
                  No hay rutas asociadas a este despacho.
                </div>
              ) : (
                <div className="grid gap-3">
                  {selectedDispatch.dispatch_requests?.map((req, idx) => (
                    <div key={idx} className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm hover:shadow-md transition-all relative overflow-hidden group">
                      <div className="absolute left-0 top-0 bottom-0 w-1 bg-[#002855] opacity-80"></div>
                      <div className="flex justify-between items-center mb-3 pl-2">
                        <span className="font-bold text-slate-900 text-sm">
                          {req.transport_requests.request_number}
                        </span>
                        <span className="text-[10px] bg-slate-100 text-slate-600 px-2.5 py-1 rounded-full font-bold uppercase tracking-wide border border-slate-200">
                          {req.status}
                        </span>
                      </div>
                      
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pl-2">
                        <div className="flex gap-3 items-start">
                          <div className="bg-blue-50 p-2 rounded-full mt-1 border border-blue-100">
                            <MapPin className="w-4 h-4 text-blue-600" />
                          </div>
                          <div>
                            <p className="text-[10px] uppercase font-bold text-slate-400">Punto de Recojo (Origen)</p>
                            <p className="text-sm font-medium text-slate-700 mt-0.5 line-clamp-2" title={req.transport_requests.pickup_address}>
                              {req.transport_requests.pickup_address}
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-3 items-start">
                          <div className="bg-emerald-50 p-2 rounded-full mt-1 border border-emerald-100">
                            <MapPin className="w-4 h-4 text-emerald-600" />
                          </div>
                          <div>
                            <p className="text-[10px] uppercase font-bold text-slate-400">Punto de Entrega (Destino)</p>
                            <p className="text-sm font-medium text-slate-700 mt-0.5 line-clamp-2" title={req.transport_requests.delivery_address}>
                              {req.transport_requests.delivery_address}
                            </p>
                          </div>
                        </div>
                      </div>
                      
                      {req.transport_requests.requester_name && (
                        <div className="mt-3 pl-2 pt-3 border-t border-slate-100 text-xs text-slate-500 flex justify-between items-center">
                          <span><strong>Solicitante:</strong> {req.transport_requests.requester_name}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
