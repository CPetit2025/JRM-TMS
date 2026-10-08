"use client"
import { fetchServiceTypes } from '@/lib/request-service'
import { PageHeader } from '@/components/ui/page-header'
import Link from 'next/link'
import { dispatchStatusLabel } from '@/lib/dispatch-status'
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { Truck, Search, Calendar, MapPin, Share2, AlertTriangle, CheckCircle2, Route } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/modal'
import { usePermissions } from '@/hooks/usePermissions'
import { DeliveryTable } from '@/components/delivery/DeliveryTable'
import { DeliveryReview } from '@/components/delivery/DeliveryReview'
import { TerceroAvanceModal } from '@/components/despacho/Tercero'
import { filterDeliveries, type DeliveryRow } from '@/lib/delivery'
import { ReportarFallaButton } from '@/components/mantenimiento/ReportarFalla'
import { TrackingPortalManager } from '@/components/tracking/TrackingPortalManager'
import { TransportWorkflow } from '@/components/transport/TransportWorkflow'
import { DispatchExecutionActions } from '@/components/transport/DispatchExecutionActions'

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
  modalidad?: string
  estimated_distance_km: number
  scheduled_departure: string
  dispatch_requests?: DispatchRequest[]
  dispatch_events?: { event_type: string, description: string, created_at: string, created_by: string }[]
  maintenance_alerts?: { id: string, severity: string, description: string, status: string }[]
  contract_codes?: string[]
  responsible_names?: string[]
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

  const getLatestEvent = (events: NonNullable<Dispatch['dispatch_events']>) => {
    if (!events || events.length === 0) return null;
    return [...events].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
  }

  const hasAlertEvent = (events: NonNullable<Dispatch['dispatch_events']>, maintenance_alerts?: Dispatch['maintenance_alerts']) => {
    if (maintenance_alerts && maintenance_alerts.length > 0) return true;
    if (!events || events.length === 0) return false;
    // Buscamos si en las últimas 12 horas hubo una alerta que no haya sido resuelta (para simplificar, si el último evento es alerta)
    const latest = getLatestEvent(events);
    return latest && (latest.event_type === 'INCIDENCIA' || latest.event_type === 'RETRASO' || latest.event_type === 'DESVIO');
  }


