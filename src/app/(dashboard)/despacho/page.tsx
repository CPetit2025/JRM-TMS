"use client"
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { TransportWorkflow } from '@/components/transport/TransportWorkflow'
import { DataTable } from '@/components/ui/data-table'
import { PageHeader } from '@/components/ui/page-header'
import { KpiStatCard } from '@/components/ui/kpi-stat-card'
import { FilterToolbar, FilterField, filterControl } from '@/components/ui/filter-toolbar'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'

import { splitFreight } from '@/lib/transport-budget'
import { dispatchStatusLabel } from '@/lib/dispatch-status'
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Truck, MapPin, Loader2, Calendar, Plus, FileText, Tag, Search, XCircle, Clock, Route, PackageCheck } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { EvidenceGallery } from '@/components/evidence/EvidenceGallery'
import { DispatchCrewUnloading } from '@/components/despacho/DispatchCrewUnloading'
import { QuoteBreakdown } from '@/components/tarifas/TransportTariffManager'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import { calculateRouteDistance } from '@/lib/routing'
import { usePermissions } from '@/hooks/usePermissions'
import { errorMessage } from '@/lib/caja'
import { serviceDate, wasRescheduled, withRescheduling, type RequestRescheduling } from '@/lib/request-schedule'
import { checkDispatchEligibility } from '@/lib/eligibility'
import { ReportarFallaButton } from '@/components/mantenimiento/ReportarFalla'
import { TerceroFields, TERCERO_VACIO, type TerceroForm } from '@/components/despacho/Tercero'

type PlanningCarrier = { business_name: string | null }
type PlanningVehicle = { plate: string; brand: string | null; model: string | null; assigned_driver_id: string | null; carriers: PlanningCarrier | null }
type PlanningDriver = { id: string; first_name: string; last_name: string; document_number: string; profile_id: string | null; carriers: PlanningCarrier | null }

interface TransportRequest {
  id: string
  request_number: string
  requester_name: string
  pickup_address: string
  delivery_address: string
  attention_mode?: 'TRANSPORTE_JRM' | 'RECOJO_CLIENTE' | null
  site_id?: string | null
  pickup_contact?: string | null
  pickup_phone?: string | null
  request_type?: string
  status: string
  created_at: string
  required_date?: string
  required_at?: string | null
  time_window?: string | null
  rescheduling?: RequestRescheduling
  contract_id?: string
  delivery_district?: string | null
  estimated_weight?: number | null
  service_cost?: number | null
  contracts?: {
    id: string
    code: string
    clients?: {
      business_name: string
    }
    contract_budgets?: Array<{
      balance_pen: number
      allocated_pen: number
    }>
  }
}

interface DispatchRequest {
  transport_request_id: string
  status: string
  document_type?: string
  document_number?: string
  transport_requests: {
    id?: string
    request_number: string
    pickup_address: string
    delivery_address: string
    request_type?: string
    required_date?: string | null
    required_at?: string | null
    time_window?: string | null
    rescheduling?: RequestRescheduling
    contracts?: { code: string } | null
    transport_request_items?: Array<{
      weight?: number
      quantity?: number
      volume_m3?: number
    }>
  }
}

function requestedAttention(request: { required_at?: string | null; required_date?: string | null; time_window?: string | null }) {
  if (request.required_at) return new Date(request.required_at).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short', hour12: false })
  return `${serviceDate(request.required_date)}${request.time_window ? ` · ${request.time_window}` : ''}`
}

interface Dispatch {
  id: string
  dispatch_number: string
  driver_name: string
  vehicle_plate: string
  scheduled_departure: string
  status: string
  estimated_distance_km?: number
  docs_required?: boolean
  docs_ready_at?: string | null
  docs_reissue?: boolean
  docs_reissue_reason?: string | null
  modalidad?: string | null
  tercero_salida_at?: string | null
  dispatch_requests?: DispatchRequest[]
}

const dispatchTone = (status: string): StatusTone =>
  status === 'PROGRAMADO' ? 'warning'
  : ['EN_CURSO', 'EN RUTA', 'RETORNO'].includes(status) ? 'info'
  : status === 'ESPERANDO_AUTORIZACION' ? 'special'
  : ['ENTREGADO', 'RETORNO_COMPLETADO', 'LIQUIDADO', 'CERRADO'].includes(status) ? 'success'
  : status === 'CANCELADO' ? 'danger' : 'neutral'

