"use client"
import { allPages } from '@/lib/analytics/model'
import { ForkliftFields, EMPTY_FORKLIFT, forkliftValid, forkliftForStops } from '@/components/despacho/ForkliftFields'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { TransportWorkflow, TorreControlButton } from '@/components/transport/TransportWorkflow'
import { DataTable } from '@/components/ui/data-table'
import { PageHeader } from '@/components/ui/page-header'
import { InlineStatusBar } from '@/components/ui/inline-status-bar'
import { FilterToolbar, FilterField, filterControl } from '@/components/ui/filter-toolbar'
import { districtOf } from '@/lib/address'
import { cellDateTime } from '@/lib/table-format'
import { partyName, referenceLabel, requiresSupplier } from '@/lib/suppliers'
import { LinkPartyModal } from '@/components/solicitudes/LinkPartyModal'

// Sin proveedor (recojo / traslado) o sin cliente (entregas) una solicitud no se programa: la base también lo impide.
function partyMissing(req: { request_type?: string; attention_mode?: string | null; supplier_id?: string | null; client_id?: string | null; contract_id?: string | null }): 'proveedor' | 'cliente' | null {
  if (requiresSupplier(req)) return req.supplier_id ? null : 'proveedor'
  return req.client_id ? null : 'cliente'
}
import { ServiceTypeBadge } from '@/components/ui/service-type-badge'
import { serviceLabel, serviceKind, SERVICE_KINDS, type ServiceKind } from '@/lib/request-service'

import { DISPATCH_STATUS_GROUPS } from '@/lib/dispatch-status'
import { splitFreight } from '@/lib/transport-budget'
import { isTransportUnit, TRANSPORT_VEHICLE_TYPES } from '@/lib/fleet-filters'
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Truck, MapPin, Loader2, Plus, FileText, Tag, Search, Clock, Route, PackageCheck } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { FormSection, PendingPanel, PendingStatus, type PendingItem } from '@/components/ui/form-section'
import { QuoteBreakdown } from '@/components/tarifas/TransportTariffManager'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import { RouteAuxiliaryPicker, type RouteAssistant } from '@/components/despacho/RouteAuxiliaryPicker'
import { calculateRouteDistance } from '@/lib/routing'
import { usePermissions } from '@/hooks/usePermissions'
import { errorMessage } from '@/lib/caja'
import { serviceDate, wasRescheduled, withRescheduling, type RequestRescheduling } from '@/lib/request-schedule'
import { checkDispatchEligibility } from '@/lib/eligibility'
import { ReportarFallaButton } from '@/components/mantenimiento/ReportarFalla'
import { TerceroFields, TERCERO_VACIO, type TerceroForm } from '@/components/despacho/Tercero'
import { AddRouteService } from '@/components/despacho/AddRouteService'
import { ErpOtLinea, ErpStockCorteAviso } from '@/components/erp/ErpReferencia'
import { OCCUPIED_DISPATCH_STATUSES, routeAssignment } from '@/lib/route-assignment'

type PlanningCarrier = { business_name: string | null }
type PlanningVehicle = { plate: string; status: string; type: string | null; brand: string | null; model: string | null; assigned_driver_id: string | null; carriers: PlanningCarrier | null }
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
  pickup_district?: string | null
  reference_type?: string | null
  reference_number?: string | null
  purchase_order?: string | null
  suppliers?: { business_name: string } | null
  supplier_id?: string | null
  client_id?: string | null
  request_client?: { business_name: string } | null
  estimated_weight?: number | null
  service_cost?: number | null
  unloading_estimate_pen?: number | null
  operational_approved_pen?: number | null
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
    delivery_district?: string | null
    request_type?: string
    attention_mode?: string | null
    contract_id?: string | null
    required_date?: string | null
    required_at?: string | null
    time_window?: string | null
    rescheduling?: RequestRescheduling
    contracts?: { code: string; clients?: { business_name: string } | null } | null
    transport_request_items?: Array<{
      weight?: number
      quantity?: number
      volume_m3?: number
    }>
  }
}

// Orden de la bandeja: la solicitud registrada más recientemente primero; a igual registro, la atención más reciente.
// Fecha de atención: hora exacta si existe; si no, el día en Lima. Sin fecha va al final.
function attentionTime(request: { required_at?: string | null; required_date?: string | null }) {
  const t = request.required_at ? Date.parse(request.required_at) : request.required_date ? Date.parse(`${request.required_date.slice(0, 10)}T00:00:00-05:00`) : NaN
  return Number.isFinite(t) ? t : -Infinity
}
const newestFirst = <T extends { required_at?: string | null; required_date?: string | null; created_at?: string | null }>(rows: T[]) =>
  [...rows].sort((a, b) => (Date.parse(b.created_at || '') || 0) - (Date.parse(a.created_at || '') || 0) || attentionTime(b) - attentionTime(a))

function requestedAttention(request: { required_at?: string | null; required_date?: string | null; time_window?: string | null }) {
  if (request.required_at) return new Date(request.required_at).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short', hour12: false })
  return `${serviceDate(request.required_date)}${request.time_window ? ` · ${request.time_window}` : ''}`
}