export default function TorreControlPage() {
  const supabase = useMemo(() => createClient(), [])
  const { isLoaded, canRead, canWrite } = usePermissions()
  const [rows, setRows] = useState<DeliveryRow[]>([])
  const [review, setReview] = useState<DeliveryRow | null>(null)
  const [thirdId, setThirdId] = useState<string | null>(null)
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  const fetchVersion = useRef(0)
  const [dispatches, setDispatches] = useState<Dispatch[]>([])
  // Estado documentario de los despachos programados (bandeja del Asistente Documentario)
  const [loading, setLoading] = useState(true)
  const [selectedDispatch, setSelectedDispatch] = useState<Dispatch | null>(null)
  const requestedDispatch = useRef<string | null>(null)
  const requestedProvider = useRef(false)

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('jrm:context', { detail: selectedDispatch ? { dispatchId: selectedDispatch.id } : {} }))
  }, [selectedDispatch])
  
  // Filters
  const [searchTerm, setSearchTerm] = useState('')
  const [statusFilter, setStatusFilter] = useState('ACTIVOS')
  const [dateFilter, setDateFilter] = useState('')
  const [onlyAlerts, setOnlyAlerts] = useState(false)
  const [responsibleFilter, setResponsibleFilter] = useState('')
  const [responsibles, setResponsibles] = useState<Array<{ user_id: string, full_name: string }>>([])

  const [portalOpen, setPortalOpen] = useState(false)

  useEffect(() => {
    const query = new URLSearchParams(window.location.search)
    const id = query.get('despacho')
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return
    requestedDispatch.current = id
    requestedProvider.current = query.get('proveedor') === '1'
    const timer = window.setTimeout(() => {
      setStatusFilter('TODOS')
      const day = query.get('fecha')
      if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) setDateFilter(day)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  const fetchDispatches = useCallback(async () => {
    const version = ++fetchVersion.current
    try {
      setLoading(true)
      const { data, error } = await supabase.rpc('get_tower_dispatches', {
        p_date: dateFilter || null,
        p_responsible: responsibleFilter || null,
        p_status: statusFilter,
      })
      if (error) throw error
      const list = (data || []) as Dispatch[]
      const { data: deliveries, error: rowError } = await supabase.rpc('delivery_tracking_rows', { p_dispatches: list.map(d => d.id) })
      if (rowError) throw rowError
      const types = await fetchServiceTypes(supabase, ((deliveries || []) as DeliveryRow[]).map(r => r.request_id))
      if (version !== fetchVersion.current) return
      setDispatches(list); setRows(((deliveries || []) as DeliveryRow[]).map(r => ({ ...r, ...types.get(r.request_id) }))); setRefreshedAt(new Date().toISOString()); setLoadError('')
      if (requestedDispatch.current) {
        const selected = list.find(item => item.id === requestedDispatch.current)
        if (selected) {
          if (requestedProvider.current && selected.modalidad === 'TERCERO' && canWrite('despacho')) setThirdId(selected.id)
          else setSelectedDispatch(selected)
          requestedDispatch.current = null
        }
      }
    } catch (err) {
      if (version === fetchVersion.current) setLoadError('No se pudo actualizar la torre de control: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      if (version === fetchVersion.current) setLoading(false)
    }
  }, [dateFilter, responsibleFilter, statusFilter, supabase, canWrite])

  useEffect(() => {
    if (!isLoaded) return
    const timer = window.setTimeout(() => void fetchDispatches(), 0)
    return () => window.clearTimeout(timer)
  }, [isLoaded, fetchDispatches, supabase])

  useEffect(() => {
    if (!isLoaded) return
    void supabase.rpc('get_tower_responsibles').then(({ data, error }) => {
      if (!error) setResponsibles((data || []) as Array<{ user_id: string, full_name: string }>)
    })
  }, [isLoaded, supabase])

  useEffect(() => {
    const channel = supabase.channel('torre_control_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dispatches' }, () => {
        fetchDispatches()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dispatch_events' }, () => {
        fetchDispatches()
      })
      .subscribe()

    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void fetchDispatches() }, 15000)
    return () => { void supabase.removeChannel(channel); window.clearInterval(timer) }
  }, [isLoaded, fetchDispatches, supabase])

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
    let kpiProgramados = 0
    let kpiEnCurso = 0
    let kpiCompletados = 0
    let kpiAlertas = 0

    const filtered = dispatches.filter(d => {
      // Calculate KPIs (independently of search term, but dependent on loaded data)
      if (d.status === 'PROGRAMADO') kpiProgramados++
      if (d.status === 'EN_CURSO' || d.status === 'EN RUTA' || d.status === 'RETORNO') kpiEnCurso++
      if (['ENTREGADO', 'LIQUIDADO', 'CERRADO'].includes(d.status)) kpiCompletados++
      
      const isAlert = hasAlertEvent(d.dispatch_events || [], d.maintenance_alerts)
      if (isAlert && d.status !== 'LIQUIDADO' && d.status !== 'ENTREGADO') kpiAlertas++

      // Apply Filters
      if (onlyAlerts && !isAlert) return false

      const searchLower = searchTerm.toLowerCase()
      if (searchTerm && !(
        d.vehicle_plate.toLowerCase().includes(searchLower) ||
        (d.driver_name || '').toLowerCase().includes(searchLower) ||
        d.dispatch_number.toLowerCase().includes(searchLower) ||
        filterDeliveries(rows.filter(row => row.dispatch_id === d.id), searchTerm, '', '').length > 0
      )) {
        return false
      }

      return true
    })

    return { filteredDispatches: filtered, kpis: { kpiProgramados, kpiEnCurso, kpiCompletados, kpiAlertas } }
  }, [dispatches, rows, searchTerm, onlyAlerts])


  const getStatusBadge = (status: string) => {
    const defaultStyle = 'bg-slate-50 text-slate-600 border-slate-200'
    const style = STATUS_BADGE[status] || defaultStyle
    return (
      <span className={`px-2.5 py-1 rounded-md text-[11px] font-bold tracking-wide uppercase border ${style}`}>
        {dispatchStatusLabel(status)}
      </span>
    )
  }

  return (
    <div className="space-y-3 w-full mx-auto pb-10">
      <PageHeader showTitle title="Torre de Control" description="Supervisión operativa y telemetría de flota en tiempo real." actions={<>
<div className="flex flex-wrap gap-2">
        <ReportarFallaButton />
        {canWrite('despacho') && <button
          onClick={() => setPortalOpen(true)}
          className="flex items-center gap-2 bg-white text-[#002855] border border-[#002855] px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-slate-50 transition-colors disabled:opacity-50 shadow-sm"
        >
          <Share2 className="w-4 h-4" />
          Portal permanente
        </button>}
        </div>
</>} />

      <TransportWorkflow />
      {canWrite('despacho') && <TrackingPortalManager open={portalOpen} onClose={() => setPortalOpen(false)} />}

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
            <p className="text-xs font-bold text-emerald-600 uppercase tracking-wider">Entregados / cerrados</p>
            <p className="text-3xl font-black text-emerald-700 mt-1">{kpis.kpiCompletados}</p>
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
          <select value={responsibleFilter} onChange={e => setResponsibleFilter(e.target.value)}
            aria-label="Administrador de Contrato"
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg bg-slate-50">
            <option value="">Todos los responsables</option>
            {responsibles.map(person => <option key={person.user_id} value={person.user_id}>{person.full_name}</option>)}
          </select>
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

      <DeliveryTable rows={rows.filter(row => filteredDispatches.some(d => d.id === row.dispatch_id))} loading={loading} error={loadError} refreshedAt={refreshedAt} onRefresh={() => void fetchDispatches()} onEvidence={setReview} onDispatch={row => setSelectedDispatch(dispatches.find(d => d.id === row.dispatch_id) || null)} onProvider={canWrite('despacho') ? row => setThirdId(row.dispatch_id) : undefined} />
      <DeliveryReview row={review} onClose={() => setReview(null)} onChanged={() => void fetchDispatches()} />
      <TerceroAvanceModal dispatchId={thirdId} onClose={() => setThirdId(null)} onChanged={() => void fetchDispatches()} />

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

            <div className="flex flex-wrap gap-2">
              <DispatchExecutionActions dispatch={{ ...selectedDispatch, modalidad: rows.find(row => row.dispatch_id === selectedDispatch.id)?.modalidad || selectedDispatch.modalidad }} onChanged={async () => { setSelectedDispatch(null); await fetchDispatches() }} />
              {canWrite('despacho') && (selectedDispatch.modalidad === 'TERCERO' || rows.some(row => row.dispatch_id === selectedDispatch.id && row.modalidad === 'TERCERO')) && <button onClick={() => { setThirdId(selectedDispatch.id); setSelectedDispatch(null) }} className="min-h-11 rounded-lg border border-violet-200 px-4 text-sm font-semibold text-violet-700">Acceso y avance del transportista</button>}
              {['documentario', 'packing-list', 'planificacion'].some(module => canRead(module)) && <Link href={`/despacho/documentos?despacho=${selectedDispatch.id}&vista=${selectedDispatch.status === 'PROGRAMADO' ? 'salida' : 'historial'}&desde=${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(selectedDispatch.scheduled_departure))}`} className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 px-4 text-sm font-semibold text-[#002855]">Documentos del servicio</Link>}
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

                {/* Maintenance Alerts Section */}
                <div className="mt-8 space-y-4">
                  <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                    <h3 className="font-bold text-slate-800 text-sm">Alertas de Mantenimiento</h3>
                    <span className="bg-slate-100 text-slate-600 px-2.5 py-0.5 rounded-md text-xs font-bold border border-slate-200">
                      {selectedDispatch.maintenance_alerts?.length || 0} Pendientes
                    </span>
                  </div>
                  
                  {(!selectedDispatch.maintenance_alerts || selectedDispatch.maintenance_alerts.length === 0) ? (
                    <div className="text-center py-8 text-slate-400 bg-slate-50 rounded-lg border border-dashed border-slate-200">
                      El vehículo se encuentra en óptimas condiciones.
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {selectedDispatch.maintenance_alerts.map((alert, idx) => (
                        <div key={idx} className="bg-red-50 border border-red-200 rounded-xl p-4 shadow-sm relative overflow-hidden">
                          <div className="absolute left-0 top-0 bottom-0 w-1 bg-red-500"></div>
                          <div className="flex justify-between items-start mb-2 pl-2">
                            <div className="flex items-center gap-2">
                              <AlertTriangle className="w-4 h-4 text-red-600" />
                              <span className="font-bold text-red-800 text-sm">{alert.severity}</span>
                            </div>
                            <span className="text-[10px] bg-red-100 text-red-700 px-2.5 py-1 rounded-md font-bold uppercase tracking-wide border border-red-200">
                              {alert.status}
                            </span>
                          </div>
                          <p className="text-sm font-medium text-red-900 pl-2 mt-1">{alert.description}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