export default function DespachoPage() {
  const router = useRouter()
  const { canWrite, canRead } = usePermissions()
  const supabase = useMemo(() => createClient(), [])
  const [pendingRequests, setPendingRequests] = useState<TransportRequest[]>([])
  const [dispatches, setDispatches] = useState<Dispatch[]>([])
  const [vehicles, setVehicles] = useState<PlanningVehicle[]>([])
  const [drivers, setDrivers] = useState<PlanningDriver[]>([])
  
  const alertedDispatches = useRef<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)

  const [searchTerm, setSearchTerm] = useState('')
  const [filterStatus, setFilterStatus] = useState('TODOS')
  const [filterModalidad, setFilterModalidad] = useState('TODAS')

  const filteredDispatches = dispatches.filter(d => {
    const matchSearch = searchTerm === '' || 
      (d.dispatch_number || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (d.vehicle_plate || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (d.driver_name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      d.dispatch_requests?.some((r: DispatchRequest) => [r.transport_requests?.request_number, r.transport_requests?.contracts?.code].join(' ').toLowerCase().includes(searchTerm.toLowerCase()));
    const matchStatus = filterStatus === 'TODOS' || d.status === filterStatus;
    const matchModalidad = filterModalidad === 'TODAS' || (d.modalidad || 'PROPIA') === filterModalidad;
    return matchSearch && matchStatus && matchModalidad;
  })
  
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [selectedDispatchDetail, setSelectedDispatchDetail] = useState<Dispatch | null>(null)
  
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [calculatingDistance, setCalculatingDistance] = useState(false)
  const reqDistances = useRef<Record<string, number>>({})

  // Freight rate lookup state
  const [detectedFreightRate, setDetectedFreightRate] = useState<{ rate: number; district: string; zone: string } | null>(null)
  const [loadingRate, setLoadingRate] = useState(false)
  const [manualFreightCost, setManualFreightCost] = useState<string>('')
  // Cotización del tarifario con la placa real y todas las paradas (quote_transport)
  const [freightQuote, setFreightQuote] = useState<Record<string, unknown> | null>(null)
  // Unidad propia o de un transportista tercero que no usa el app
  const [modalidad, setModalidad] = useState<'PROPIA' | 'TERCERO'>('PROPIA')
  const [tercero, setTercero] = useState<TerceroForm>(TERCERO_VACIO)
  const [newDispatch, setNewDispatch] = useState<{
    selected_requests: { id: string, document_number: string }[],
    driver_name: string,
    vehicle_plate: string,
    scheduled_departure: string,
    estimated_distance_km: number | '',
    document_type: 'GR' | 'NOTA_SALIDA'
  }>({
    selected_requests: [],
    driver_name: '',
    vehicle_plate: '',
    scheduled_departure: '',
    estimated_distance_km: '',
    document_type: 'GR'
  })

  const [freightShares, setFreightShares] = useState<Record<string, string>>({})
  const selectedServices = newDispatch.selected_requests.map(selected => pendingRequests.find(r => r.id === selected.id)).filter((r): r is TransportRequest => !!r)
  const mixedOT = new Set(selectedServices.map(r => r.contract_id || 'SIN_OT')).size > 1
  const selectedDates = [...new Set(selectedServices.map(r => r.required_date?.slice(0,10)).filter((date): date is string => !!date))]
  const customerPickup = selectedServices[0]?.attention_mode === 'RECOJO_CLIENTE'
  const routeFreight = customerPickup ? 0 : modalidad === 'TERCERO'
    ? (Number(manualFreightCost) > 0 ? Number(manualFreightCost) : detectedFreightRate?.rate || 0)
    : (detectedFreightRate?.rate || Number(manualFreightCost) || 0)
  const defaultShares = splitFreight(routeFreight, selectedServices)
  const serviceShare = (id: string) => Number(freightShares[id] ?? defaultShares.find(r => r.id === id)?.amount ?? 0)
  const allocationMatches = Math.round(selectedServices.reduce((sum, r) => sum + serviceShare(r.id), 0) * 100) === Math.round(routeFreight * 100)
  const programmingRequests = () => newDispatch.selected_requests.map(req => ({ ...req,
    leg_planned_km: reqDistances.current[req.id] ?? null, freight_share_pen: serviceShare(req.id) }))

  // Districts known list for address parsing
  const DISTRICTS = [
    'San Juan de Lurigancho','San Juan de Miraflores','San Martin de Porres',
    'Villa el Salvador','Lima Cercado','Jesús María','Jesus Maria',
    'El Agustino','Punta Hermosa','Punta Negra','Puente Piedra',
    'Carabayllo','Lurigancho','Pachacamac','Chorrillos','Independencia',
    'Los Olivos','La Victoria','San Isidro','Santa Anita','Miraflores',
    'Surquillo','Ventanilla','Jicamarca','Huachipa','Barranco','Callao',
    'Chincha','Cañete','Canete','Comas','Huaral','Lurin','San Luis',
    'Ate','Ica','Pisco','Pucusana','Surco','Breña','Brena',
  ]
  const extractDistrict = (address: string): string => {
    const upper = address.toUpperCase()
    for (const d of DISTRICTS) {
      if (upper.includes(d.toUpperCase())) return d
    }
    const parts = address.split(',')
    return parts[parts.length - 1].trim()
  }

  const freightLookupId = useRef(0)
  const lookupFreightRate = async (plate: string, selectedReqIds: string[]) => {
    const lookupId = ++freightLookupId.current
    if (pendingRequests.some(r => selectedReqIds.includes(r.id) && r.attention_mode === 'RECOJO_CLIENTE')) { setDetectedFreightRate(null); setFreightQuote(null); setLoadingRate(false); return }
    if (!plate || selectedReqIds.length === 0) { setDetectedFreightRate(null); setFreightQuote(null); setLoadingRate(false); return }
    setLoadingRate(true)
    try {
      const selectedReqs = pendingRequests.filter(r => selectedReqIds.includes(r.id))
      const contractId = new Set(selectedReqs.map(r => r.contract_id)).size === 1 ? selectedReqs[0]?.contract_id : null

      const stops = selectedReqs
        .map(r => ({ district: r.delivery_district || extractDistrict(r.delivery_address || '') }))
        .filter(st => st.district)
      const weight = selectedReqs.reduce((sum, r) => sum + Number(r.estimated_weight || 0), 0)
      const { data, error } = await supabase.rpc('quote_transport', {
        p_contract_id: contractId || null, p_stops: stops, p_weight_kg: weight > 0 ? weight : null,
        p_vehicle_class: null, p_plate: plate === 'EXTERNO' ? null : plate, p_unloading: [],
      })
      if (lookupId !== freightLookupId.current) return
      if (error) throw error
      const q = data as Record<string, unknown>
      const main = ((q.lines || []) as { concept: string; district?: string }[]).find(l => l.concept === 'FLETE')
      setFreightQuote(q)
      setDetectedFreightRate(Number(q.freight_total) > 0
        ? { rate: Number(q.freight_total), district: main?.district || '', zone: String(q.vehicle_class || '') } : null)
    } catch {
      if (lookupId === freightLookupId.current) { setDetectedFreightRate(null); setFreightQuote(null) }
    } finally {
      if (lookupId === freightLookupId.current) setLoadingRate(false)
    }
  }

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      // 1. Obtener Solicitudes pendientes de asignar
      const { data: reqData, error: reqError } = await supabase
        .from('transport_requests')
        .select(`
          *,
          transport_request_items (
            weight,
            volume_m3,
            quantity
          ),
          contracts (
            id,
            code,
            clients (
              business_name
            ),
            contract_budgets (
              balance_pen,
              allocated_pen
            )
          )
        `)
        .in('status', ['APROBADA', 'REPROGRAMADA'])
        .order('required_date', { ascending: true })
        .order('created_at', { ascending: false })

      if (reqError) throw reqError
      const { data: history, error: historyError } = reqData?.length ? await supabase.rpc('get_transport_request_rescheduling', { p_request_ids: reqData.map(r => r.id) }) : { data: [], error: null }
      if (historyError) throw historyError
      setPendingRequests(withRescheduling(reqData || [], history || []))

      // 2. Obtener los despachos ya programados con sus múltiples solicitudes
      // Ahora usamos dispatch_requests
      const { data: dispatchData, error: dispatchError } = await supabase
        .from('dispatches')
        .select(`
          id, dispatch_number, driver_name, vehicle_plate, scheduled_departure, status, estimated_distance_km,
          docs_required, docs_ready_at, docs_reissue, docs_reissue_reason, modalidad, tercero_salida_at,
          dispatch_requests (
            transport_request_id,
            status,
            document_type,
            document_number,
            transport_requests (
              id,
              request_number,
              request_type,
              required_date,
              required_at,
              time_window,
              contracts(code),
              pickup_address,
              delivery_address,
              transport_request_items (
                weight,
                volume_m3,
                quantity
              )
            )
          )
        `)
        .in('status', ['PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'RETORNO', 'RETORNO_COMPLETADO', 'ESPERANDO_AUTORIZACION', 'ENTREGADO'])
        .order('created_at', { ascending: false })

      if (dispatchError) throw dispatchError
      if (!dispatchData) {
        // Set vacío para evitar null
        setDispatches([])
      } else {
        const fetchedDispatches = dispatchData as unknown as Dispatch[] || []
        const assignedIds = fetchedDispatches.flatMap(d => (d.dispatch_requests || []).map(r => r.transport_request_id))
        const { data: assignedHistory, error: assignedHistoryError } = assignedIds.length
          ? await supabase.rpc('get_transport_request_rescheduling', { p_request_ids: [...new Set(assignedIds)] })
          : { data: [], error: null }
        if (assignedHistoryError) throw assignedHistoryError
        setDispatches(fetchedDispatches.map(d => ({ ...d, dispatch_requests: d.dispatch_requests?.map(r => ({ ...r,
          transport_requests: { ...r.transport_requests, rescheduling: (assignedHistory || []).find((h: RequestRescheduling) => h.request_id === r.transport_request_id) },
        })) })))
        
        // Disparar alertas para los que ya están ESPERANDO_AUTORIZACION
        let shouldAlert = false
        fetchedDispatches.forEach(d => {
          if (d.status === 'ESPERANDO_AUTORIZACION' && !alertedDispatches.current.has(d.id)) {
            toast.error(`⚠️ ATENCIÓN: El despacho ${d.dispatch_number} espera autorización de retorno.`, { duration: 10000 })
            alertedDispatches.current.add(d.id)
            shouldAlert = true
          }
        })
        
        if (shouldAlert) {
          try {
            const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3')
            audio.play().catch(e => console.log('Auto-play prevent:', e))
          } catch(e) {}
        }
      }

      // 3. Obtener vehículos y conductores para el select
      const { data: vData } = await supabase.from('vehicles').select('plate, brand, model, assigned_driver_id, carriers(business_name)').eq('status', 'DISPONIBLE')
      const { data: dData } = await supabase.from('drivers')
        .select('id, first_name, last_name, document_number, profile_id, carriers(business_name)')
        .eq('is_active', true).not('profile_id', 'is', null)
      
      setVehicles((vData || []).map(vehicle => ({ ...vehicle, carriers: Array.isArray(vehicle.carriers) ? vehicle.carriers[0] || null : vehicle.carriers })))
      setDrivers((dData || []).map(driver => ({ ...driver, carriers: Array.isArray(driver.carriers) ? driver.carriers[0] || null : driver.carriers })))

    } catch (error) {
      toast.error('Error al cargar datos de despacho: ' + errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [supabase])

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void fetchData(), 0)

    // Suscripción a cambios en tiempo real
    const channel = supabase.channel('dispatches_changes')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'dispatches'
        },
        (payload) => {
          if (payload.new.status === 'ESPERANDO_AUTORIZACION' && payload.old.status !== 'ESPERANDO_AUTORIZACION') {
            toast.error(`⚠️ ATENCIÓN: El despacho ${payload.new.dispatch_number} espera autorización de retorno.`, { duration: 10000 })
            // Intentar reproducir sonido
            try {
              const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3')
              audio.play().catch(e => console.log('Auto-play prevent:', e))
            } catch(e) {}
            fetchData()
          }
        }
      )
      .subscribe()

    return () => {
      window.clearTimeout(initialLoad)
      void supabase.removeChannel(channel)
    }
  }, [fetchData, supabase])

  const handleProgramar = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newDispatch.selected_requests.length === 0) {
      toast.error('Debes seleccionar al menos una solicitud.')
      return
    }

    const selectedReqsFull = pendingRequests.filter(pr => newDispatch.selected_requests.some(sr => sr.id === pr.id))
    const isPickup = selectedReqsFull[0]?.attention_mode === 'RECOJO_CLIENTE'
    if (selectedReqsFull.some(r => !r.attention_mode || (r.attention_mode === 'RECOJO_CLIENTE') !== isPickup)) {
      toast.error('Defina la modalidad en Solicitudes; no mezcle recojos por cliente y transporte JRM.'); return
    }
    if (mixedOT && !allocationMatches) { toast.error('La suma del flete por servicio debe coincidir con el total de la ruta.'); return }
    // El servidor valida la reserva vigente y el gasto autorizado; saldo cero puede ser una reserva propia.
    setIsSubmitting(true)
    if (modalidad === 'TERCERO' && newDispatch.document_type === 'GR') {
      try {
        if (!tercero.carrier_id || !tercero.placa.trim() || !tercero.conductor.trim() || !tercero.telefono.trim() || !tercero.doc.trim()) {
          throw new Error('Complete transportista, placa, chofer, documento de identidad y celular del tercero.')
        }
        const firstReq = pendingRequests.find(r => r.id === newDispatch.selected_requests[0].id)
        const freightCost = Number(manualFreightCost) > 0 ? Number(manualFreightCost) : (detectedFreightRate?.rate || 0)
        const { data: newDispatchId, error } = await supabase.rpc('schedule_dispatch_tercero', {
          p_carrier_id: tercero.carrier_id, p_plate: tercero.placa, p_conductor: tercero.conductor, p_telefono: tercero.telefono,
          p_doc: tercero.doc || null, p_departure: new Date(newDispatch.scheduled_departure).toISOString(),
          p_estimated_km: isPickup ? 0 : Number(newDispatch.estimated_distance_km) || 0, p_freight_cost: freightCost,
          p_contract_id: firstReq?.contracts?.id || null,
          p_requests: programmingRequests(),
        })
        if (error) throw error
        if (!isPickup && newDispatchId && freightQuote && detectedFreightRate?.rate && freightCost === detectedFreightRate.rate) {
          await supabase.rpc('set_dispatch_freight_quote', { p_dispatch_id: newDispatchId, p_breakdown: freightQuote })
        }
        toast.success('Servicio programado. El acceso del proveedor está listo para compartir.')
        if (newDispatchId) {
          const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(newDispatch.scheduled_departure))
          router.push(`/torre-control?despacho=${newDispatchId}&fecha=${day}&proveedor=1`)
        }
        setIsModalOpen(false)
        setNewDispatch({ selected_requests: [], driver_name: '', vehicle_plate: '', scheduled_departure: '', estimated_distance_km: '', document_type: 'GR' })
        setManualFreightCost(''); setTercero(TERCERO_VACIO); setModalidad('PROPIA')
        fetchData()
      } catch (error) {
        toast.error('Error al programar el despacho: ' + (error instanceof Error ? error.message : (error as { message?: string })?.message || String(error)))
      } finally {
        setIsSubmitting(false)
      }
      return
    }
    try {
      const matches = drivers.filter(d => `${d.first_name} ${d.last_name}`.trim() === newDispatch.driver_name.trim())
      if (newDispatch.document_type !== 'NOTA_SALIDA' && matches.length !== 1) {
        throw new Error('Selecciona un conductor activo y vinculado a una sola cuenta.')
      }

      // NOTA_SALIDA = recojo por cliente: no requiere vehículo ni conductor propio (bypass legítimo)
      // GR = despacho con vehículo propio: validación de elegibilidad obligatoria
      if (newDispatch.document_type !== 'NOTA_SALIDA') {
        // Fail-safe: si falta placa o conductor para un GR, bloquear — no saltar validación
        if (!newDispatch.vehicle_plate || !matches[0]?.id) {
          toast.error('Para despachos GR debes seleccionar vehículo y conductor antes de programar.')
          setIsSubmitting(false)
          return
        }
        const eligibility = await checkDispatchEligibility(newDispatch.vehicle_plate, matches[0].id)
        if (eligibility.status === 'BLOQUEADO') {
          const reasons = [...eligibility.blocking_reasons, ...eligibility.observation_reasons].join('; ')
          toast.error(`Despacho bloqueado: ${reasons}`)
          setIsSubmitting(false)
          return
        }
        if (eligibility.status === 'APTO_CON_OBSERVACION') {
          const reasons = eligibility.observation_reasons.join('; ')
          const proceed = window.confirm(`El despacho tiene observaciones: ${reasons}. ¿Desea proceder de todos modos?`)
          if (!proceed) {
            setIsSubmitting(false)
            return
          }
        }
      }

      const firstReq = pendingRequests.find(r => r.id === newDispatch.selected_requests[0].id)
      const freightCost = isPickup ? 0 : detectedFreightRate?.rate && detectedFreightRate.rate > 0
        ? detectedFreightRate.rate : (Number(manualFreightCost) || 0)
      const { data: newDispatchId, error } = await supabase.rpc('schedule_dispatch', {
        p_driver_id: isPickup ? null : matches[0]?.id || null,
        p_vehicle_plate: isPickup ? 'EXTERNO' : newDispatch.vehicle_plate,
        p_departure: new Date(newDispatch.scheduled_departure).toISOString(),
        p_estimated_km: isPickup ? 0 : Number(newDispatch.estimated_distance_km) || 0,
        p_freight_cost: freightCost,
        p_contract_id: firstReq?.contracts?.id || null,
        p_document_type: newDispatch.document_type,
        p_requests: programmingRequests()
      })
      if (error) throw error
      // Se guarda con qué tarifa se calculó el flete (si vino del tarifario)
      if (!isPickup && newDispatchId && freightQuote && detectedFreightRate?.rate && freightCost === detectedFreightRate.rate) {
        await supabase.rpc('set_dispatch_freight_quote', { p_dispatch_id: newDispatchId, p_breakdown: freightQuote })
      }
      toast.success(isPickup ? 'Recojo por el cliente programado con Nota de Salida y sin flete JRM.' : 'Despacho programado y financiamiento validado.')
      setIsModalOpen(false)
      setNewDispatch({ selected_requests: [], driver_name: '', vehicle_plate: '', scheduled_departure: '', estimated_distance_km: '', document_type: 'GR' })
      setManualFreightCost('')
      fetchData()
    } catch (error) {
      toast.error('Error al programar el despacho: ' + errorMessage(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  // Solo un despacho PROGRAMADO se cancela: libera la partida, anula el flete y devuelve las solicitudes a aprobadas
  const handleCancelDispatch = async (dispatchId: string, dispatchNumber: string) => {
    const reason = prompt(`Motivo de la cancelación del despacho ${dispatchNumber}:`)
    if (!reason?.trim()) return
    try {
      const { data, error } = await supabase.rpc('cancel_dispatch', { p_dispatch_id: dispatchId, p_reason: reason.trim() })
      if (error || (data && !data.success)) throw new Error(error?.message || data?.error || 'No se pudo cancelar')
      toast.success('Despacho cancelado: se liberó la partida y las solicitudes volvieron a aprobadas.')
      fetchData()
    } catch (err) {
      toast.error('Error al cancelar: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const toggleRequestSelection = async (reqId: string, pickup: string, delivery: string) => {
    const isSelected = newDispatch.selected_requests.some(r => r.id === reqId)
    const request = pendingRequests.find(r => r.id === reqId)
    if (!isSelected && !request?.attention_mode) { toast.error('Defina la modalidad en Solicitudes antes de programar este requerimiento histórico.'); return }
    const existing = pendingRequests.find(r => newDispatch.selected_requests.some(x => x.id === r.id))
    if (!isSelected && existing && (existing.attention_mode !== request?.attention_mode || existing.site_id !== request?.site_id)) {
      toast.error('Agrupe solicitudes de la misma modalidad y sede. Puede combinar OT, entregas, recojos y traslados.'); return
    }
    setFreightShares({})
    const pickupByCustomer = request?.attention_mode === 'RECOJO_CLIENTE'
    if (!isSelected && pickupByCustomer) {
      setNewDispatch(prev => ({ ...prev, selected_requests: [...prev.selected_requests, { id: reqId, document_number: '' }], document_type: 'NOTA_SALIDA', driver_name: '', vehicle_plate: '', estimated_distance_km: '' }))
      freightLookupId.current++; setLoadingRate(false); setDetectedFreightRate(null); setFreightQuote(null); setManualFreightCost(''); setModalidad('PROPIA'); return
    }
    let nextRequests: { id: string, document_number: string }[]
    
    if (isSelected) {
      nextRequests = newDispatch.selected_requests.filter(r => r.id !== reqId)
      setNewDispatch(prev => ({ ...prev, selected_requests: nextRequests, document_type: nextRequests.length && pickupByCustomer ? 'NOTA_SALIDA' : 'GR' }))

      // Restar distancia (si ya estaba calculada)
      const distanceToSubtract = reqDistances.current[reqId]
      if (distanceToSubtract) {
        setNewDispatch(prev => {
          const currentKm = Number(prev.estimated_distance_km) || 0
          const newDistance = Math.max(0, currentKm - distanceToSubtract)
          return { ...prev, estimated_distance_km: newDistance === 0 ? '' : parseFloat(newDistance.toFixed(1)) }
        })
      }
    } else {
      nextRequests = [...newDispatch.selected_requests, { id: reqId, document_number: '' }]
      setNewDispatch(prev => ({ ...prev, selected_requests: nextRequests, document_type: nextRequests.length && pickupByCustomer ? 'NOTA_SALIDA' : 'GR' }))
      
      // Si ya tenemos la distancia en caché, la sumamos al instante
      if (reqDistances.current[reqId]) {
        setNewDispatch(prev => {
          const currentKm = Number(prev.estimated_distance_km) || 0
          return { ...prev, estimated_distance_km: parseFloat((currentKm + reqDistances.current[reqId]).toFixed(1)) }
        })
      } else {
        // Si no la tenemos, bloqueamos UI y consultamos la API
        setCalculatingDistance(true)
        const loadingToast = toast.loading('Calculando ruta sugerida...')
        try {
          const km = await calculateRouteDistance(pickup, delivery)
          if (km) {
            reqDistances.current[reqId] = km // Guardar en caché para la próxima
            
            setNewDispatch(prev => {
              // Control anti-cruce: Solo sumar si el usuario NO LO DESMARCÓ mientras esperábamos la API
              if (!prev.selected_requests.some(r => r.id === reqId)) return prev;

              const currentKm = Number(prev.estimated_distance_km) || 0
              return { ...prev, estimated_distance_km: parseFloat((currentKm + km).toFixed(1)) }
            })
            toast.success(`+${km.toFixed(1)} KM agregados`, { id: loadingToast })
          } else {
            toast.error('No se pudo geocodificar la ruta.', { id: loadingToast })
          }
        } catch (e) {
          toast.error('Error al calcular distancia', { id: loadingToast })
        } finally {
          setCalculatingDistance(false)
        }
      }
    }

    // Always re-lookup freight rate after selection changes
    const updatedIds = isSelected
      ? newDispatch.selected_requests.filter(r => r.id !== reqId).map(r => r.id)
      : [...newDispatch.selected_requests.map(r => r.id), reqId]
    lookupFreightRate(modalidad === 'TERCERO' ? 'EXTERNO' : newDispatch.vehicle_plate, updatedIds)
  }

  return (
    <div className="space-y-6 w-full mx-auto">
      <TransportWorkflow current="programacion" />
      <PageHeader title="Programación de Despachos y Ruteo" description="Asignación de unidades de transporte a Solicitudes" actions={<>
        <ReportarFallaButton />
        {canWrite('despacho') && (
          <button 
            onClick={() => setIsModalOpen(true)}
            className="flex min-h-11 items-center gap-2 rounded-lg bg-jrm-navy px-4 py-2 font-medium text-white shadow-sm transition-colors hover:bg-jrm-navy-dark"
          >
            <Plus className="w-4 h-4" />
            Armar Ruta
          </button>
        )}
      </>} />

      <div aria-label="Resumen operativo" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiStatCard label="Solicitudes por asignar" icon={<FileText className="h-5 w-5" />} tone="amber" loading={loading} value={pendingRequests.length} />
        <KpiStatCard label="Programados" icon={<Clock className="h-5 w-5" />} tone="navy" loading={loading} value={dispatches.filter(d => d.status === 'PROGRAMADO').length} />
        <KpiStatCard label="En ruta" icon={<Route className="h-5 w-5" />} tone="blue" loading={loading} value={dispatches.filter(d => ['EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO'].includes(d.status)).length} />
        <KpiStatCard label="Por cerrar" icon={<PackageCheck className="h-5 w-5" />} tone="emerald" loading={loading} value={dispatches.filter(d => ['ENTREGADO', 'RETORNO_COMPLETADO'].includes(d.status)).length} />
      </div>

      <div className="flex flex-col gap-6">
        
        {/* Sección Superior: OTs Pendientes */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
            <FileText className="w-5 h-5 text-blue-600" />
            Solicitudes por Asignar ({pendingRequests.length})
          </h2>
          
          <div className="flex overflow-x-auto gap-4 pb-4 snap-x">
            {loading ? (
              <div className="p-8 w-full text-center text-slate-500 bg-white rounded-xl border border-slate-200">
                <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                Cargando...
              </div>
            ) : pendingRequests.length === 0 ? (
              <div className="p-6 w-full text-center text-slate-500 bg-white rounded-xl border border-slate-200 shadow-sm text-sm">
                No hay solicitudes pendientes de asignación.
              </div>
            ) : (
              pendingRequests.map(req => {
                const isRecojo = req.request_type === 'RECOJO'
                const isTraslado = req.request_type === 'TRASLADO'
                const typeLabel = req.request_type || (isRecojo ? 'RECOJO' : 'DESPACHO')
                
                let typeColor = 'bg-emerald-100 text-emerald-700 border-emerald-200'
                if (isRecojo) typeColor = 'bg-orange-100 text-orange-700 border-orange-200'
                if (isTraslado) typeColor = 'bg-purple-100 text-purple-700 border-purple-200'
                
                return (
                  <div key={req.id} className="min-w-[300px] w-[300px] bg-white p-4 rounded-xl shadow-sm border border-l-4 border-l-blue-500 border-slate-200 hover:shadow-md transition-shadow snap-start">
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex flex-col gap-1">
                        <span className="font-bold text-[#002855] text-sm">{req.request_number}</span>
                        {wasRescheduled(req) && <span className="text-[10px] bg-orange-100 text-orange-800 px-1.5 py-0.5 rounded font-semibold border border-orange-200">Reprogramado</span>}
                        <span className="text-xs text-slate-600">Atención requerida · Lima: <b>{requestedAttention(req)}</b></span>
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded font-bold border ${typeColor} whitespace-nowrap h-fit`}>
                        {typeLabel}
                      </span>
                    </div>
                    <p className="text-sm font-semibold text-slate-800 mb-1 truncate" title={req.requester_name}>{req.requester_name}</p>
                    {req.contracts?.clients?.business_name && (
                      <p className="text-xs font-medium text-[#002855] mb-1 truncate" title={req.contracts.clients.business_name}>
                        {req.contracts.clients.business_name}
                      </p>
                    )}
                    <div className="text-xs text-slate-500 flex flex-col gap-1 mt-2">
                      <div className="flex items-start gap-1">
                        <MapPin className="w-3 h-3 mt-0.5 flex-shrink-0 text-blue-500" />
                        <span className="truncate" title={req.pickup_address}>{req.pickup_address}</span>
                      </div>
                      <div className="flex items-start gap-1">
                        <MapPin className="w-3 h-3 mt-0.5 flex-shrink-0 text-red-400" />
                        <span className="truncate" title={req.delivery_address}>{req.delivery_address}</span>
                      </div>
                      
                      {/* Presupuesto Alert */}
                      {req.contracts && req.contracts.contract_budgets && req.contracts.contract_budgets.length > 0 && (
                        <div className={`mt-2 p-1.5 rounded border text-[10px] font-bold flex justify-between items-center ${
                          (req.contracts.contract_budgets[0].balance_pen || 0) < 500 
                            ? 'bg-red-50 text-red-700 border-red-200' 
                            : 'bg-slate-50 text-slate-700 border-slate-200'
                        }`}>
                          <span>{req.contracts.code}</span>
                          <span>Saldo: S/ {(req.contracts.contract_budgets[0].balance_pen || 0).toLocaleString('es-PE')}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* Sección Inferior: Despachos Programados */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
            <Truck className="w-5 h-5 text-green-600" />
            Despachos / Rutas Programadas
          </h2>

          {/* Filtros y Búsqueda */}
          <FilterToolbar label="Búsqueda y filtros de despachos" onClear={() => { setSearchTerm(''); setFilterStatus('TODOS'); setFilterModalidad('TODAS') }}>
            <label className="relative min-w-0 flex-1 basis-60">
              <span className="sr-only">Buscar despachos</span><Search className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" aria-hidden="true" />
              <input type="search" placeholder="Buscar por nro, placa, conductor u OT…" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className={`${filterControl} pl-9`} />
            </label>
            <FilterField label="Estado" className="w-52">
              <select className={filterControl} value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
                <option value="TODOS">Todos</option>
                <option value="PROGRAMADO">Programado</option>
                <option value="EN RUTA">En Ruta</option>
                <option value="RETORNO">Retorno</option>
                <option value="RETORNO_COMPLETADO">Retorno completado</option>
                <option value="CERRADO">Cerrado</option>
                <option value="LIQUIDADO">Cerrado (ruta cerrada)</option>
              </select>
            </FilterField>
            <FilterField label="Unidad" className="w-44">
              <select className={filterControl} value={filterModalidad} onChange={(e) => setFilterModalidad(e.target.value)}>
                <option value="TODAS">Todas</option>
                <option value="PROPIA">Flota propia</option>
                <option value="TERCERO">Tercerizada</option>
              </select>
            </FilterField>
          </FilterToolbar>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="overflow-auto max-h-[calc(100vh-220px)]">
          <DataTable className="w-full text-left border-collapse relative">
            <thead className="bg-slate-50 text-slate-500 text-xs text-left sticky top-0 z-10 shadow-[0_1px_0_0_#e2e8f0] border-slate-100 uppercase tracking-wider">
                  <tr>
                    <th className="p-4 font-semibold whitespace-nowrap">Despacho</th>
                    <th className="p-4 font-semibold whitespace-nowrap">Unidad / Chofer</th>
                    <th className="p-4 font-semibold whitespace-nowrap text-right">Dist. (KM)</th>
                    <th className="p-4 font-semibold">Solicitudes (Ruta)</th>
                    <th className="p-4 font-semibold whitespace-nowrap">Salida confirmada · Lima</th>
                    <th className="p-4 font-semibold whitespace-nowrap">Estado</th>
                    <th className="p-4 font-semibold text-right whitespace-nowrap">Acción</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {loading ? (
                    <tr>
                      <td colSpan={7} className="p-8 text-center text-slate-500">
                        <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                        Cargando despachos...
                      </td>
                    </tr>
                  ) : filteredDispatches.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="p-8 text-center text-slate-500">
                        No hay despachos registrados.
                      </td>
                    </tr>
                  ) : (
                    filteredDispatches.map(dispatch => (
                      <tr key={dispatch.id} className="hover:bg-slate-50 transition-colors">
                        <td className="p-4">
                          <button 
                            onClick={() => setSelectedDispatchDetail(dispatch)}
                            className="font-bold text-[#002855] text-sm hover:underline hover:text-blue-600 transition-all text-left"
                          >
                            {dispatch.dispatch_number}
                          </button>
                        </td>
                        <td className="p-4">
                          <div className="flex flex-col">
                            <span className="font-bold text-[#002855] text-sm uppercase flex items-center gap-1.5">
                              {dispatch.vehicle_plate}
                              {dispatch.modalidad === 'TERCERO' && <span className="text-[10px] normal-case font-bold bg-violet-100 text-violet-700 border border-violet-200 px-1.5 py-0.5 rounded">Tercero</span>}
                            </span>
                            <span className="text-xs text-slate-500">{dispatch.driver_name}</span>
                          </div>
                        </td>
                        <td className="p-4 text-sm font-semibold text-slate-700 text-right">
                          {dispatch.estimated_distance_km ? `${dispatch.estimated_distance_km} KM` : '-'}
                        </td>
                        <td className="p-4 text-xs text-slate-600">
                          {dispatch.dispatch_requests && dispatch.dispatch_requests.length > 0 ? (
                            (() => {
                              const reqs = dispatch.dispatch_requests;
                              const recojos = reqs.filter(r => r.transport_requests.request_type === 'RECOJO').length;
                              const traslados = reqs.filter(r => r.transport_requests.request_type === 'TRASLADO').length;
                              const despachos = reqs.filter(r => !r.transport_requests.request_type || r.transport_requests.request_type === 'DESPACHO').length;
                              
                              const tooltipText = reqs.map(r => `${r.transport_requests.request_number} · OT ${r.transport_requests.contracts?.code || 'sin OT'}`).join(', ');

                              return (
                                <div className="flex flex-col gap-1.5" title={tooltipText}>
                                  <div className="font-bold text-slate-700">{reqs.length} servicio{reqs.length !== 1 ? 's' : ''} · {new Set(reqs.map(r => r.transport_requests.contracts?.code).filter(Boolean)).size} OT</div>
                                  <details className="rounded-lg border border-slate-200 bg-white p-2"><summary className="cursor-pointer font-semibold text-[#002855]">Ver servicios y fechas solicitadas</summary><ul className="mt-2 space-y-2">{reqs.map(r => <li key={r.transport_request_id} className="border-t border-slate-100 pt-2"><p className="font-semibold">{r.transport_requests.request_number} · {r.transport_requests.contracts?.code ? `OT ${r.transport_requests.contracts.code}` : 'Sin OT'}</p><p>{r.transport_requests.request_type === 'RECOJO' ? 'Recojo' : r.transport_requests.request_type === 'TRASLADO' ? 'Punto a punto' : 'Entrega'} · Solicitada · Lima: {requestedAttention(r.transport_requests)}</p>{r.transport_requests.rescheduling && <p className="font-semibold text-amber-800">Reprogramado · {serviceDate(r.transport_requests.rescheduling.fecha_anterior)} → {serviceDate(r.transport_requests.rescheduling.fecha_nueva)}</p>}</li>)}</ul></details>
                                  <div className="flex flex-wrap gap-1">
                                    {recojos > 0 && <span className="bg-orange-50 text-orange-700 text-[10px] px-1.5 py-0.5 rounded font-semibold border border-orange-200">Recojos: {recojos}</span>}
                                    {despachos > 0 && <span className="bg-emerald-50 text-emerald-700 text-[10px] px-1.5 py-0.5 rounded font-semibold border border-emerald-200">Despachos: {despachos}</span>}
                                    {traslados > 0 && <span className="bg-purple-50 text-purple-700 text-[10px] px-1.5 py-0.5 rounded font-semibold border border-purple-200">Traslados: {traslados}</span>}
                                  </div>
                                </div>
                              );
                            })()
                          ) : (
                            <span className="text-slate-400">Sin detalles</span>
                          )}
                        </td>
                        <td className="p-4 text-sm text-slate-600">
                          <div className="flex items-center gap-1">
                            <Calendar className="w-3 h-3" />
                            {new Date(dispatch.scheduled_departure).toLocaleString('es-PE', { timeZone: 'America/Lima' })}
                          </div>
                        </td>
                        <td className="p-4">
                          <StatusBadge tone={dispatchTone(dispatch.status)}>{dispatchStatusLabel(dispatch.status)}</StatusBadge>
                          {dispatch.status === 'PROGRAMADO' && dispatch.docs_required && (
                            <div className={`mt-1 text-[10px] font-semibold ${dispatch.docs_reissue ? 'text-red-600' : dispatch.docs_ready_at ? 'text-emerald-600' : 'text-amber-600'}`}
                              title={dispatch.docs_reissue_reason || undefined}>
                              {dispatch.docs_reissue ? 'Guías por reemitir' : dispatch.docs_ready_at ? 'Documentos listos' : 'Documentos pendientes'}
                            </div>
                          )}
                        </td>
                        <td className="p-4 text-right">
                          {(canRead('documentario') || canRead('packing-list') || canRead('planificacion')) && <Link href={`/despacho/documentos?despacho=${dispatch.id}&vista=${dispatch.status === 'PROGRAMADO' ? 'salida' : 'historial'}&desde=${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(dispatch.scheduled_departure))}`} className="mb-2 inline-flex min-h-11 items-center gap-1 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-[#002855]"><FileText className="h-4 w-4" />Documentos</Link>}
{(canRead('torre-control') || canRead('despacho')) && <Link href={`/torre-control?despacho=${dispatch.id}&fecha=${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(dispatch.scheduled_departure))}`} className="mb-2 ml-1 inline-flex min-h-11 items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-3 text-xs font-semibold text-[#002855]"><Truck className="h-4 w-4" />Gestionar operación</Link>}
                          {canWrite('despacho') && dispatch.status === 'PROGRAMADO' && (
                            <button
                              onClick={() => handleCancelDispatch(dispatch.id, dispatch.dispatch_number)}
                              className="ml-1 inline-flex items-center gap-1 px-3 py-1.5 bg-red-50 text-red-700 hover:bg-red-100 transition-colors rounded-lg text-xs font-medium border border-red-200 whitespace-nowrap"
                            >
                              <XCircle className="w-3 h-3" />
                              Cancelar
                            </button>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </DataTable>
            </div>
          </div>
        </div>

      </div>

      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="Armar Ruta y Programar Unidad"
        maxWidth="max-w-5xl"
      >
        <form onSubmit={handleProgramar} className="flex flex-col lg:flex-row gap-6">
          {/* Columna Izquierda: Datos del Viaje */}
          <div className="lg:w-1/3 flex flex-col gap-4">
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 shadow-sm">
              <h4 className="font-semibold text-[#002855] flex items-center gap-2 mb-4">
                <FileText className="w-4 h-4" />
                Documento de Salida
              </h4>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Modalidad heredada de la solicitud</label>
                  <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-[#002855]">{newDispatch.selected_requests.length ? newDispatch.document_type === 'NOTA_SALIDA' ? 'Recojo por el cliente · Nota de Salida' : 'Transporte JRM · Guía de Remisión' : 'Seleccione una solicitud'}</div>
                  <p className="mt-1 text-xs text-slate-500">Para cambiar la modalidad, edite la solicitud y vuelva a aprobarla.</p>
                </div>
              </div>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 shadow-sm">
              <h4 className="font-semibold text-[#002855] flex items-center gap-2 mb-4">
                <Truck className="w-4 h-4" />
                Datos del Vehículo
              </h4>
              
              {newDispatch.document_type === 'NOTA_SALIDA' && <p className="mb-3 rounded-lg bg-blue-50 p-3 text-sm text-blue-800">Retiro coordinado por el cliente. Sin conductor propio, monitoreo GPS ni reserva de flete JRM. El Asistente Documentario confirma la Nota de Despacho antes de la salida.</p>}
              <div className="space-y-3">
                {newDispatch.document_type === 'GR' && (
                  <div className="grid grid-cols-2 gap-1 p-1 bg-white border border-slate-200 rounded-lg text-xs font-semibold">
                    {(['PROPIA', 'TERCERO'] as const).map(m => (
                      <button key={m} type="button"
                        onClick={() => {
                          setModalidad(m)
                          lookupFreightRate(m === 'TERCERO' ? 'EXTERNO' : newDispatch.vehicle_plate, newDispatch.selected_requests.map(r => r.id))
                        }}
                        className={`py-1.5 rounded-md ${modalidad === m ? 'bg-[#002855] text-white' : 'text-slate-600 hover:bg-slate-50'}`}>
                        {m === 'PROPIA' ? 'Unidad propia' : 'Tercero'}
                      </button>
                    ))}
                  </div>
                )}
                {newDispatch.document_type === 'GR' && modalidad === 'TERCERO' ? (
                  <>
                    <TerceroFields value={tercero} onChange={setTercero} />
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Flete pactado con el proveedor (S/)</label>
                      <input type="number" min="0" step="0.01"
                        className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none text-sm"
                        value={manualFreightCost} onChange={e => setManualFreightCost(e.target.value)}
                        placeholder={detectedFreightRate ? `Tarifario: ${detectedFreightRate.rate}` : 'Monto acordado'} />
                      {loadingRate && <p className="text-xs text-slate-400 flex items-center gap-1 mt-1"><Loader2 className="w-3 h-3 animate-spin" /> Buscando tarifa...</p>}
                      <p className="text-[11px] text-slate-500 mt-1">
                        {Number(manualFreightCost) > 0 ? 'Se usará el monto pactado.' : detectedFreightRate ? `Vacío = se toma el tarifario (S/ ${detectedFreightRate.rate.toLocaleString('es-PE')}).` : 'Sin tarifa en el tarifario para esta ruta: indique el monto.'}
                        {' '}Se reserva en la partida de la OT a nombre del proveedor.
                      </p>
                    </div>
                  </>
                ) : newDispatch.document_type === 'GR' ? (
                  <>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Placa del Vehículo</label>
                      <SearchableSelect
                        value={newDispatch.vehicle_plate}
                        onChange={(val) => {
                          const plate = val
                          const assigned = drivers.find(d => d.id === vehicles.find(v => v.plate === plate)?.assigned_driver_id)
                          setNewDispatch({...newDispatch, vehicle_plate: plate, driver_name: assigned ? `${assigned.first_name} ${assigned.last_name}` : newDispatch.driver_name})
                          lookupFreightRate(plate, newDispatch.selected_requests.map(r => r.id))
                        }}
                        options={vehicles.map(v => ({ value: v.plate, label: `${v.plate} - ${v.brand} ${v.model} (${v.carriers?.business_name})` }))}
                        placeholder="Seleccione vehículo..."
                      />
                      {/* Tarifa detectada */}
                      {loadingRate && (
                        <p className="text-xs text-slate-400 flex items-center gap-1 mt-1"><Loader2 className="w-3 h-3 animate-spin" /> Buscando tarifa...</p>
                      )}
                      {!loadingRate && detectedFreightRate && (
                        <div className="mt-2 p-2 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center gap-2">
                          <Tag className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                          <div>
                            <p className="text-xs font-bold text-emerald-800">Flete según tarifario: <span className="text-base">S/ {detectedFreightRate.rate.toLocaleString('es-PE')}</span></p>
                            <p className="text-[10px] text-emerald-600">{detectedFreightRate.zone}{newDispatch.selected_requests.length > 1 ? ` · ${newDispatch.selected_requests.length} paradas` : ''}</p>
                            {(() => {
                              const estimated = pendingRequests.filter(r => newDispatch.selected_requests.some(sr => sr.id === r.id))
                                .reduce((sum, r) => sum + Number(r.service_cost || 0), 0)
                              const diff = detectedFreightRate.rate - estimated
                              return estimated > 0 && Math.abs(diff) >= 0.01 ? (
                                <p className={`text-[10px] font-semibold ${diff > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
                                  Estimado en las solicitudes: S/ {estimated.toLocaleString('es-PE')} ({diff > 0 ? '+' : ''}{diff.toLocaleString('es-PE')})
                                </p>
                              ) : null
                            })()}
                          </div>
                        </div>
                      )}
                      
                      {!loadingRate && freightQuote && <QuoteBreakdown quote={freightQuote} compact />}
                      {!loadingRate && !detectedFreightRate && newDispatch.vehicle_plate && newDispatch.selected_requests.length > 0 && !freightQuote && (
                        <p className="text-xs text-slate-400 mt-1">Sin tarifa registrada para esta ruta.</p>
                      )}
                    </div>
                    
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Conductor</label>
                      <SearchableSelect
                        value={newDispatch.driver_name}
                        onChange={(val) => setNewDispatch({...newDispatch, driver_name: val})}
                        options={drivers.map(d => ({ value: `${d.first_name} ${d.last_name}`, label: `${d.first_name} ${d.last_name} - ${d.document_number} (${d.carriers?.business_name})` }))}
                        placeholder="Seleccione conductor..."
                      />
                    </div>
                  </>
                ) : (
                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700 mb-3">
                    Nota de salida seleccionada. El cliente recoge, no requiere asignar conductor ni vehículo.
                  </div>
                )}

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Fecha Programada Salida</label>
                  <input 
                    type="datetime-local" 
                    aria-label="Fecha Programada Salida"
                    required
                    className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none text-sm"
                    value={newDispatch.scheduled_departure}
                    onChange={(e) => setNewDispatch({...newDispatch, scheduled_departure: e.target.value})}
                  />
                  {selectedDates.length === 1 && <button type="button" onClick={() => setNewDispatch(current => ({ ...current, scheduled_departure: `${selectedDates[0]}T${current.scheduled_departure.slice(11,16) || '08:00'}` }))} className="mt-2 min-h-11 text-xs font-semibold text-blue-700 underline">Usar fecha requerida: {serviceDate(selectedDates[0])}</button>}
                  {selectedDates.length > 1 && <p className="mt-2 text-xs text-amber-800">Las solicitudes tienen fechas distintas: {selectedDates.map(serviceDate).join(', ')}. Confirme la salida según el orden de atención.</p>}
                  <p className="mt-1 text-[11px] text-slate-500">La fecha de salida se confirma por separado de la fecha requerida de cada servicio.</p>
                </div>
                
                {newDispatch.document_type === 'GR' && <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1 flex justify-between items-center">
                    Distancia KM (Sugerido Automático)
                    {calculatingDistance && <Loader2 className="w-3 h-3 text-blue-500 animate-spin" />}
                  </label>
                  <input 
                    type="number" 
                    min="0"
                    step="0.1"
                    placeholder="Ej. 120.5"
                    disabled={calculatingDistance}
                    className={`w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none text-sm ${calculatingDistance ? 'opacity-50' : ''}`}
                    value={newDispatch.estimated_distance_km}
                    onChange={(e) => setNewDispatch({...newDispatch, estimated_distance_km: e.target.value === '' ? '' : Number(e.target.value)})}
                  />
                </div>}
              </div>
            </div>
          </div>
          
          {/* Columna Derecha: Selección de Solicitudes */}
          <div className="lg:w-2/3 flex flex-col">
            <h4 className="font-semibold text-slate-700 flex items-center justify-between mb-2">
              Seleccionar Solicitudes
              <span className="text-xs font-medium bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full">
                {newDispatch.selected_requests.length} seleccionadas
              </span>
            </h4>
            
            <div className="bg-slate-50 rounded-xl border border-slate-200 overflow-hidden flex-1 flex flex-col">
              <div className="overflow-y-auto p-2 space-y-2" style={{ maxHeight: 'calc(60vh - 120px)' }}>
                {pendingRequests.length === 0 ? (
                  <div className="p-8 text-center text-slate-500">
                    <p className="font-medium">No hay solicitudes disponibles</p>
                    <p className="text-xs mt-1">Crea nuevas solicitudes desde el módulo principal</p>
                  </div>
                ) : (
                  pendingRequests.map(req => {
                    const isRecojo = req.request_type === 'RECOJO'
                    const isTraslado = req.request_type === 'TRASLADO'
                    const typeLabel = req.request_type || (isRecojo ? 'RECOJO' : 'DESPACHO')
                    
                    let typeColor = 'bg-emerald-100 text-emerald-700 border-emerald-200'
                    if (isRecojo) typeColor = 'bg-orange-100 text-orange-700 border-orange-200'
                    if (isTraslado) typeColor = 'bg-purple-100 text-purple-700 border-purple-200'

                    return (
                      <div key={req.id} className="flex flex-col gap-2">
                        <label 
                          className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                            newDispatch.selected_requests.some(r => r.id === req.id)
                              ? 'bg-white border-blue-400 shadow-md ring-1 ring-blue-400' 
                              : 'bg-white border-slate-200 hover:border-blue-300 hover:shadow-sm'
                          }`}
                        >
                          <div className="pt-0.5">
                            <input 
                              type="checkbox" 
                              className="w-4 h-4 text-[#002855] rounded border-slate-300 focus:ring-[#002855]"
                              checked={newDispatch.selected_requests.some(r => r.id === req.id)}
                              onChange={() => toggleRequestSelection(req.id, req.pickup_address, req.delivery_address)}
                            />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2 mb-1">
                              <span className="font-bold text-[#002855] text-sm">{req.request_number}</span>
                              <span className="text-xs font-semibold text-blue-700">OT {req.contracts?.code || 'Sin OT'}</span>
                              <span className="text-xs font-medium text-blue-700">{req.attention_mode === 'RECOJO_CLIENTE' ? 'Recojo por cliente' : req.attention_mode === 'TRANSPORTE_JRM' ? 'Transporte JRM' : 'Modalidad pendiente: revisar solicitud'}</span>
                              <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold border ${typeColor}`}>
                                {typeLabel}
                              </span>
                            </div>
                          
                          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs"><span className="text-slate-700">Atención requerida · Lima: <b>{requestedAttention(req)}</b></span>{wasRescheduled(req) && <span className="rounded-full border border-orange-200 bg-orange-100 px-2 py-0.5 font-bold text-orange-800">Reprogramado</span>}</div>
                          {req.rescheduling?.fecha_anterior && <p className="mb-2 text-[11px] text-slate-500">Fecha anterior: {serviceDate(req.rescheduling.fecha_anterior)}</p>}
                          {req.attention_mode === 'RECOJO_CLIENTE' && <p className="text-xs text-slate-600">Contacto: {req.pickup_contact || 'Sin registrar'} · {req.pickup_phone || 'Sin teléfono'}</p>}
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                            <div className="text-xs text-slate-600">
                              <span className="font-semibold text-slate-800 block mb-0.5">Origen:</span>
                              <span className="truncate block" title={req.pickup_address}>{req.pickup_address}</span>
                            </div>
                            <div className="text-xs text-slate-600">
                              <span className="font-semibold text-slate-800 block mb-0.5">Destino:</span>
                              <span className="truncate block" title={req.delivery_address}>{req.delivery_address}</span>
                            </div>
                          </div>
                          </div>
                        </label>
                        
                      </div>
                    )
                  })
                )}
              </div>
            </div>
            
            {mixedOT && (
              <section className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-bold text-sm text-[#002855]">Flete distribuido por OT</h3>
                  <button type="button" onClick={() => setFreightShares({})} className="text-xs text-blue-700 underline">Distribuir según los estimados</button>
                </div>
                <p className="text-xs text-slate-600">La propuesta usa los costos estimados de las solicitudes; puede ajustar cada monto antes de confirmar. Cada OT financia su parte sobre el 80% operativo. El 20% de utilidad queda protegido.</p>
                {selectedServices.map(req => (
                  <label key={req.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span><strong>{req.request_number}</strong> · OT {req.contracts?.code || 'Sin OT'} · {req.request_type === 'RECOJO' ? 'Recojo' : req.request_type === 'TRASLADO' ? 'Punto a punto' : 'Entrega'}</span>
                    <span className="flex items-center gap-1">S/
                      <input type="number" min="0" step="0.01" aria-label={`Flete ${req.request_number}`} value={freightShares[req.id] ?? serviceShare(req.id).toFixed(2)} onChange={e => setFreightShares(prev => ({ ...prev, [req.id]: e.target.value }))} className="w-28 rounded border border-blue-200 bg-white px-2 py-1 text-right" />
                    </span>
                  </label>
                ))}
                <p className={`text-xs font-semibold ${allocationMatches ? 'text-emerald-700' : 'text-red-700'}`}>Total de ruta S/ {routeFreight.toFixed(2)} · Distribuido S/ {selectedServices.reduce((sum, r) => sum + serviceShare(r.id), 0).toFixed(2)}{!allocationMatches && ' · Ajuste la distribución para continuar'}</p>
              </section>
            )}
            <p className="mt-3 text-xs text-slate-500">Una ruta puede combinar entregas, recojos y traslados de varias OT con la misma pareja conductor–unidad. Para sumar servicios después de programar y antes de salir, cancele y rearme la ruta; el sistema libera las reservas y conserva el motivo. En ruta, registre una incidencia.</p>
            {/* Botones de acción al final de la columna derecha */}
            <div className="mt-4 flex justify-end gap-3 pt-2">
              <button 
                type="button" 
                onClick={() => setIsModalOpen(false)}
                className="px-5 py-2 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
              >
                Cancelar
              </button>
              <button 
                type="submit" 
                disabled={isSubmitting || newDispatch.selected_requests.length === 0 || (mixedOT && !allocationMatches)}
                className="px-6 py-2 bg-[#002855] text-white text-sm font-bold rounded-lg hover:bg-[#001d3d] transition-colors disabled:opacity-50 flex items-center gap-2 shadow-md hover:shadow-lg disabled:shadow-none"
              >
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Truck className="w-4 h-4" />}
                Programar Ruta
              </button>
            </div>
          </div>
        </form>
      </Modal>

      {/* Modal de Detalles del Despacho */}
      <Modal
        isOpen={!!selectedDispatchDetail}
        onClose={() => setSelectedDispatchDetail(null)}
        title={`Detalle de Despacho: ${selectedDispatchDetail?.dispatch_number}`}
        maxWidth="max-w-4xl"
      >
        {selectedDispatchDetail && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
                <span className="text-xs text-slate-500 font-semibold uppercase block mb-1">Unidad y Chofer</span>
                <div className="font-bold text-[#002855]">{selectedDispatchDetail.vehicle_plate}</div>
                <div className="text-sm text-slate-600">{selectedDispatchDetail.driver_name}</div>
                {selectedDispatchDetail.modalidad === 'TERCERO' && (
                  <Link href={`/torre-control?despacho=${selectedDispatchDetail.id}&fecha=${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(selectedDispatchDetail.scheduled_departure))}&proveedor=1`}
                    className="mt-1 inline-flex min-h-11 items-center text-xs font-semibold text-violet-700 hover:underline">Unidad tercerizada · acceso y avance</Link>
                )}
              </div>
              <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
                <span className="text-xs text-slate-500 font-semibold uppercase block mb-1">Salida Programada</span>
                <div className="font-semibold text-slate-800">
                  {new Date(selectedDispatchDetail.scheduled_departure).toLocaleString()}
                </div>
                <div className="text-sm text-slate-600">
                  Distancia: {selectedDispatchDetail.estimated_distance_km ? `${selectedDispatchDetail.estimated_distance_km} KM` : 'N/A'}
                </div>
              </div>
              <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
                <span className="text-xs text-slate-500 font-semibold uppercase block mb-1">Estado Actual</span>
                <span className={`px-2 py-1 text-xs font-bold rounded-md whitespace-nowrap inline-block mt-1 ${
                  selectedDispatchDetail.status === 'PROGRAMADO' ? 'bg-yellow-100 text-yellow-700' :
                  (selectedDispatchDetail.status === 'EN_CURSO' || selectedDispatchDetail.status === 'EN RUTA') ? 'bg-blue-100 text-blue-700' :
                  selectedDispatchDetail.status === 'ESPERANDO_AUTORIZACION' ? 'bg-orange-100 text-orange-700' :
                  selectedDispatchDetail.status === 'RETORNO' ? 'bg-indigo-100 text-indigo-700' :
                  selectedDispatchDetail.status === 'ENTREGADO' || selectedDispatchDetail.status === 'LIQUIDADO' ? 'bg-green-100 text-green-700' :
                  'bg-red-100 text-red-700'
                }`}>
                  {dispatchStatusLabel(selectedDispatchDetail.status)}
                </span>
              </div>
            </div>

            <div>
              <h3 className="font-bold text-slate-800 mb-3 flex items-center gap-2">
                <FileText className="w-5 h-5 text-blue-600" />
                Puntos de Ruta ({selectedDispatchDetail.dispatch_requests?.length || 0})
              </h3>
              
              <div className="space-y-3">
                {selectedDispatchDetail.dispatch_requests?.map((dr, idx) => {
                  const req = dr.transport_requests;
                  const totalWeight = req.transport_request_items?.reduce((sum, item) => sum + (Number(item.weight || 0) * Number(item.quantity || 1)), 0) || 0;
                  const totalVol = req.transport_request_items?.reduce((sum, item) => sum + (Number(item.volume_m3 || 0) * Number(item.quantity || 1)), 0) || 0;
                  const isRecojo = req.request_type === 'RECOJO';
                  const isTraslado = req.request_type === 'TRASLADO';
                  const typeLabel = req.request_type || (isRecojo ? 'RECOJO' : 'DESPACHO');
                  
                  let typeColor = 'bg-emerald-100 text-emerald-700 border-emerald-200';
                  if (isRecojo) typeColor = 'bg-orange-100 text-orange-700 border-orange-200';
                  if (isTraslado) typeColor = 'bg-purple-100 text-purple-700 border-purple-200';

                  return (
                    <div key={dr.transport_request_id} className="bg-white border border-slate-200 p-4 rounded-xl shadow-sm flex flex-col md:flex-row gap-4 justify-between items-start md:items-center relative">
                      <div className="absolute top-4 right-4 text-slate-300 font-black text-2xl opacity-50">#{idx + 1}</div>
                      
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="font-bold text-[#002855] text-base">{req.request_number}</span>
                          <span className="text-xs font-semibold text-blue-700">OT {req.contracts?.code || 'Sin OT'}</span>
                          <span className={`text-[10px] px-2 py-0.5 rounded font-bold border ${typeColor}`}>
                            {typeLabel}
                          </span>
                          <span className="text-[10px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded font-semibold">
                            {dr.document_type}: {dr.document_number}
                          </span>
                        </div>
                        
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
                          <div className="text-sm text-slate-600">
                            <div className="flex items-start gap-1">
                              <MapPin className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                              <div>
                                <span className="block text-xs font-bold text-slate-500">ORIGEN</span>
                                <span>{req.pickup_address}</span>
                              </div>
                            </div>
                          </div>
                          <div className="text-sm text-slate-600">
                            <div className="flex items-start gap-1">
                              <MapPin className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                              <div>
                                <span className="block text-xs font-bold text-slate-500">DESTINO</span>
                                <span>{req.delivery_address}</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="bg-slate-50 rounded-lg p-3 min-w-[120px] text-center border border-slate-100 mt-2 md:mt-0 self-stretch flex flex-col justify-center">
                        <span className="block text-xs text-slate-500 font-semibold mb-1">Carga Total</span>
                        <div className="font-bold text-slate-700">{totalWeight.toFixed(2)} KG</div>
                        <div className="font-bold text-slate-700">{totalVol.toFixed(2)} M3</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="border-t pt-4">
              <DispatchCrewUnloading dispatchId={selectedDispatchDetail.id} status={selectedDispatchDetail.status}
                canEdit={canWrite('despacho')}
                stops={(selectedDispatchDetail.dispatch_requests || []).filter(dr => dr.transport_request_id)
                  .map(dr => ({ request_id: dr.transport_request_id as string, request_number: dr.transport_requests?.request_number || '—' }))} />
            </div>

            <div className="border-t pt-4">
              <EvidenceGallery dispatchId={selectedDispatchDetail.id} title="Evidencias registradas · consulta" />
            </div>

            <div className="flex justify-end">
              <button
                onClick={() => setSelectedDispatchDetail(null)}
                className="px-5 py-2 bg-slate-100 text-slate-700 rounded-lg font-medium hover:bg-slate-200 transition-colors"
              >
                Cerrar
              </button>
            </div>
          </div>
        )}
      </Modal>

    </div>
  )
}