interface Dispatch {
  id: string
  dispatch_number: string
  legacy_dispatch_number?: string | null
  driver_name: string
  driver_id?: string | null
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

const STATUS_GROUPS = { ruta: DISPATCH_STATUS_GROUPS.RUTA as readonly string[], cerrar: DISPATCH_STATUS_GROUPS.POR_CERRAR as readonly string[] }

export default function DespachoPage() {
  const router = useRouter()
  const { canWrite, role } = usePermissions()
  const canAddService = canWrite('despacho') && ['admin', 'supervisor de transporte'].includes(role)
  const [addServiceId, setAddServiceId] = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])
  const [pendingRequests, setPendingRequests] = useState<TransportRequest[]>([])
  const [linkRequest, setLinkRequest] = useState<TransportRequest | null>(null)
  const [dispatches, setDispatches] = useState<Dispatch[]>([])
  const [vehicles, setVehicles] = useState<PlanningVehicle[]>([])
  const [drivers, setDrivers] = useState<PlanningDriver[]>([])
  
  const alertedDispatches = useRef<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)

  const [pendingSearch, setPendingSearch] = useState('')
  const [pendingService, setPendingService] = useState('')
  const visiblePending = pendingRequests.filter(r => {
    const term = pendingSearch.trim().toLocaleLowerCase('es-PE')
    const matchSearch = !term || [r.request_number, r.requester_name, r.contracts?.code, r.contracts?.clients?.business_name, r.suppliers?.business_name, referenceLabel(r),
      districtOf(r.pickup_address, r.pickup_district), districtOf(r.delivery_address, r.delivery_district)].join(' ').toLocaleLowerCase('es-PE').includes(term)
    return matchSearch && (!pendingService || serviceKind(r) === pendingService)
  })

  const [isModalOpen, setIsModalOpen] = useState(false)
  
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [calculatingDistance, setCalculatingDistance] = useState(false)
  const reqDistances = useRef<Record<string, number>>({})
  // Fecha de salida propuesta desde la fecha requerida (se reemplaza mientras el usuario no la cambie a mano)
  const [autoDeparture, setAutoDeparture] = useState('')

  // Freight rate lookup state
  const [detectedFreightRate, setDetectedFreightRate] = useState<{ rate: number; district: string; zone: string } | null>(null)
  const [loadingRate, setLoadingRate] = useState(false)
  const [manualFreightCost, setManualFreightCost] = useState<string>('')
  // Cotización del tarifario con la placa real y todas las paradas (quote_transport)
  const [freightQuote, setFreightQuote] = useState<Record<string, unknown> | null>(null)
  // Unidad propia o de un transportista tercero que no usa el app
  const [modalidad, setModalidad] = useState<'PROPIA' | 'TERCERO'>('PROPIA')
  const [tercero, setTercero] = useState<TerceroForm>(TERCERO_VACIO)
  // El catálogo incluye auxiliares y conductores activos de Personal, con disponibilidad explícita.
  const [assistants, setAssistants] = useState<RouteAssistant[]>([])
  const [assistantsLoading, setAssistantsLoading] = useState(false)
  const [assistantsError, setAssistantsError] = useState('')
  const assistantsLoadId = useRef(0)
  const [auxiliares, setAuxiliares] = useState<string[]>([])
  const [forklift, setForklift] = useState(EMPTY_FORKLIFT)
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
  const forkliftStops = selectedServices.map(request => ({ id: request.id,
    label: `${request.request_number} · ${request.delivery_address || request.delivery_district || 'Destino sin dirección'}` }))
  const routeForklift = forkliftForStops(forklift, forkliftStops)
  const mixedOT = new Set(selectedServices.map(r => r.contract_id || `ORDEN:${r.reference_type || ''}:${r.reference_number || r.id}`)).size > 1
  const selectedDates = [...new Set(selectedServices.map(r => r.required_date?.slice(0,10)).filter((date): date is string => !!date))]
  const customerPickup = selectedServices[0]?.attention_mode === 'RECOJO_CLIENTE'
  const selectedDriver = drivers.find(d => `${d.first_name} ${d.last_name}`.trim() === newDispatch.driver_name.trim())
  const occupiedAssignment = newDispatch.document_type === 'GR' && modalidad === 'PROPIA'
    ? routeAssignment(dispatches, newDispatch.vehicle_plate, selectedDriver?.id) : null
  const openRouteAddition = (id: string) => { setIsModalOpen(false); setAddServiceId(id) }
  const ownPickupOnly = modalidad === 'PROPIA' && selectedServices.length > 0 && selectedServices.every(r => r.request_type === 'RECOJO')
  const valuedServices = selectedServices.filter(r => modalidad === 'TERCERO' || r.request_type !== 'RECOJO')
  const routeFreight = customerPickup || ownPickupOnly ? 0 : modalidad === 'TERCERO'
    ? (Number(manualFreightCost) > 0 ? Number(manualFreightCost) : detectedFreightRate?.rate || 0)
    : (detectedFreightRate?.rate || Number(manualFreightCost) || 0)
  const defaultShares = splitFreight(routeFreight, valuedServices)
  const serviceShare = (id: string) => modalidad === 'PROPIA' && selectedServices.some(r => r.id === id && r.request_type === 'RECOJO') ? 0 : Number(freightShares[id] ?? defaultShares.find(r => r.id === id)?.amount ?? 0)
  const allocationMatches = Math.round(selectedServices.reduce((sum, r) => sum + serviceShare(r.id), 0) * 100) === Math.round(routeFreight * 100)
  const [routeSearch, setRouteSearch] = useState('')
  const [routeService, setRouteService] = useState<ServiceKind | ''>('')
  const routeCandidates = pendingRequests.filter(r => {
    if (newDispatch.selected_requests.some(s => s.id === r.id)) return true
    if (routeService && serviceKind(r) !== routeService) return false
    const term = routeSearch.trim().toLocaleLowerCase('es-PE')
    return !term || [r.request_number, r.contracts?.code, r.contracts?.clients?.business_name, r.suppliers?.business_name, referenceLabel(r),
      districtOf(r.pickup_address, r.pickup_district), districtOf(r.delivery_address, r.delivery_district)].join(' ').toLocaleLowerCase('es-PE').includes(term)
  })
  // Lo que falta para programar, en el orden del formulario; cada ítem lleva a su sección.
  const routePending = ([
    !newDispatch.selected_requests.length && { label: 'Seleccionar al menos un servicio', target: 'ruta-servicios' },
    newDispatch.selected_requests.length > 0 && newDispatch.document_type === 'GR' && modalidad === 'PROPIA' && !newDispatch.vehicle_plate && { label: 'Placa del vehículo', target: 'ruta-unidad' },
    newDispatch.selected_requests.length > 0 && newDispatch.document_type === 'GR' && modalidad === 'PROPIA' && !newDispatch.driver_name && { label: 'Conductor', target: 'ruta-unidad' },
    newDispatch.selected_requests.length > 0 && newDispatch.document_type === 'GR' && modalidad === 'TERCERO' && (!tercero.carrier_id || !tercero.placa.trim() || !tercero.conductor.trim() || !tercero.telefono.trim() || !tercero.doc.trim()) && { label: 'Datos del transportista tercero', target: 'ruta-unidad' },
    !newDispatch.scheduled_departure && { label: 'Fecha y hora de salida', target: 'ruta-salida' },
    mixedOT && !allocationMatches && { label: 'Distribución del flete por servicio', target: 'ruta-flete' },
  ].filter(Boolean) as PendingItem[])
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
      const selectedReqs = pendingRequests.filter(r => selectedReqIds.includes(r.id) && (plate === 'EXTERNO' || r.request_type !== 'RECOJO'))
      if (!selectedReqs.length) { setDetectedFreightRate(null); setFreightQuote(null); return }
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

  const fetchAssistants = useCallback(async () => {
    const loadId = ++assistantsLoadId.current
    setAssistantsLoading(true)
    setAssistantsError('')
    try {
      const { data, error } = await supabase.rpc('list_route_assistants', { p_dispatch_id: null })
      if (error) throw error
      if (!Array.isArray(data)) throw new Error('La consulta no devolvió la lista de personal.')
      if (loadId === assistantsLoadId.current) setAssistants(data as RouteAssistant[])
    } catch (error) {
      if (loadId === assistantsLoadId.current) setAssistantsError('No se pudo cargar el personal. Pulsa Actualizar personal para reintentar. ' + errorMessage(error))
    } finally {
      if (loadId === assistantsLoadId.current) setAssistantsLoading(false)
    }
  }, [supabase])

  useEffect(() => {
    if (!isModalOpen) return
    const refresh = () => { void fetchAssistants() }
    const initialLoad = window.setTimeout(refresh, 0)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearTimeout(initialLoad)
      window.removeEventListener('focus', refresh)
    }
  }, [isModalOpen, fetchAssistants])

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      // 1. Obtener Solicitudes pendientes de asignar
      // Por páginas: la API entrega como máximo 1.000 filas por consulta
      const reqData = await allPages<any>((o, n) => supabase
        .from('transport_requests')
        .select(`
          *,
          suppliers(business_name),
          request_client:clients!client_id(business_name),
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
        .order('created_at', { ascending: false }).order('id')
        .range(o, o + n - 1), 1000)

      const { data: history, error: historyError } = reqData?.length ? await supabase.rpc('get_transport_request_rescheduling', { p_request_ids: reqData.map(r => r.id) }) : { data: [], error: null }
      if (historyError) throw historyError
      setPendingRequests(newestFirst(withRescheduling(reqData || [], history || [])))

      // 2. Despachos asignados: solo para los contadores y el aviso de retorno (se gestionan en Torre de Control)
      const { data: dispatchData, error: dispatchError } = await supabase
        .from('dispatches')
        .select('id, dispatch_number, status, vehicle_plate, driver_id, driver_name, scheduled_departure')
        .in('status', [...OCCUPIED_DISPATCH_STATUSES])

      if (dispatchError) throw dispatchError
      if (!dispatchData) {
        // Set vacío para evitar null
        setDispatches([])
      } else {
        const fetchedDispatches = dispatchData as unknown as Dispatch[] || []
        setDispatches(fetchedDispatches)

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
      const { data: vData } = await supabase.from('vehicles').select('plate, status, type, brand, model, assigned_driver_id, carriers(business_name)')
        .in('status', ['DISPONIBLE', 'ASIGNADA', 'EN_RUTA', 'EN_OPERACION']).eq('is_active', true).in('type', [...TRANSPORT_VEHICLE_TYPES])
      const { data: dData } = await supabase.from('drivers')
        .select('id, first_name, last_name, document_number, profile_id, carriers(business_name)')
        .eq('is_active', true).not('profile_id', 'is', null)
      
      setVehicles((vData || []).filter(vehicle => isTransportUnit(vehicle.type) && (vehicle.status === 'DISPONIBLE' || dispatchData?.some(route => route.vehicle_plate === vehicle.plate))).map(vehicle => ({ ...vehicle, carriers: Array.isArray(vehicle.carriers) ? vehicle.carriers[0] || null : vehicle.carriers })))
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
    if (!forkliftValid(routeForklift, forkliftStops)) { toast.error('Seleccione la parada del montacarga y complete proveedor, montacarguista y tarifa por hora.'); return }
    // El servidor valida la reserva vigente y el gasto autorizado; saldo cero puede ser una reserva propia.
    setIsSubmitting(true)
    if (modalidad === 'TERCERO' && newDispatch.document_type === 'GR') {
      try {
        if (mixedOT && !allocationMatches) throw new Error('La suma del flete por servicio debe coincidir con el total de la ruta.')
        if (!tercero.carrier_id || !tercero.placa.trim() || !tercero.conductor.trim() || !tercero.telefono.trim() || !tercero.doc.trim()) {
          throw new Error('Complete transportista, placa, chofer, documento de identidad y celular del tercero.')
        }
        const firstReq = pendingRequests.find(r => r.id === newDispatch.selected_requests[0].id)
        const freightCost = Number(manualFreightCost) > 0 ? Number(manualFreightCost) : (detectedFreightRate?.rate || 0)
        const pickupFunding = selectedServices.filter(r => r.request_type === 'RECOJO' && !r.contract_id && serviceShare(r.id) > 0 && serviceShare(r.id) + Number(r.unloading_estimate_pen || 0) > Number(r.operational_approved_pen || 0))
        if (pickupFunding.length && !window.confirm(`Autorizar el flete contratado de los recojos: ${pickupFunding.map(r => `${r.request_number} · ${referenceLabel(r)} · S/ ${serviceShare(r.id).toFixed(2)}`).join('; ')}. La descarga se añade al importe autorizado. Esta aprobación queda registrada aunque la programación deba reintentarse.`)) return
        if (pickupFunding.length) setFreightShares(Object.fromEntries(selectedServices.map(r => [r.id, serviceShare(r.id).toFixed(2)])))
        for (const request of pickupFunding) {
          const authorization = await supabase.rpc('authorize_pickup_reference_freight', {
            p_request_id: request.id,
            p_expected_cost: Math.round((Number(request.service_cost || 0) + Number(request.unloading_estimate_pen || 0)) * 100) / 100,
            p_reference_type: request.reference_type, p_reference_number: request.reference_number,
            p_freight: serviceShare(request.id), p_reason: 'Flete contratado a tercero al programar la ruta',
          })
          if (authorization.error) throw authorization.error
          const authorizedFreight = serviceShare(request.id)
          setPendingRequests(current => current.map(r => r.id === request.id ? { ...r, service_cost: authorizedFreight, operational_approved_pen: Math.round((authorizedFreight + Number(r.unloading_estimate_pen || 0)) * 100) / 100 } : r))
        }
        const { data: newDispatchId, error } = await supabase.rpc('schedule_route_resources', { p: { mode: 'TERCERO', forklift: routeForklift.enabled ? routeForklift : null, auxiliaries: [],
          p_carrier_id: tercero.carrier_id, p_plate: tercero.placa, p_conductor: tercero.conductor, p_telefono: tercero.telefono,
          p_supplier_vehicle_id: tercero.supplier_vehicle_id || null, p_supplier_personnel_id: tercero.supplier_personnel_id || null,
          p_doc: tercero.doc || null, p_tercero_license_number: tercero.license_number || null,
          p_tercero_license_expiration: tercero.license_expiration || null, p_departure: new Date(newDispatch.scheduled_departure).toISOString(),
          p_estimated_km: isPickup ? 0 : Number(newDispatch.estimated_distance_km) || 0, p_freight_cost: freightCost,
          p_contract_id: firstReq?.contracts?.id || null,
          p_requests: programmingRequests(),
        } })
        if (error) throw error
        if (!isPickup && newDispatchId && freightQuote && detectedFreightRate?.rate && freightCost === detectedFreightRate.rate) {
          await supabase.rpc('set_dispatch_freight_quote', { p_dispatch_id: newDispatchId, p_breakdown: freightQuote })
        }
        toast.success('Servicio programado. El acceso del proveedor está listo para compartir.')
        if (newDispatchId) {
          const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(newDispatch.scheduled_departure))
          router.push(`/torre-control?despacho=${newDispatchId}&fecha=${day}&proveedor=1`)
        }
        setForklift(EMPTY_FORKLIFT)
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
      if (!isPickup && modalidad === 'PROPIA') {
        // Refresh before submitting: another supervisor may have programmed this pair since the page loaded.
        const results = await Promise.all([
          supabase.from('dispatches').select('id, dispatch_number, status, vehicle_plate, driver_id').eq('vehicle_plate', newDispatch.vehicle_plate).in('status', [...OCCUPIED_DISPATCH_STATUSES]),
          supabase.from('dispatches').select('id, dispatch_number, status, vehicle_plate, driver_id').eq('driver_id', matches[0].id).in('status', [...OCCUPIED_DISPATCH_STATUSES]),
        ])
        for (const result of results) if (result.error) throw result.error
        const assignment = routeAssignment(results.flatMap(result => result.data || []), newDispatch.vehicle_plate, matches[0].id)
        if (assignment) {
          if (assignment.kind === 'ADD_SERVICE' && canAddService) openRouteAddition(assignment.route.id)
          else toast.error(assignment.kind === 'CLOSING' ? 'La ruta está en retorno o pendiente de cierre. Complete su cierre antes de programar otra.' : assignment.kind === 'CONFLICT' ? 'La unidad o el conductor ya está asignado a otro despacho. Mantenga la pareja de la ruta existente o elija recursos disponibles.' : 'El Supervisor de Transporte debe incorporar el servicio a la ruta existente.')
          return
        }
      }
      if (mixedOT && !allocationMatches) { toast.error('La suma del flete por servicio debe coincidir con el total de la ruta.'); return }

      // NOTA_SALIDA = recojo por cliente: no requiere vehículo ni conductor propio (bypass legítimo)
      // GR = despacho con vehículo propio: validación de elegibilidad obligatoria
      if (newDispatch.document_type !== 'NOTA_SALIDA') {
        // Fail-safe: si falta placa o conductor para un GR, bloquear — no saltar validación
        if (!vehicles.some(vehicle => vehicle.plate === newDispatch.vehicle_plate) || !matches[0]?.id) {
          toast.error('Para despachos GR debes seleccionar vehículo y conductor antes de programar.')
          setIsSubmitting(false)
          return
        }
        const eligibility = await checkDispatchEligibility(newDispatch.vehicle_plate, matches[0].id)
        if (eligibility.status === 'BLOQUEADO') {
          toast.error(`Despacho bloqueado: ${eligibility.blocking_reasons.join('; ')}`, {
            description: eligibility.observation_reasons.length ? `Observaciones documentarias: ${eligibility.observation_reasons.join('; ')}` : undefined,
          })
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
      const freightCost = routeFreight
      const { data: newDispatchId, error } = await supabase.rpc('schedule_route_resources', { p: { mode: 'PROPIA', forklift: routeForklift.enabled ? routeForklift : null, auxiliaries: isPickup ? [] : auxiliares,
        p_driver_id: isPickup ? null : matches[0]?.id || null,
        p_vehicle_plate: isPickup ? 'EXTERNO' : newDispatch.vehicle_plate,
        p_departure: new Date(newDispatch.scheduled_departure).toISOString(),
        p_estimated_km: isPickup ? 0 : Number(newDispatch.estimated_distance_km) || 0,
        p_freight_cost: freightCost,
        p_contract_id: firstReq?.contracts?.id || null,
        p_document_type: newDispatch.document_type,
        p_requests: programmingRequests()
      } })
      if (error) throw error
      // Se guarda con qué tarifa se calculó el flete (si vino del tarifario)
      if (!isPickup && newDispatchId && freightQuote && detectedFreightRate?.rate && freightCost === detectedFreightRate.rate) {
        await supabase.rpc('set_dispatch_freight_quote', { p_dispatch_id: newDispatchId, p_breakdown: freightQuote })
      }
      setAutoDeparture('')
      setAuxiliares([])
      setForklift(EMPTY_FORKLIFT)
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

  const toggleRequestSelection = async (reqId: string, pickup: string, delivery: string) => {
    const isSelected = newDispatch.selected_requests.some(r => r.id === reqId)
    const request = pendingRequests.find(r => r.id === reqId)
    if (!isSelected && !request?.attention_mode) { toast.error('Defina la modalidad en Solicitudes antes de programar este requerimiento histórico.'); return }
    const missingParty = !isSelected && request ? partyMissing(request) : null
    if (missingParty) { toast.error(`${request?.request_number} no tiene ${missingParty}: vincúlelo antes de programarla.`); setLinkRequest(request ?? null); return }
    const existing = pendingRequests.find(r => newDispatch.selected_requests.some(x => x.id === r.id))
    if (!isSelected && existing && (existing.attention_mode !== request?.attention_mode || existing.site_id !== request?.site_id)) {
      toast.error('Agrupe solicitudes de la misma modalidad y sede. Puede combinar OT, entregas, recojos y traslados.'); return
    }
    setFreightShares({})
    const nextIds = isSelected ? newDispatch.selected_requests.filter(r => r.id !== reqId).map(r => r.id) : [...newDispatch.selected_requests.map(r => r.id), reqId]
    const nextDates = [...new Set(nextIds.map(id => pendingRequests.find(r => r.id === id)?.required_date?.slice(0, 10)).filter((date): date is string => !!date))]
    const proposed = nextDates.length === 1 ? `${nextDates[0]}T08:00` : ''
    if (!newDispatch.scheduled_departure || newDispatch.scheduled_departure === autoDeparture) {
      setAutoDeparture(proposed)
      setNewDispatch(prev => ({ ...prev, scheduled_departure: proposed }))
    }
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
    <div className="w-full mx-auto space-y-2.5">
      <PageHeader showTitle title="Programación de Despachos y Ruteo" description="Asignación de unidades de transporte a Solicitudes" actions={<>
        <ReportarFallaButton />
        {canWrite('despacho') && (
          <button 
            onClick={() => setIsModalOpen(true)}
            className="flex min-h-10 items-center gap-2 rounded-lg bg-jrm-navy px-4 font-medium text-white shadow-sm transition-colors hover:bg-jrm-navy-dark"
          >
            <Plus className="w-4 h-4" />
            Armar Ruta
          </button>
        )}
        <TorreControlButton />
      </>} />
      <div className="flex flex-wrap items-center gap-2">
        <TransportWorkflow current="programacion" torre={false} />
        <div className="ml-auto min-w-0">
          <InlineStatusBar label="Resumen operativo: los despachos asignados se siguen en Torre de Control" loading={loading} active="asignar"
            onChange={key => { if (key !== 'asignar') router.push(`/torre-control?estado=${({ programados: 'PROGRAMADO', ruta: 'RUTA', cerrar: 'POR_CERRAR' } as Record<string, string>)[key]}`) }}
            items={[
              { key: 'asignar', label: 'Por asignar', count: pendingRequests.length, icon: <FileText />, tone: 'amber' },
              { key: 'programados', label: 'Programados', count: dispatches.filter(d => d.status === 'PROGRAMADO').length, icon: <Clock />, tone: 'navy' },
              { key: 'ruta', label: 'En ruta', count: dispatches.filter(d => STATUS_GROUPS.ruta.includes(d.status)).length, icon: <Route />, tone: 'blue' },
              { key: 'cerrar', label: 'Por cerrar', count: dispatches.filter(d => STATUS_GROUPS.cerrar.includes(d.status)).length, icon: <PackageCheck />, tone: 'emerald' }]} />
        </div>
      </div>

      <section aria-label="Solicitudes por asignar" className="min-w-0 space-y-2">
        <FilterToolbar compact label="Búsqueda y filtros de solicitudes por asignar" onClear={() => { setPendingSearch(''); setPendingService('') }}>
          <label className="relative min-w-0 flex-1 basis-60">
            <span className="sr-only">Buscar solicitudes</span><Search className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" aria-hidden="true" />
            <input type="search" placeholder="Buscar por OT, cliente, solicitud o distrito…" value={pendingSearch} onChange={e => setPendingSearch(e.target.value)} className={`${filterControl} pl-9`} />
          </label>
          <FilterField inline label="Servicio" className="w-60">
            <select className={filterControl} value={pendingService} onChange={e => setPendingService(e.target.value)}>
              <option value="">Todos</option>
              {(Object.keys(SERVICE_KINDS) as ServiceKind[]).map(kind => <option key={kind} value={kind}>{SERVICE_KINDS[kind].short}</option>)}
            </select>
          </FilterField>
        </FilterToolbar>

        <div className="overflow-hidden rounded-jrm border border-jrm-line bg-jrm-surface shadow-jrm-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-jrm-line px-3 py-2.5">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <FileText className="h-4 w-4 text-amber-600" aria-hidden="true" />
              Solicitudes por asignar <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">{visiblePending.length}</span>
            </h2>
            <p className="text-xs text-slate-500">Programados y en ruta: <Link href="/torre-control" className="font-semibold text-jrm-navy hover:underline">Torre de Control</Link> · Servicios realizados: <Link href="/contratos/servicios" className="font-semibold text-jrm-navy hover:underline">Registro de servicios</Link></p>
          </div>
          <div className="overflow-x-auto">
            <DataTable dense className="w-full border-collapse text-left">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  {['Registro', 'Atención', 'Servicio', 'OT / OC / OS / RQ', 'Empresa', 'Origen → Destino', 'Partida / costo', 'Acciones'].map((title, i) => <th key={title} className={`whitespace-nowrap font-semibold ${i === 7 ? 'text-right' : ''}`}>{title}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <tr><td colSpan={8} className="p-8 text-center text-slate-500"><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />Cargando solicitudes…</td></tr>
                ) : visiblePending.length === 0 ? (
                  <tr><td colSpan={8} className="p-8 text-center text-slate-500">{pendingRequests.length ? 'No hay solicitudes con estos filtros.' : 'No hay solicitudes pendientes de asignación.'}</td></tr>
                ) : visiblePending.map(req => {
                  const selected = newDispatch.selected_requests.some(r => r.id === req.id)
                  const balance = req.contracts?.contract_budgets?.[0]?.balance_pen
                  return (
                    <tr key={req.id} className={selected ? 'bg-blue-50/50' : 'hover:bg-slate-50'}>
                      <td className="whitespace-nowrap text-sm text-slate-500" title="Fecha y hora en que se registró la solicitud">{req.created_at ? cellDateTime(req.created_at) : '—'}</td>
                      <td className="whitespace-nowrap">
                        <span className={`text-sm ${wasRescheduled(req) ? 'font-semibold text-orange-700' : 'text-slate-700'}`} title={wasRescheduled(req) ? 'Reprogramado' : undefined}>{req.required_at ? cellDateTime(req.required_at) : `${serviceDate(req.required_date).slice(0, 5)}${req.time_window ? ` ${req.time_window}` : ''}`}</span>
                      </td>
                      <td><ServiceTypeBadge request={req} /></td>
                      <td className="whitespace-nowrap text-sm font-bold text-jrm-navy" title={`Solicitud ${req.request_number} · ${req.requester_name}`}>{req.contracts?.code ? `OT ${req.contracts.code}` : referenceLabel(req) || 'Sin OT'}</td>
                      <td className="max-w-40">{(() => { const party = partyName(req, (req.request_client?.business_name || req.contracts?.clients?.business_name), req.suppliers?.business_name); return <p className="truncate text-sm text-slate-700" title={party ? `${requiresSupplier(req) ? 'Proveedor' : 'Cliente'}: ${party}` : undefined}>{party || <button type="button" onClick={e => { e.stopPropagation(); setLinkRequest(req) }} className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700 ring-1 ring-red-200 hover:bg-red-100" title="Sin esto no se puede programar">{requiresSupplier(req) ? 'Proveedor sin vincular' : 'Sin cliente'} · vincular</button>}</p> })()}</td>
                      <td className="max-w-48">
                        <p className="flex items-center gap-1 truncate text-sm text-slate-700" title={`Origen: ${req.pickup_address}\nDestino: ${req.delivery_address}`}>
                          <MapPin className="h-3.5 w-3.5 shrink-0 text-blue-500" aria-hidden="true" />
                          <span className="truncate">{districtOf(req.pickup_address, req.pickup_district)} → {districtOf(req.delivery_address, req.delivery_district)}</span>
                        </p>
                      </td>
                      <td className="whitespace-nowrap text-sm">
                        {req.contracts?.code && balance !== undefined && balance !== null
                          ? <span className={`font-semibold ${(balance || 0) < 500 ? 'text-red-700' : 'text-slate-700'}`}>S/ {(balance || 0).toLocaleString('es-PE')}</span>
                          : !req.contract_id && referenceLabel(req)
                            ? <span className="text-slate-700" title="Costo de la solicitud aprobada, sin consumo de partida OT">S/ {Number(req.service_cost || 0).toLocaleString('es-PE')}<span className="block text-[11px] font-normal text-slate-500">Costo aprobado</span></span>
                            : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="text-right">
                        {canWrite('despacho') && (
                          <button type="button" onClick={() => { setIsModalOpen(true); if (!selected) void toggleRequestSelection(req.id, req.pickup_address, req.delivery_address) }}
                            aria-label={`Asignar ${req.request_number}`}
                            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-jrm-navy px-3 text-xs font-semibold text-white hover:bg-jrm-navy-dark lg:min-h-8">
                            <Truck className="h-4 w-4" aria-hidden="true" />{selected ? 'En la ruta' : 'Asignar'}
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </DataTable>
          </div>
        </div>
      </section>
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="Armar ruta y programar unidad"
        maxWidth="max-w-7xl"
        footer={<div className="flex flex-wrap items-center justify-between gap-3">
          <PendingStatus count={routePending.length} readyText="Lista para programar" />
          <div className="flex gap-2">
            <button type="button" onClick={() => setIsModalOpen(false)} className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100">Cancelar</button>
            <button type="submit" form="route-form"
              disabled={isSubmitting || newDispatch.selected_requests.length === 0 || (mixedOT && !allocationMatches)}
              className="flex items-center gap-2 rounded-lg bg-[#002855] px-5 py-2 text-sm font-bold text-white transition-colors hover:bg-[#001d3d] disabled:opacity-50">
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Truck className="h-4 w-4" />}
              Programar ruta
            </button>
          </div>
        </div>}
      >
        <form id="route-form" onSubmit={handleProgramar} className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 space-y-4">
            <FormSection id="ruta-servicios" step={1} title="Servicios de la ruta" hint="Combine entregas, recojos y traslados con OT u OC, OS o RQ, con la misma modalidad y sede. El orden de selección es el orden de las paradas."
              aside={<span className="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800">{newDispatch.selected_requests.length} seleccionadas</span>}>
              {isModalOpen && <ErpStockCorteAviso />}
              <div className="mb-2 flex flex-wrap gap-2">
                <label className="relative min-w-0 flex-1 basis-56"><span className="sr-only">Buscar servicios</span><Search aria-hidden className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                  <input type="search" value={routeSearch} onChange={e => setRouteSearch(e.target.value)} placeholder="Buscar RT, OT, empresa o distrito…" className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-[#002855]" /></label>
                <select aria-label="Tipo de servicio" value={routeService} onChange={e => setRouteService(e.target.value as ServiceKind | '')} className="w-48 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-[#002855]">
                  <option value="">Todos los servicios</option>
                  {(Object.keys(SERVICE_KINDS) as ServiceKind[]).map(k => <option key={k} value={k}>{SERVICE_KINDS[k].short}</option>)}
                </select>
              </div>
              <div className="max-h-[42vh] overflow-y-auto rounded-lg border border-slate-200">
                {pendingRequests.length === 0 ? <div className="p-8 text-center text-slate-500"><p className="font-medium">No hay solicitudes disponibles</p><p className="mt-1 text-xs">Las solicitudes aprobadas aparecen aquí para armar la ruta.</p></div>
                  : routeCandidates.length === 0 ? <p className="p-6 text-center text-sm text-slate-500">Ningún servicio coincide con la búsqueda.</p>
                  : <ul className="divide-y divide-slate-100">{routeCandidates.map(req => {
                    const stop = newDispatch.selected_requests.findIndex(r => r.id === req.id)
                    const missing = partyMissing(req)
                    return <li key={req.id}>
                      <label className={`flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors ${stop >= 0 ? 'bg-blue-50/70' : 'hover:bg-slate-50'}`}>
                        <input type="checkbox" className="h-4 w-4 shrink-0 rounded border-slate-300 text-[#002855] focus:ring-[#002855] disabled:opacity-40" checked={stop >= 0}
                          disabled={Boolean(missing) && stop < 0} title={missing ? `Sin ${missing}: vincúlelo antes de programar` : undefined}
                          onChange={() => toggleRequestSelection(req.id, req.pickup_address, req.delivery_address)} />
                        <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold ${stop >= 0 ? 'bg-[#002855] text-white' : 'border border-dashed border-slate-300 text-slate-300'}`} title={stop >= 0 ? `Parada ${stop + 1}` : 'Sin seleccionar'}>{stop >= 0 ? stop + 1 : ''}</span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="text-sm font-bold text-[#002855]">{req.request_number}</span>
                            <ServiceTypeBadge request={req} />
                            <span className="text-xs font-semibold text-slate-700">{req.contracts?.code ? `OT ${req.contracts.code}` : referenceLabel(req) || 'Sin OT'}</span>
                            <span className="truncate text-xs text-slate-500">{partyName(req, (req.request_client?.business_name || req.contracts?.clients?.business_name), req.suppliers?.business_name)}</span>
                            {missing && <button type="button" onClick={e => { e.preventDefault(); e.stopPropagation(); setLinkRequest(req) }} className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700 ring-1 ring-red-200 hover:bg-red-100">Sin {missing} · vincular</button>}
                            {req.attention_mode === 'RECOJO_CLIENTE' && <span className="text-xs font-medium text-teal-700">Recojo por cliente</span>}
                            {!req.attention_mode && <span className="text-xs font-medium text-red-700">Modalidad pendiente</span>}
                            {wasRescheduled(req) && <span className="rounded-full border border-orange-200 bg-orange-100 px-2 py-0.5 text-[11px] font-bold text-orange-800" title={req.rescheduling?.fecha_anterior ? `Fecha anterior: ${serviceDate(req.rescheduling.fecha_anterior)}` : undefined}>Reprogramado</span>}
                          </span>
                          <span className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-slate-600">
                            <span>Atención: <b className="text-slate-800">{requestedAttention(req)}</b></span>
                            <span className="truncate" title={`${req.pickup_address} → ${req.delivery_address}`}>{districtOf(req.pickup_address, req.pickup_district) || 'Origen'} → {districtOf(req.delivery_address, req.delivery_district) || 'Destino'}</span>
                          </span>
                          {/* Referencia del ERP (solo lectura) de la OT de cada parada elegida */}
                          {stop >= 0 && req.contracts?.code && <span className="mt-0.5 block"><ErpOtLinea ot={req.contracts.code} /></span>}
                        </span>
                      </label>
                    </li>
                  })}</ul>}
              </div>
            </FormSection>

            <FormSection id="ruta-unidad" step={2} title={newDispatch.document_type === 'NOTA_SALIDA' ? 'Retiro por el cliente' : 'Unidad y conductor'}
              hint={newDispatch.selected_requests.length ? (newDispatch.document_type === 'NOTA_SALIDA' ? 'Modalidad heredada: recojo por el cliente · Nota de Salida' : 'Modalidad heredada: transporte JRM · Guía de Remisión') + '. Para cambiarla, edite la solicitud y vuelva a aprobarla.' : 'Seleccione primero los servicios: la modalidad se hereda de la solicitud.'}>
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
                        {' '}Con OT, se reserva en su partida a nombre del proveedor. Sin OT, el costo requiere aprobación del supervisor y se vincula a la OC, OS o RQ.
                      </p>
                    </div>
                  </>
                ) : newDispatch.document_type === 'GR' ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Placa del Vehículo</label>
                      <SearchableSelect
                        value={newDispatch.vehicle_plate}
                        onChange={(val) => {
                          const plate = val
                          const active = dispatches.find(d => d.vehicle_plate === plate)
                          const assigned = drivers.find(d => d.id === (active?.driver_id || vehicles.find(v => v.plate === plate)?.assigned_driver_id))
                          setNewDispatch({...newDispatch, vehicle_plate: plate, driver_name: assigned ? `${assigned.first_name} ${assigned.last_name}` : newDispatch.driver_name})
                          lookupFreightRate(plate, newDispatch.selected_requests.map(r => r.id))
                        }}
                        options={vehicles.map(v => ({ value: v.plate, label: `${v.plate} - ${v.brand} ${v.model} (${v.carriers?.business_name})${dispatches.some(d => d.vehicle_plate === v.plate) ? ' · Despacho activo' : ''}` }))}
                        placeholder="Seleccione vehículo..."
                      />
                      <p className="mt-1 text-xs text-slate-500">Unidades de transporte disponibles o con despacho activo para incorporar servicios.</p>
                      {occupiedAssignment && <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
                        <p className="font-semibold">{occupiedAssignment.route.dispatch_number} · {occupiedAssignment.route.status.replace(/_/g, ' ')}</p>
                        <p className="mt-1">{occupiedAssignment.kind === 'ADD_SERVICE' ? 'Esta unidad y conductor ya tienen una ruta. Incorpore los nuevos servicios uno a uno al despacho existente.' : occupiedAssignment.kind === 'CLOSING' ? 'La ruta está en retorno o pendiente de cierre. Complete su cierre antes de programar otra.' : 'La unidad o el conductor tiene otro despacho. Seleccione la misma pareja de la ruta existente o recursos disponibles.'}</p>
                        {occupiedAssignment.kind === 'ADD_SERVICE' && canAddService && <button type="button" onClick={() => openRouteAddition(occupiedAssignment.route.id)} className="mt-3 min-h-11 rounded-lg bg-jrm-navy px-4 font-semibold text-white">Agregar servicio a esta ruta</button>}
                        <Link href={`/torre-control?despacho=${occupiedAssignment.route.id}&fecha=${occupiedAssignment.route.scheduled_departure ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(occupiedAssignment.route.scheduled_departure)) : ''}`} className="mt-2 block font-semibold underline">Ver despacho en Torre de Control</Link>
                      </div>}
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
                      {ownPickupOnly && <p className="mt-2 rounded-lg bg-blue-50 p-3 text-xs text-blue-900">Recojo con flota propia: sin valorización de flete. Se conserva el seguimiento y la documentación.</p>}
                      {!ownPickupOnly && !loadingRate && !detectedFreightRate && newDispatch.vehicle_plate && newDispatch.selected_requests.length > 0 && !freightQuote && (
                        <p className="text-xs text-slate-400 mt-1">Sin tarifa registrada para esta ruta.</p>
                      )}
                    </div>
                    
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Conductor</label>
                      <SearchableSelect
                        value={newDispatch.driver_name}
                        onChange={(val) => { setNewDispatch({...newDispatch, driver_name: val}); const dId = drivers.find(d => `${d.first_name} ${d.last_name}`.trim() === val.trim())?.id; if (dId) setAuxiliares(list => list.filter(id => assistants.find(a => a.person_id === id)?.driver_id !== dId)) }}
                        options={drivers.map(d => ({ value: `${d.first_name} ${d.last_name}`, label: `${d.first_name} ${d.last_name} - ${d.document_number} (${d.carriers?.business_name})` }))}
                        placeholder="Seleccione conductor..."
                      />
                    </div>
                    <div className="md:col-span-2">
                      <RouteAuxiliaryPicker people={assistants} value={auxiliares} onChange={setAuxiliares}
                        driverId={selectedDriver?.id} loading={assistantsLoading} error={assistantsError}
                        onRefresh={() => { void fetchAssistants() }} />
                    </div>
                  </div>
                ) : (
                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700 mb-3">
                    Nota de salida seleccionada. El cliente recoge, no requiere asignar conductor ni vehículo.
                  </div>
                )}
              </div>
            </FormSection>

            <ForkliftFields value={forklift} onChange={setForklift} stops={forkliftStops} />

            <FormSection id="ruta-salida" step={3} title="Salida" hint="La fecha de salida se confirma por separado de la fecha requerida de cada servicio.">
              <div className="grid gap-3 md:grid-cols-2">
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
                  {selectedDates.length === 1 && newDispatch.scheduled_departure && newDispatch.scheduled_departure === autoDeparture && <p className="mt-2 text-xs text-emerald-700">Tomada de la fecha requerida ({serviceDate(selectedDates[0])}) a las 08:00; ajuste la hora si es necesario.</p>}
                  {selectedDates.length === 1 && newDispatch.scheduled_departure.slice(0, 10) !== selectedDates[0] && <button type="button" onClick={() => setNewDispatch(current => ({ ...current, scheduled_departure: `${selectedDates[0]}T${current.scheduled_departure.slice(11,16) || '08:00'}` }))} className="mt-2 min-h-11 text-xs font-semibold text-blue-700 underline">Usar fecha requerida: {serviceDate(selectedDates[0])}</button>}
                  {selectedDates.length > 1 && <p className="mt-2 text-xs text-amber-800">Las solicitudes tienen fechas distintas: {selectedDates.map(serviceDate).join(', ')}. Confirme la salida según el orden de atención.</p>}
                  <p className="mt-1 text-[11px] text-slate-500">La fecha de salida se confirma por separado de la fecha requerida de cada servicio.</p>
                </div>
                {newDispatch.document_type === 'GR' && !ownPickupOnly && <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1 flex justify-between items-center">
                    Distancia estimada (opcional, cálculo automático)
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
            </FormSection>

            {mixedOT && !ownPickupOnly && <FormSection id="ruta-flete" step={4} title="Flete distribuido por servicio" hint="Con OT se utiliza el margen operativo de la partida (80 % salvo ampliación autorizada). Los servicios sin OT conservan el costo aprobado y su OC, OS o RQ.">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-slate-600">Total de ruta S/ {routeFreight.toFixed(2)}</span>
                  <button type="button" onClick={() => setFreightShares({})} className="text-xs text-blue-700 underline">Distribuir según los estimados</button>
                </div>
                <p className="text-xs text-slate-600">La propuesta usa los costos estimados de las solicitudes; puede ajustar cada monto antes de confirmar. En los servicios con OT, el 20% de utilidad queda protegido. En los servicios sin OT, el supervisor autoriza el costo sobre la OC, OS o RQ.</p>
                {modalidad === 'PROPIA' && selectedServices.some(r => r.request_type === 'RECOJO') && <p className="rounded-lg bg-blue-50 p-3 text-xs text-blue-900">Los recojos de esta ruta no se valorizan. El flete se distribuye solo entre los demás servicios.</p>}
                {selectedServices.map(req => (
                  <label key={req.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span><strong>{req.request_number}</strong> · {req.contracts?.code ? `OT ${req.contracts.code}` : referenceLabel(req) || 'Sin referencia'} · {serviceLabel(req)}</span>
                    <span className="flex items-center gap-1">S/
                      <input disabled={modalidad === 'PROPIA' && req.request_type === 'RECOJO'} type="number" min="0" step="0.01" aria-label={`Flete ${req.request_number}`} value={modalidad === 'PROPIA' && req.request_type === 'RECOJO' ? '0.00' : freightShares[req.id] ?? serviceShare(req.id).toFixed(2)} onChange={e => setFreightShares(prev => ({ ...prev, [req.id]: e.target.value }))} className="w-28 rounded border border-blue-200 bg-white px-2 py-1 text-right" />
                    </span>
                  </label>
                ))}
                <p className={`text-xs font-semibold ${allocationMatches ? 'text-emerald-700' : 'text-red-700'}`}>Total de ruta S/ {routeFreight.toFixed(2)} · Distribuido S/ {selectedServices.reduce((sum, r) => sum + serviceShare(r.id), 0).toFixed(2)}{!allocationMatches && ' · Ajuste la distribución para continuar'}</p>
              </div>
            </FormSection>}
            <p className="text-xs text-slate-500">Para sumar servicios después de programar y antes de salir, cancele y rearme la ruta; el sistema libera las reservas y conserva el motivo. En ruta, registre una incidencia.</p>
          </div>

          <aside className="space-y-3 lg:sticky lg:top-0 lg:self-start">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
              <p className="mb-3 text-xs font-bold uppercase tracking-wide text-slate-500">Resumen de la ruta</p>
              <p className="text-xs text-slate-500">Paradas</p>
              {selectedServices.length ? <ol className="mt-1 space-y-1.5">{selectedServices.map((req, i) => <li key={req.id} className="flex items-center gap-2">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[#002855] text-[10px] font-bold text-white">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate"><b className="text-slate-900">{req.request_number}</b> <span className="text-slate-500">· {(req.request_type === 'RECOJO' || req.attention_mode === 'RECOJO_CLIENTE' ? districtOf(req.pickup_address, req.pickup_district) : districtOf(req.delivery_address, req.delivery_district)) || 'Sin distrito'}</span></span>
                <ServiceTypeBadge request={req} />
              </li>)}</ol> : <p className="mt-1 font-semibold text-slate-400">Sin servicios</p>}
              <dl className="mt-3 space-y-2 border-t border-slate-200 pt-3">
                <div className="flex justify-between gap-2"><dt className="text-slate-500">Documento</dt><dd className="font-semibold text-slate-900">{newDispatch.selected_requests.length ? newDispatch.document_type === 'NOTA_SALIDA' ? 'Nota de Salida' : 'Guía de Remisión' : '—'}</dd></div>
                {newDispatch.document_type === 'GR' && <>
                  <div className="flex justify-between gap-2"><dt className="text-slate-500">Unidad</dt><dd className="truncate font-semibold text-slate-900">{(modalidad === 'TERCERO' ? tercero.placa : newDispatch.vehicle_plate) || '—'}{modalidad === 'TERCERO' && <span className="font-normal text-slate-500"> · tercero</span>}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-slate-500">Conductor</dt><dd className="truncate font-semibold text-slate-900">{(modalidad === 'TERCERO' ? tercero.conductor : newDispatch.driver_name) || '—'}</dd></div>
                  {auxiliares.length > 0 && modalidad === 'PROPIA' && <div className="flex justify-between gap-2"><dt className="text-slate-500">{auxiliares.length > 1 ? `Auxiliares (${auxiliares.length})` : 'Auxiliar'}</dt><dd className="truncate font-semibold text-slate-900" title={auxiliares.map(id => assistants.find(a => a.person_id === id)?.name).filter(Boolean).join(', ')}>{auxiliares.map(id => assistants.find(a => a.person_id === id)?.name).filter(Boolean).join(', ') || '—'}</dd></div>}
                </>}
                <div className="flex justify-between gap-2"><dt className="text-slate-500">Salida</dt><dd className="font-semibold text-slate-900">{newDispatch.scheduled_departure ? cellDateTime(new Date(newDispatch.scheduled_departure).toISOString()) : '—'}</dd></div>
                {newDispatch.document_type === 'GR' && <div className="flex justify-between gap-2"><dt className="text-slate-500">Distancia</dt><dd className="font-semibold tabular-nums text-slate-900">{newDispatch.estimated_distance_km !== '' ? `${newDispatch.estimated_distance_km} km` : '—'}</dd></div>}
                {routeForklift.enabled && <div className="flex justify-between gap-2"><dt className="text-slate-500">Montacarga en</dt><dd className="text-right font-semibold text-slate-900">{forkliftStops.find(stop => stop.id === routeForklift.transport_request_id)?.label || 'Seleccione la parada'}</dd></div>}
                <div className="flex justify-between gap-2"><dt className="text-slate-500">Flete de ruta</dt><dd className="font-semibold tabular-nums text-slate-900">S/ {routeFreight.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</dd></div>
              </dl>
            </div>
            <PendingPanel items={routePending} doneText="Revise las paradas y programe la ruta." />
          </aside>
        </form>
      </Modal>
      {linkRequest && <LinkPartyModal request={linkRequest} onClose={() => setLinkRequest(null)} onLinked={() => void fetchData()} />}
      <AddRouteService dispatchId={addServiceId} initialRequestId={newDispatch.selected_requests[0]?.id} onClose={() => { setAddServiceId(null); setIsModalOpen(true) }} onChanged={requestId => { setNewDispatch(previous => ({ ...previous, selected_requests: previous.selected_requests.filter(request => request.id !== requestId) })); void fetchData() }} />
    </div>
  )
}
