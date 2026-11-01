"use client"
import { fetchServiceTypes } from '@/lib/request-service'
import { PageHeader } from '@/components/ui/page-header'
import Link from 'next/link'
import { dispatchStatusLabel, isDispatchStatusGroup } from '@/lib/dispatch-status'
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { Truck, Search, Calendar, MapPin, Share2, AlertTriangle, CheckCircle2, Route } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/modal'
import { usePermissions } from '@/hooks/usePermissions'
import { DeliveryTable } from '@/components/delivery/DeliveryTable'
import { DeliveryReview } from '@/components/delivery/DeliveryReview'
import { AddRouteService } from '@/components/despacho/AddRouteService'
import { TerceroAvanceModal } from '@/components/despacho/Tercero'
import { documentNumbersByStop, filterDeliveries, type DeliveryRow } from '@/lib/delivery'
import { ReportarFallaButton } from '@/components/mantenimiento/ReportarFalla'
import { TrackingPortalManager } from '@/components/tracking/TrackingPortalManager'
import { TransportWorkflow } from '@/components/transport/TransportWorkflow'
import { DispatchExecutionActions } from '@/components/transport/DispatchExecutionActions'
import { DispatchCrewUnloading } from '@/components/despacho/DispatchCrewUnloading'
import { DispatchFreightStages } from '@/components/despacho/DispatchFreightStages'
import { EvidenceGallery } from '@/components/evidence/EvidenceGallery'
import { toast } from 'sonner'
import { RouteShareModal } from '@/components/despacho/RouteShareModal'
import { RouteForkliftInfo } from '@/components/despacho/RouteForkliftInfo'
import { RouteCrewDetails } from '@/components/despacho/RouteCrewDetails'
import { ManualOperationalCloseButton } from '@/components/despacho/ManualOperationalCloseButton'
import { ErpGuiasResumenCard, ErpOtReferencia } from '@/components/erp/ErpReferencia'
import { ProgrammingNotes } from '@/components/despacho/programar-ruta/ProgrammingNotes'
import { DispatchDetailModal } from '@/components/despacho/detalle/DispatchDetailModal'
import { EconomicClosurePanel } from '@/components/despacho/EconomicClosurePanel'
import { DispatchDocumentarySettlement } from '@/components/documentos/DispatchDocumentarySettlement'
import { closureStage, ServiceClosure, type ClosureChecks } from '@/components/despacho/ServiceClosure'
import { canAddRouteService } from '@/lib/route-assignment'

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
  const { role, isLoaded, canRead, canWrite } = usePermissions()
  const [rows, setRows] = useState<DeliveryRow[]>([])
  const [review, setReview] = useState<DeliveryRow | null>(null)
  const [thirdId, setThirdId] = useState<string | null>(null)
  const [addServiceId, setAddServiceId] = useState<string | null>(null)
  const canAddService = canWrite('despacho') && ['admin', 'supervisor de transporte'].includes(role)
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  const fetchVersion = useRef(0)
  const [dispatches, setDispatches] = useState<Dispatch[]>([])
  // Estado documentario de los despachos programados (bandeja del Asistente Documentario)
  const [loading, setLoading] = useState(true)
  const [selectedDispatch, setSelectedDispatch] = useState<Dispatch | null>(null)
  const requestedDispatch = useRef<string | null>(null)
  const requestedProvider = useRef(false)
  // ?despacho=<id>&revisar=<solicitud>: abre directamente la guía y conformidad por validar (enlace de JRM IA)
  const requestedReview = useRef<string | null>(null)
  // ?liquidar=economica|documentaria (direcciones anteriores de Costos por ruta y de Documentación pendiente): abre esa liquidación del viaje
  const [liquidate, setLiquidate] = useState<{ id: string; what: string } | null>(null)
  // Liquidaciones abiertas desde «Toda la ruta», encima del detalle (sin salir de la ventana)
  const [routePanel, setRoutePanel] = useState<{ id: string; what: 'economico' | 'documentos' } | null>(null)

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('jrm:context', { detail: selectedDispatch ? { dispatchId: selectedDispatch.id } : {} }))
  }, [selectedDispatch])
  
  // Filters
  const [searchTerm, setSearchTerm] = useState('')
  const [statusFilter, setStatusFilter] = useState('ACTIVOS')
  const [dateFilter, setDateFilter] = useState('')
  const [onlyAlerts, setOnlyAlerts] = useState(false)
  // Cierre del servicio de las rutas cerradas (dispatch_closure_status): filtra lo pendiente de liquidar o listo para cerrar
  const [closure, setClosure] = useState<Record<string, ClosureChecks>>({})
  const [closureFilter, setClosureFilter] = useState('')
  const [responsibleFilter, setResponsibleFilter] = useState('')
  const [responsibles, setResponsibles] = useState<Array<{ user_id: string, full_name: string }>>([])

  const [portalOpen, setPortalOpen] = useState(false)
  const [shareRoutes, setShareRoutes] = useState<string[]>([])
  const canceling = useRef(false)

  useEffect(() => {
    const query = new URLSearchParams(window.location.search)
    const estado = query.get('estado')
    if (estado && (['ACTIVOS', 'HISTORIAL', 'TODOS', 'PROGRAMADO'].includes(estado) || isDispatchStatusGroup(estado))) {
      const timer = window.setTimeout(() => setStatusFilter(estado), 0)
      if (!query.get('despacho')) return () => window.clearTimeout(timer)
    }
    const id = query.get('despacho')
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return
    requestedDispatch.current = id
    requestedProvider.current = query.get('proveedor') === '1'
    const revisar = query.get('revisar')
    requestedReview.current = revisar && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(revisar) ? revisar : null
    const timer = window.setTimeout(() => {
      setStatusFilter('TODOS')
      const what = query.get('liquidar')
      if (what === 'economica' || what === 'documentaria') setLiquidate({ id, what })
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
      // GR y Nota de Despacho registradas por Documentos; sin acceso a esos documentos, la columna usa la guía de entrega
      const { data: docs } = list.length ? await supabase.from('dispatch_documents').select('dispatch_id, transport_request_id, doc_type, document_number')
        .in('dispatch_id', list.map(d => d.id)).in('doc_type', ['GUIA_REMISION', 'NOTA_DESPACHO']).is('voided_at', null) : { data: [] }
      // Números que vincula el Asistente Documentario (varios por servicio), en una sola consulta; sin acceso, se omiten
      const { data: refs } = list.length ? await supabase.rpc('get_dispatch_document_references_batch', { p_dispatches: list.map(d => d.id) }) : { data: [] }
      const numbers = documentNumbersByStop([...(docs || []), ...((refs || []) as { dispatch_id: string; request_id: string; doc_type: string; document_number: string }[])])
      const closedIds = list.filter(d => ['LIQUIDADO', 'CERRADO'].includes(d.status)).map(d => d.id).slice(0, 500)
      const { data: closureData } = closedIds.length ? await supabase.rpc('dispatch_closure_status', { p_dispatch_ids: closedIds }) : { data: null }
      if (version !== fetchVersion.current) return
      setClosure(closureData?.success ? closureData.rows : {})
      setDispatches(list); setSelectedDispatch(current => current ? list.find(item => item.id === current.id) || null : null); setRows(((deliveries || []) as DeliveryRow[]).map(r => { const n = numbers.get(`${r.dispatch_id}/${r.request_id}`); return { ...r, ...types.get(r.request_id), guide_number: [...new Set([r.guide_number, ...(n?.guide || '').split(' · ')].filter(Boolean))].join(' · ') || null, note_number: n?.note || null } })); setRefreshedAt(new Date().toISOString()); setLoadError('')
      if (requestedDispatch.current) {
        const selected = list.find(item => item.id === requestedDispatch.current)
        if (selected) {
          const reviewRow = requestedReview.current ? ((deliveries || []) as DeliveryRow[]).find(row => row.dispatch_id === selected.id && row.request_id === requestedReview.current) : undefined
          requestedReview.current = null
          if (reviewRow) setReview(reviewRow)
          else if (requestedProvider.current && (selected.modalidad === 'TERCERO' || ((deliveries || []) as DeliveryRow[]).some(row => row.dispatch_id === selected.id && row.modalidad === 'TERCERO')) && canWrite('despacho')) setThirdId(selected.id)
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

  // Solo un despacho PROGRAMADO se cancela: libera la partida, anula el flete y devuelve las solicitudes a Por asignar
  const cancelDispatch = async (dispatch: Dispatch) => {
    if (canceling.current) return
    const reason = prompt(`Motivo de la cancelación del despacho ${dispatch.dispatch_number}:`)
    if (!reason?.trim()) return
    canceling.current = true
    try {
    const { data, error } = await supabase.rpc('cancel_dispatch', { p_dispatch_id: dispatch.id, p_reason: reason.trim() })
    if (error || (data && !data.success)) { toast.error('Error al cancelar: ' + (error?.message || data?.error || 'No se pudo cancelar')); return }
    toast.success('Despacho cancelado: se liberó la partida y las solicitudes volvieron a Por asignar.')
    setSelectedDispatch(null)
    await fetchDispatches()
    } catch { toast.error('No se pudo cancelar la ruta. Intente nuevamente.') } finally { canceling.current = false }
  }

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
      timeZone: 'America/Lima', day: '2-digit', month: '2-digit', year: 'numeric',
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
      if (closureFilter && closureStage(closure[d.id]) !== closureFilter) return false

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
  }, [dispatches, rows, searchTerm, onlyAlerts, closure, closureFilter])


  const getStatusBadge = (status: string) => {
    const defaultStyle = 'bg-slate-50 text-slate-600 border-slate-200'
    const style = STATUS_BADGE[status] || defaultStyle
    return (
      <span className={`px-2.5 py-1 rounded-md text-[11px] font-bold tracking-wide uppercase border ${style}`}>
        {dispatchStatusLabel(status)}
      </span>
    )
  }

  // Expediente de la ruta completa: en su propia ventana (enlace directo) o como pestaña «Toda la ruta» del detalle
  const routeFile = (dispatch: Dispatch, done: () => void) => (
          <div className="space-y-6">
            {/* Resumen de la ruta */}
            <div className="grid gap-4 rounded-xl border border-slate-200 bg-slate-50 p-5 sm:grid-cols-2 xl:grid-cols-5">
              <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">N.º despacho</p><p className="mt-1 text-lg font-bold text-jrm-navy">{dispatch.dispatch_number}</p><p className="mt-1 text-xs text-slate-500">{dispatch.dispatch_requests?.length || 0} servicio(s)</p></div>
              <div className="flex-1 min-w-[150px]">
                <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Unidad de Transporte</p>
                <div className="flex items-center gap-2 mt-1">
                  <div className="p-1.5 bg-white rounded shadow-sm border border-slate-100">
                    <Truck className="w-4 h-4 text-[#002855]" />
                  </div>
                  <p className="font-bold text-slate-800 text-lg">{dispatch.vehicle_plate}</p>
                </div>
              </div>
              <div className="flex-1 min-w-[150px]">
                <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Operador (Conductor)</p>
                <p className="font-semibold text-slate-700 mt-1.5">{dispatch.driver_name}</p>
              </div>
              <div className="flex-1 min-w-[150px]">
                <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Estado Logístico</p>
                <div className="mt-1.5">{getStatusBadge(dispatch.status)}</div>
              </div>
              <div className="flex-1 min-w-[150px]">
                <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Salida Programada</p>
                <p className="font-semibold text-slate-700 mt-1.5">{formatDate(dispatch.scheduled_departure)}</p>
              </div>
            </div>
            <ProgrammingNotes dispatchId={dispatch.id} />

            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <h3 className="mb-3 font-bold text-slate-800">Acciones operativas</h3>
              <div className="flex flex-wrap gap-2">
              <ManualOperationalCloseButton dispatchId={dispatch.id} dispatchNumber={dispatch.dispatch_number} status={dispatch.status} onClosed={() => { done(); void fetchDispatches() }} />
              {dispatch.status === 'CIERRE_OPERATIVO' && <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">La ruta tiene cierre operativo. Las guías, conformidades y la liquidación financiera conservan su estado; consulta el motivo y el responsable en la bitácora.</p>}
              {canAddService && ['PROGRAMADO', 'EN_CURSO', 'EN RUTA'].includes(dispatch.status) && dispatch.vehicle_plate !== 'EXTERNO' && <button type="button" onClick={() => setAddServiceId(dispatch.id)} className="min-h-11 rounded-lg bg-jrm-navy px-4 text-sm font-semibold text-white">Agregar servicio a la ruta</button>}
              <DispatchExecutionActions dispatch={{ ...dispatch, modalidad: rows.find(row => row.dispatch_id === dispatch.id)?.modalidad || dispatch.modalidad }} onChanged={async () => { done(); await fetchDispatches() }} />
              {canWrite('despacho') && (dispatch.modalidad === 'TERCERO' || rows.some(row => row.dispatch_id === dispatch.id && row.modalidad === 'TERCERO')) && <button onClick={() => setThirdId(dispatch.id)} className="min-h-11 rounded-lg border border-violet-200 px-4 text-sm font-semibold text-violet-700">Compartir acceso GR · tercero</button>}
              {['documentario', 'packing-list', 'planificacion'].some(module => canRead(module)) && dispatch.status !== 'PROGRAMADO' && <button type="button" onClick={() => setRoutePanel({ id: dispatch.id, what: 'documentos' })} className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 px-4 text-sm font-semibold text-[#002855]">Documentos del servicio</button>}
              {['documentario', 'packing-list', 'planificacion'].some(module => canRead(module)) && dispatch.status === 'PROGRAMADO' && <Link href={`/despacho/documentos?despacho=${dispatch.id}&vista=${dispatch.status === 'PROGRAMADO' ? 'salida' : 'historial'}&desde=${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(dispatch.scheduled_departure))}`} className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 px-4 text-sm font-semibold text-[#002855]">Documentos del servicio</Link>}
              {canWrite('despacho') && dispatch.status === 'PROGRAMADO' && <button type="button" onClick={() => void cancelDispatch(dispatch)} className="min-h-11 rounded-lg border border-red-200 px-4 text-sm font-semibold text-red-700 hover:bg-red-50">Cancelar despacho</button>}
              </div>
            </div>

            <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)]">
              <RouteCrewDetails key={`${dispatch.id}/${refreshedAt}`} dispatchId={dispatch.id} />
              <RouteForkliftInfo key={dispatch.id} dispatchId={dispatch.id} />
            </div>

            <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-2">
              {/* OTs Section */}
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                  <h3 className="font-bold text-slate-800 text-sm">Servicios y puntos de la ruta</h3>
                  <span className="bg-slate-100 text-slate-600 px-2.5 py-0.5 rounded-md text-xs font-bold border border-slate-200">
                    {dispatch.dispatch_requests?.length || 0} Asignaciones
                  </span>
                </div>
                
                {(dispatch.contract_codes?.length ?? 0) > 0 && <div className="space-y-2">
                  {[...new Set(dispatch.contract_codes)].map(code => <ErpOtReferencia key={code} ot={code} compact />)}
                </div>}
                {dispatch.dispatch_requests?.length === 0 ? (
                  <div className="text-center py-8 text-slate-400 bg-slate-50 rounded-lg border border-dashed border-slate-200">
                    No hay servicios asociados a esta ruta.
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {dispatch.dispatch_requests?.map((req, idx) => (
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
                  <h3 className="font-bold text-slate-800 text-sm">Bitácora operativa y telemetría</h3>
                  <span className="bg-slate-100 text-slate-600 px-2.5 py-0.5 rounded-md text-xs font-bold border border-slate-200">
                    {dispatch.dispatch_events?.length || 0} Registros
                  </span>
                </div>
                
                {(!dispatch.dispatch_events || dispatch.dispatch_events.length === 0) ? (
                  <div className="text-center py-8 text-slate-400 bg-slate-50 rounded-lg border border-dashed border-slate-200">
                    Aún no hay reportes de campo para esta operación.
                  </div>
                ) : (
                  <div className="relative pl-4 space-y-6 before:absolute before:inset-0 before:ml-6 before:w-0.5 before:bg-slate-200">
                    {[...dispatch.dispatch_events].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).map((evt, idx) => {
                      const isAlert = evt.event_type === 'INCIDENCIA' || evt.event_type === 'RETRASO' || evt.event_type === 'DESVIO';
                      return (
                        <div key={idx} className="relative flex items-start gap-4">
                          <div className={`relative z-10 flex items-center justify-center w-5 h-5 rounded-full border-4 border-white shadow-sm mt-0.5 ${
                            isAlert ? 'bg-red-500' : 'bg-slate-400'
                          }`}></div>
                          
                          <div className={`flex-1 p-3.5 rounded-xl border shadow-sm ${isAlert ? 'bg-red-50 border-red-100' : 'bg-white border-slate-200'}`}>
                            <div className="flex justify-between items-start mb-1.5">
                              <span className={`font-bold text-xs uppercase tracking-wide ${isAlert ? 'text-red-700' : 'text-slate-700'}`}>
                                {evt.event_type.replaceAll('_', ' ')}
                              </span>
                              <div className="flex flex-col items-end">
                                <span className="text-[10px] font-bold text-slate-500">{new Date(evt.created_at).toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit' })}</span>
                                <span className="text-[9px] text-slate-400">{new Date(evt.created_at).toLocaleDateString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: 'short' })}</span>
                              </div>
                            </div>
                            <p className="mb-2 whitespace-pre-wrap break-words text-sm font-medium text-slate-700">{evt.description || 'Registro automático de sistema'}</p>
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
                      {dispatch.maintenance_alerts?.length || 0} Pendientes
                    </span>
                  </div>
                  
                  {(!dispatch.maintenance_alerts || dispatch.maintenance_alerts.length === 0) ? (
                    <div className="text-center py-8 text-slate-400 bg-slate-50 rounded-lg border border-dashed border-slate-200">
                      El vehículo se encuentra en óptimas condiciones.
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {dispatch.maintenance_alerts.map((alert, idx) => (
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

            <details className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <summary className="cursor-pointer font-bold text-slate-800">Flete: referencial, acordado y final (consulta)</summary>
              <div className="mt-4"><DispatchFreightStages dispatchId={dispatch.id} readOnly onEconomic={() => setRoutePanel({ id: dispatch.id, what: 'economico' })} /></div>
            </details>
            <details className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <summary className="cursor-pointer font-bold text-slate-800">Asignación de tripulación y costos de descarga</summary>
              <div className="mt-4"><DispatchCrewUnloading dispatchId={dispatch.id} status={dispatch.status} canEdit={canWrite('despacho')} onEconomic={() => setRoutePanel({ id: dispatch.id, what: 'economico' })}
                stops={rows.filter(row => row.dispatch_id === dispatch.id).map(row => ({ request_id: row.request_id, request_number: row.request_number }))} /></div>
            </details>
            <div className="border-t pt-4">
              <EvidenceGallery dispatchId={dispatch.id} title="Evidencias registradas · consulta" />
            </div>
          </div>
  )

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
          Compartir con cliente
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

      {/* Referencia del ERP (solo lectura): guías del ERP sin ruta, guías de rutas que el ERP no muestra y desfases de fecha */}
      <ErpGuiasResumenCard canOpenErp={['apt', 'apt-carga'].some(module => canRead(module))} />

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
            <option value="RUTA">En ruta</option>
            <option value="POR_CERRAR">Cierre documental y financiero pendiente</option>
          </select>
          <select value={closureFilter} onChange={e => { setClosureFilter(e.target.value); if (e.target.value && !['HISTORIAL', 'TODOS'].includes(statusFilter)) setStatusFilter('HISTORIAL') }} aria-label="Cierre del servicio"
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg bg-slate-50 text-slate-600">
            <option value="">Cierre del servicio: todos</option>
            <option value="LISTO">Listo para el cierre final</option>
            <option value="DOCUMENTARIO">Liquidación documentaria pendiente</option>
            <option value="ECONOMICO">Liquidación económica pendiente</option>
            <option value="CAJA">Gastos de Caja por revisar</option>
            <option value="CERRADO">Servicio cerrado</option>
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

      {shareRoutes.length > 0 && <RouteShareModal ids={shareRoutes} onClose={() => setShareRoutes([])} />}
      <DeliveryTable showCrewDetails renderDetail={(shown, { close, select }) => {
        // Fila vigente tras cada actualización; las acciones abren sus flujos actuales y nunca cierran otros procesos
        const row = rows.find(r => r.dispatch_id === shown.dispatch_id && r.request_id === shown.request_id) || shown
        const documentsHref = ['documentario', 'packing-list', 'planificacion'].some(module => canRead(module)) ? `/despacho/documentos?despacho=${row.dispatch_id}&vista=${row.state === 'PROGRAMADO' ? 'salida' : 'historial'}&desde=${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(row.scheduled_departure))}` : undefined
        const economicHref = ['cierre-economico', 'despacho', 'documentario'].some(module => canRead(module)) ? `/despacho/documentos/economico?despacho=${row.dispatch_id}` : undefined
        const routeDispatch = dispatches.find(d => d.id === row.dispatch_id)  // pestaña «Toda la ruta» (antes, la ventana aparte del Expediente)
        return <DispatchDetailModal row={row} routeFile={routeDispatch ? routeFile(routeDispatch, close) : undefined} routeRows={rows} onSelect={select} onClose={close} documentsHref={documentsHref} economicHref={economicHref} onValidate={r => { close(); setReview(r) }} actions={<>
          <ManualOperationalCloseButton dispatchId={row.dispatch_id} dispatchNumber={row.dispatch_number} status={dispatches.find(item => item.id === row.dispatch_id)?.status || row.state} onClosed={() => { close(); void fetchDispatches() }} />
          <button type="button" onClick={() => setReview(row)} className="min-h-10 rounded-lg border border-slate-300 px-3 text-left text-sm font-semibold text-jrm-navy">Guía y conformidad</button>
          {canAddService && canAddRouteService({ status: row.state, plate: row.plate, scheduled_departure: row.scheduled_departure }) && <button type="button" onClick={() => setAddServiceId(row.dispatch_id)} className="min-h-10 rounded-lg border border-slate-300 px-3 text-left text-sm font-semibold text-jrm-navy">Agregar servicio a la ruta</button>}
          {canWrite('despacho') && row.modalidad === 'TERCERO' && <button type="button" onClick={() => setThirdId(row.dispatch_id)} className="min-h-10 rounded-lg border border-slate-300 px-3 text-left text-sm font-semibold text-violet-700">Compartir acceso GR · tercero</button>}
        </>} />
      }} renderManualClose={(row, closeDetail) => <ManualOperationalCloseButton dispatchId={row.dispatch_id} dispatchNumber={row.dispatch_number} status={dispatches.find(item => item.id === row.dispatch_id)?.status || row.state} onClosed={() => { closeDetail(); setSelectedDispatch(null); void fetchDispatches() }} />} onShareRoutes={setShareRoutes} cancelableRoutes={dispatches.filter(d => d.status === 'PROGRAMADO').map(d => d.id)} onCancelRoute={canWrite('despacho') ? id => { const d = dispatches.find(x => x.id === id); if (d) void cancelDispatch(d) } : undefined} rows={rows.filter(row => filteredDispatches.some(d => d.id === row.dispatch_id))} loading={loading} error={loadError} refreshedAt={refreshedAt} onRefresh={() => void fetchDispatches()} onEvidence={setReview} onDispatch={row => setSelectedDispatch(dispatches.find(d => d.id === row.dispatch_id) || null)} onAddService={canAddService ? row => setAddServiceId(row.dispatch_id) : undefined} onProvider={canWrite('despacho') ? row => setThirdId(row.dispatch_id) : undefined} />
      {routePanel?.what === 'economico' && <EconomicClosurePanel dispatchId={routePanel.id} initialTab="servicios" onClose={() => setRoutePanel(null)} onChanged={() => void fetchDispatches()} />}
      {routePanel?.what === 'documentos' && <Modal isOpen onClose={() => setRoutePanel(null)} title="Liquidación documentaria del viaje" maxWidth="max-w-6xl">
        <DispatchDocumentarySettlement dispatchId={routePanel.id} onChanged={() => void fetchDispatches()} /></Modal>}
      <AddRouteService dispatchId={addServiceId} onClose={() => setAddServiceId(null)} onChanged={() => { setSelectedDispatch(null); void fetchDispatches() }} />
      <DeliveryReview row={review} onClose={() => setReview(null)} onChanged={() => void fetchDispatches()} />
      <TerceroAvanceModal dispatchId={thirdId} onClose={() => setThirdId(null)} onChanged={() => void fetchDispatches()} />

      <Modal 
        isOpen={!!selectedDispatch} 
        onClose={() => setSelectedDispatch(null)} 
        title={`Expediente Operativo: ${selectedDispatch?.dispatch_number}`}
        maxWidth="max-w-7xl"
        footer={<div className="flex justify-end"><button type="button" onClick={() => setSelectedDispatch(null)} className="min-h-10 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-jrm-navy">Cerrar expediente</button></div>}
      >
        {/* Abierto por enlace (?despacho=, p. ej. desde Costos por ruta o Documentos): el cierre del servicio va primero */}
        {selectedDispatch && <div className="mb-4"><ServiceClosure dispatchId={selectedDispatch.id} openEconomic={liquidate?.id === selectedDispatch.id && liquidate.what === 'economica'} openDocumentary={liquidate?.id === selectedDispatch.id && liquidate.what === 'documentaria'} onChanged={() => void fetchDispatches()} /></div>}
        {selectedDispatch && routeFile(selectedDispatch, () => setSelectedDispatch(null))}
      </Modal>
    </div>
  )
}
