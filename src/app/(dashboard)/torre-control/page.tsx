"use client"
import { useState, useEffect, useMemo } from 'react'
import { Truck, Search, Calendar, MapPin, ChevronRight, Loader2, Share2, AlertTriangle, CheckCircle2, Clock, Route, Activity } from 'lucide-react'
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
  dispatch_events?: { event_type: string, description: string, created_at: string, created_by: string }[]
}

const STATUS_BADGE = {
  'PROGRAMADO': 'bg-slate-100 text-slate-700 border-slate-200',
  'EN_CURSO': 'bg-[#002855]/10 text-[#002855] border-[#002855]/20',
  'EN RUTA': 'bg-[#002855]/10 text-[#002855] border-[#002855]/20',
  'ESPERANDO_AUTORIZACION': 'bg-orange-50 text-orange-700 border-orange-200',
  'RETORNO': 'bg-indigo-50 text-indigo-700 border-indigo-200',
  'LIQUIDADO': 'bg-emerald-50 text-emerald-700 border-emerald-200',
  'ENTREGADO': 'bg-emerald-50 text-emerald-700 border-emerald-200'
} as Record<string, string>

export default function TorreControlPage() {
  const supabase = createClient()
  const [dispatches, setDispatches] = useState<Dispatch[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedDispatch, setSelectedDispatch] = useState<Dispatch | null>(null)

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('jrm:context', { detail: selectedDispatch ? { dispatchId: selectedDispatch.id } : {} }))
  }, [selectedDispatch])
  
  // Filters
  const [searchTerm, setSearchTerm] = useState('')
  const [statusFilter, setStatusFilter] = useState('ACTIVOS')
  const [dateFilter, setDateFilter] = useState('')
  const [onlyAlerts, setOnlyAlerts] = useState(false)

  const [isSharing, setIsSharing] = useState(false)

  useEffect(() => {
    fetchDispatches()
  }, [statusFilter, dateFilter])

  useEffect(() => {
    const channel = supabase.channel('torre_control_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dispatches' }, () => {
        fetchDispatches()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dispatch_events' }, () => {
        fetchDispatches()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [statusFilter, dateFilter])

  const handleShareTracking = async () => {
    const targetDate = dateFilter || new Date().toISOString().split('T')[0]
    setIsSharing(true)
    
    try {
      const { data, error } = await supabase.rpc('generate_daily_tracking_link', { p_date: targetDate })
      if (error) throw error

      if (data && data.length > 0) {
        const { token, pin } = data[0]
        const trackingUrl = `https://jrm-tms.vercel.app/tracking/${token}`
        
        const mailBody = `Estimado equipo,
        
Se adjunta el enlace de seguimiento operativo del día ${targetDate}. Acceda al portal de visibilidad GPS:

🔗 Enlace Seguro: ${trackingUrl}
🔑 PIN de Acceso: ${pin}

⏱️ Este enlace caducará en 24 horas.

Saludos cordiales,
Equipo JRM TMS`

        const formattedDate = new Date(`${targetDate}T00:00:00`).toLocaleDateString('es-PE')
        window.open(`mailto:?subject=Visibilidad de Operaciones JRM - ${formattedDate}&body=${encodeURIComponent(mailBody)}`, '_blank')
        toast.success('Enlace generado y copiado al correo.')
      }
    } catch (error: any) {
      toast.error('Error al generar enlace: ' + error.message)
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
          ),
          dispatch_events (
            event_type,
            description,
            created_at,
            created_by
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

  const getLatestEvent = (events: any[]) => {
    if (!events || events.length === 0) return null;
    return [...events].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
  }

  const hasAlertEvent = (events: any[]) => {
    if (!events || events.length === 0) return false;
    // Buscamos si en las últimas 12 horas hubo una alerta que no haya sido resuelta (para simplificar, si el último evento es alerta)
    const latest = getLatestEvent(events);
    return latest && (latest.event_type === 'INCIDENCIA' || latest.event_type === 'RETRASO' || latest.event_type === 'DESVIO');
  }

  const formatDate = (isoStr: string) => {
    if (!isoStr) return '-'
    const d = new Date(isoStr)
    return d.toLocaleString('es-PE', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })
  }

  // Derived state for KPIs and Filters
  const { filteredDispatches, kpis } = useMemo(() => {
    const todayStr = new Date().toISOString().split('T')[0]
    
    let kpiProgramados = 0
    let kpiEnCurso = 0
    let kpiCompletadosHoy = 0
    let kpiAlertas = 0

    const filtered = dispatches.filter(d => {
      // Calculate KPIs (independently of search term, but dependent on loaded data)
      if (d.status === 'PROGRAMADO') kpiProgramados++
      if (d.status === 'EN_CURSO' || d.status === 'EN RUTA' || d.status === 'RETORNO') kpiEnCurso++
      if ((d.status === 'ENTREGADO' || d.status === 'LIQUIDADO') && d.scheduled_departure.startsWith(todayStr)) kpiCompletadosHoy++
      
      const isAlert = hasAlertEvent(d.dispatch_events || [])
      if (isAlert && d.status !== 'LIQUIDADO' && d.status !== 'ENTREGADO') kpiAlertas++

      // Apply Filters
      if (onlyAlerts && !isAlert) return false

      const searchLower = searchTerm.toLowerCase()
      if (searchTerm && !(
        d.vehicle_plate.toLowerCase().includes(searchLower) ||
        d.driver_name.toLowerCase().includes(searchLower) ||
        d.dispatch_number.toLowerCase().includes(searchLower)
      )) {
        return false
      }

      return true
    })

    return { filteredDispatches: filtered, kpis: { kpiProgramados, kpiEnCurso, kpiCompletadosHoy, kpiAlertas } }
  }, [dispatches, searchTerm, onlyAlerts])


  const getStatusBadge = (status: string) => {
    const defaultStyle = 'bg-slate-50 text-slate-600 border-slate-200'
    const style = STATUS_BADGE[status] || defaultStyle
    return (
      <span className={`px-2.5 py-1 rounded-md text-[11px] font-bold tracking-wide uppercase border ${style}`}>
        {status.replace('_', ' ')}
      </span>
    )
  }

  return (
    <div className="space-y-6 w-full mx-auto pb-10">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Torre de Control</h1>
          <p className="text-sm text-slate-500 mt-1">Supervisión operativa y telemetría de flota en tiempo real.</p>
        </div>
        <button 
          onClick={handleShareTracking}
          disabled={isSharing}
          className="flex items-center gap-2 bg-white text-[#002855] border border-[#002855] px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-slate-50 transition-colors disabled:opacity-50 shadow-sm"
        >
          {isSharing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />}
          Compartir Visibilidad
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Programados</p>
            <p className="text-3xl font-black text-slate-800 mt-1">{kpis.kpiProgramados}</p>
          </div>
          <div className="w-12 h-12 bg-slate-50 rounded-full flex items-center justify-center border border-slate-100">
            <Calendar className="w-6 h-6 text-slate-400" />
          </div>
        </div>
        
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-bold text-[#002855] uppercase tracking-wider">En Ruta</p>
            <p className="text-3xl font-black text-[#002855] mt-1">{kpis.kpiEnCurso}</p>
          </div>
          <div className="w-12 h-12 bg-[#002855]/5 rounded-full flex items-center justify-center border border-[#002855]/10">
            <Route className="w-6 h-6 text-[#002855]" />
          </div>
        </div>

        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-bold text-emerald-600 uppercase tracking-wider">Completados Hoy</p>
            <p className="text-3xl font-black text-emerald-700 mt-1">{kpis.kpiCompletadosHoy}</p>
          </div>
          <div className="w-12 h-12 bg-emerald-50 rounded-full flex items-center justify-center border border-emerald-100">
            <CheckCircle2 className="w-6 h-6 text-emerald-500" />
          </div>
        </div>

        <div className={`p-5 rounded-xl border shadow-sm flex items-center justify-between transition-colors ${kpis.kpiAlertas > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-slate-200'}`}>
          <div>
            <p className={`text-xs font-bold uppercase tracking-wider ${kpis.kpiAlertas > 0 ? 'text-red-600' : 'text-slate-500'}`}>Alertas Activas</p>
            <p className={`text-3xl font-black mt-1 ${kpis.kpiAlertas > 0 ? 'text-red-700' : 'text-slate-800'}`}>{kpis.kpiAlertas}</p>
          </div>
          <div className={`w-12 h-12 rounded-full flex items-center justify-center border ${kpis.kpiAlertas > 0 ? 'bg-red-100 border-red-200' : 'bg-slate-50 border-slate-100'}`}>
            <AlertTriangle className={`w-6 h-6 ${kpis.kpiAlertas > 0 ? 'text-red-600' : 'text-slate-400'}`} />
          </div>
        </div>
      </div>

      {/* Advanced Filters */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-wrap items-center gap-4">
        <div className="relative flex-1 min-w-[250px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input 
            type="text" 
            placeholder="Buscar por placa, conductor o N° de despacho..." 
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-4 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#002855] focus:border-[#002855] outline-none transition-all bg-slate-50"
          />
        </div>
        
        <div className="flex items-center gap-3 border-l border-slate-200 pl-4">
          <input
            type="date"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#002855] focus:border-[#002855] outline-none text-slate-600 bg-slate-50"
            title="Fecha Programada"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#002855] focus:border-[#002855] outline-none text-slate-600 bg-slate-50 font-medium"
          >
            <option value="ACTIVOS">Operación Activa</option>
            <option value="HISTORIAL">Historial (Finalizados)</option>
            <option value="TODOS">Todos los Estados</option>
            <option value="PROGRAMADO">Solo Programados</option>
          </select>
          
          <label className="flex items-center gap-2 cursor-pointer bg-slate-50 px-3 py-2 rounded-lg border border-slate-200 hover:bg-slate-100 transition-colors">
            <input 
              type="checkbox" 
              className="rounded text-red-600 focus:ring-red-500 w-4 h-4 accent-red-600"
              checked={onlyAlerts}
              onChange={(e) => setOnlyAlerts(e.target.checked)}
            />
            <span className="text-sm font-semibold text-slate-700">Solo Alertas</span>
          </label>
        </div>
      </div>

      {/* Main Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        <div className="overflow-auto max-h-[600px]">
          <table className="w-full text-sm text-left relative">
            <thead className="text-[11px] text-slate-500 uppercase tracking-wider bg-slate-50 sticky top-0 z-10 border-b border-slate-200">
              <tr>
                <th className="px-6 py-4 font-bold">Despacho</th>
                <th className="px-6 py-4 font-bold">Cronograma</th>
                <th className="px-6 py-4 font-bold">Último Reporte GPS</th>
                <th className="px-6 py-4 font-bold">Recurso Asignado</th>
                <th className="px-6 py-4 font-bold">Estado Actual</th>
                <th className="px-6 py-4 font-bold text-center"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                    <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-[#002855]" />
                    <p className="font-medium">Sincronizando telemetría...</p>
                  </td>
                </tr>
              ) : filteredDispatches.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                    <Activity className="w-8 h-8 mx-auto mb-3 text-slate-300" />
                    <p className="font-medium">No se encontraron operaciones con los filtros actuales.</p>
                  </td>
                </tr>
              ) : (
                filteredDispatches.map((dispatch) => {
                  const latestEvent = getLatestEvent(dispatch.dispatch_events || []);
                  const isAlert = latestEvent && (latestEvent.event_type === 'INCIDENCIA' || latestEvent.event_type === 'RETRASO' || latestEvent.event_type === 'DESVIO');

                  return (
                    <tr 
                      key={dispatch.id} 
                      className={`hover:bg-slate-50 transition-colors cursor-pointer group ${isAlert && dispatch.status !== 'LIQUIDADO' ? 'bg-red-50/30' : ''}`}
                      onClick={() => setSelectedDispatch(dispatch)}
                    >
                      <td className="px-6 py-4">
                        <div className="flex flex-col">
                          <span className="font-bold text-slate-900">{dispatch.dispatch_number}</span>
                          <span className="text-[11px] font-medium text-slate-500 mt-0.5">
                            {dispatch.dispatch_requests?.length || 0} OTs asignadas
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col">
                          <span className="text-slate-700 font-semibold text-xs">Salida:</span>
                          <span className="text-slate-600 text-sm">{formatDate(dispatch.scheduled_departure)}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        {!latestEvent ? (
                          <span className="text-xs text-slate-400 italic">Esperando telemetría...</span>
                        ) : (
                          <div className="flex flex-col max-w-[250px]">
                            <div className="flex items-center gap-2 mb-1">
                              <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-md border ${isAlert ? 'bg-red-50 text-red-700 border-red-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                                {latestEvent.event_type.replace('_', ' ')}
                              </span>
                              <span className="text-[10px] font-semibold text-slate-400 flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {new Date(latestEvent.created_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </div>
                            <span className="text-xs text-slate-600 truncate font-medium" title={latestEvent.description}>
                              {latestEvent.description || 'Reporte de posición'}
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-2 font-bold text-slate-800">
                            <div className="p-1.5 bg-slate-100 rounded-md border border-slate-200">
                              <Truck className="w-3.5 h-3.5 text-slate-600" />
                            </div>
                            {dispatch.vehicle_plate}
                          </div>
                          <span className="text-xs font-medium text-slate-500 ml-8">{dispatch.driver_name}</span>
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
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal 
        isOpen={!!selectedDispatch} 
        onClose={() => setSelectedDispatch(null)} 
        title={`Expediente Operativo: ${selectedDispatch?.dispatch_number}`}
        maxWidth="max-w-5xl"
      >
        {selectedDispatch && (
          <div className="space-y-6">
            {/* Header Modal */}
            <div className="flex flex-wrap gap-4 p-5 bg-slate-50 rounded-xl border border-slate-200">
              <div className="flex-1 min-w-[150px]">
                <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Unidad de Transporte</p>
                <div className="flex items-center gap-2 mt-1">
                  <div className="p-1.5 bg-white rounded shadow-sm border border-slate-100">
                    <Truck className="w-4 h-4 text-[#002855]" />
                  </div>
                  <p className="font-bold text-slate-800 text-lg">{selectedDispatch.vehicle_plate}</p>
                </div>
              </div>
              <div className="flex-1 min-w-[150px]">
                <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Operador (Conductor)</p>
                <p className="font-semibold text-slate-700 mt-1.5">{selectedDispatch.driver_name}</p>
              </div>
              <div className="flex-1 min-w-[150px]">
                <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Estado Logístico</p>
                <div className="mt-1.5">{getStatusBadge(selectedDispatch.status)}</div>
              </div>
              <div className="flex-1 min-w-[150px]">
                <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Salida Programada</p>
                <p className="font-semibold text-slate-700 mt-1.5">{formatDate(selectedDispatch.scheduled_departure)}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              {/* OTs Section */}
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                  <h3 className="font-bold text-slate-800 text-sm">Manifiesto de Carga (OTs)</h3>
                  <span className="bg-slate-100 text-slate-600 px-2.5 py-0.5 rounded-md text-xs font-bold border border-slate-200">
                    {selectedDispatch.dispatch_requests?.length || 0} Asignaciones
                  </span>
                </div>
                
                {selectedDispatch.dispatch_requests?.length === 0 ? (
                  <div className="text-center py-8 text-slate-400 bg-slate-50 rounded-lg border border-dashed border-slate-200">
                    Vacio. No hay OTs asociadas a este recurso.
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {selectedDispatch.dispatch_requests?.map((req, idx) => (
                      <div key={idx} className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm relative overflow-hidden">
                        <div className="absolute left-0 top-0 bottom-0 w-1 bg-indigo-500"></div>
                        <div className="flex justify-between items-center mb-3 pl-2">
                          <span className="font-black text-slate-800">
                            {req.transport_requests.request_number}
                          </span>
                          <span className="text-[10px] bg-slate-50 text-slate-500 px-2.5 py-1 rounded-md font-bold uppercase tracking-wide border border-slate-200">
                            {req.status}
                          </span>
                        </div>
                        
                        <div className="grid grid-cols-1 gap-3 pl-2 mt-2">
                          <div className="flex gap-3 items-start">
                            <div className="mt-0.5"><MapPin className="w-4 h-4 text-slate-400" /></div>
                            <div>
                              <p className="text-[10px] uppercase font-bold text-slate-400">Origen (Recojo)</p>
                              <p className="text-xs font-semibold text-slate-700 mt-0.5">{req.transport_requests.pickup_address}</p>
                            </div>
                          </div>
                          <div className="flex gap-3 items-start">
                            <div className="mt-0.5"><MapPin className="w-4 h-4 text-[#002855]" /></div>
                            <div>
                              <p className="text-[10px] uppercase font-bold text-[#002855]/70">Destino (Entrega)</p>
                              <p className="text-xs font-semibold text-slate-800 mt-0.5">{req.transport_requests.delivery_address}</p>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Timeline Section */}
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                  <h3 className="font-bold text-slate-800 text-sm">Bitácora de Telemetría</h3>
                  <span className="bg-slate-100 text-slate-600 px-2.5 py-0.5 rounded-md text-xs font-bold border border-slate-200">
                    {selectedDispatch.dispatch_events?.length || 0} Registros
                  </span>
                </div>
                
                {(!selectedDispatch.dispatch_events || selectedDispatch.dispatch_events.length === 0) ? (
                  <div className="text-center py-8 text-slate-400 bg-slate-50 rounded-lg border border-dashed border-slate-200">
                    Aún no hay reportes de campo para esta operación.
                  </div>
                ) : (
                  <div className="relative pl-4 space-y-6 before:absolute before:inset-0 before:ml-6 before:w-0.5 before:bg-slate-200">
                    {[...selectedDispatch.dispatch_events].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).map((evt, idx) => {
                      const isAlert = evt.event_type === 'INCIDENCIA' || evt.event_type === 'RETRASO' || evt.event_type === 'DESVIO';
                      return (
                        <div key={idx} className="relative flex items-start gap-4">
                          <div className={`relative z-10 flex items-center justify-center w-5 h-5 rounded-full border-4 border-white shadow-sm mt-0.5 ${
                            isAlert ? 'bg-red-500' : 'bg-slate-400'
                          }`}></div>
                          
                          <div className={`flex-1 p-3.5 rounded-xl border shadow-sm ${isAlert ? 'bg-red-50 border-red-100' : 'bg-white border-slate-200'}`}>
                            <div className="flex justify-between items-start mb-1.5">
                              <span className={`font-bold text-xs uppercase tracking-wide ${isAlert ? 'text-red-700' : 'text-slate-700'}`}>
                                {evt.event_type.replace('_', ' ')}
                              </span>
                              <div className="flex flex-col items-end">
                                <span className="text-[10px] font-bold text-slate-500">{new Date(evt.created_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}</span>
                                <span className="text-[9px] text-slate-400">{new Date(evt.created_at).toLocaleDateString('es-PE', { day: '2-digit', month: 'short' })}</span>
                              </div>
                            </div>
                            <p className="text-sm text-slate-700 font-medium mb-2">{evt.description || 'Registro automático de sistema'}</p>
                            <p className="text-[10px] text-slate-400 font-semibold border-t border-slate-100/50 pt-2">
                              Reportado por: {evt.created_by}
                            </p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
