'use client'
import { useState, useEffect, useRef, useCallback, type Dispatch as SetState, type SetStateAction } from 'react'
import { toast } from 'sonner'
import type { SupabaseClient } from '@supabase/supabase-js'
import { EMPTY_FORKLIFT, forkliftValid, forkliftForStops } from '@/components/despacho/ForkliftFields'
import { INHERITED_LINE_COLUMNS, EMPTY_SPECIAL_SERVICES, specialServicesPayload, type InheritedLine } from '@/components/despacho/InheritedSpecialServices'
import { TERCERO_VACIO, type TerceroForm } from '@/components/despacho/Tercero'
import type { RouteAssistant } from '@/components/despacho/RouteAuxiliaryPicker'
import { referenceLabel } from '@/lib/suppliers'
import { splitFreight } from '@/lib/transport-budget'
import { calculateRouteEstimate, type RouteEstimate } from '@/lib/routing'
import { errorMessage } from '@/lib/caja'
import { checkDispatchEligibility, type DispatchEligibilityResult } from '@/lib/eligibility'
import { OCCUPIED_DISPATCH_STATUSES, routeAssignment } from '@/lib/route-assignment'
import { partyMissing, type Dispatch, type PlanningDriver, type PlanningVehicle, type TransportRequest } from './types'
import { collectChecks, firstBlockedStep, blocking, lateStops, type RouteCheck, type RouteStep } from './route-checks'

type Router = { push: (href: string) => void }
export type CubicajeCalc = { kg: number; m3: number; kgSinMedida: number }
type StockCorte = { estado: 'VIGENTE' | 'DESACTUALIZADO' | 'SIN_CARGA'; horas: number | null; max_horas: number }
type NewDispatch = {
  selected_requests: { id: string, document_number: string }[],
  driver_name: string,
  vehicle_plate: string,
  scheduled_departure: string,
  estimated_distance_km: number | '',
  document_type: 'GR' | 'NOTA_SALIDA'
}
const EMPTY_DISPATCH: NewDispatch = { selected_requests: [], driver_name: '', vehicle_plate: '', scheduled_departure: '', estimated_distance_km: '', document_type: 'GR' }

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

/**
 * Estado y reglas del armado de ruta («Armar ruta y programar unidad»). Las llamadas a la base (schedule_route_resources,
 * authorize_pickup_reference_freight, set_dispatch_freight_quote) son las mismas de siempre; la base vuelve a validar todo.
 */
export function useRouteBuilder({ supabase, pendingRequests, setPendingRequests, dispatches, vehicles, drivers, fetchData, canAddService, canAuthorizeFreight, router, onLinkRequest }: {
  supabase: SupabaseClient
  pendingRequests: TransportRequest[]
  setPendingRequests: SetState<SetStateAction<TransportRequest[]>>
  dispatches: Dispatch[]
  vehicles: PlanningVehicle[]
  drivers: PlanningDriver[]
  fetchData: () => Promise<void> | void
  canAddService: boolean
  /** Supervisor de Transporte (despacho-aprobacion): autoriza el flete del tercero en servicios sin OT. */
  canAuthorizeFreight: boolean
  router: Router
  onLinkRequest: (request: TransportRequest) => void
}) {
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [addServiceId, setAddServiceId] = useState<string | null>(null)
  const [step, setStep] = useState<RouteStep>(1)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [calculatingDistance, setCalculatingDistance] = useState(false)
  const reqDistances = useRef<Record<string, number>>({})
  // Estimado de OSRM por solicitud (tiempo y trazo) que se guarda con la ruta para el detalle del despacho
  const reqEstimates = useRef<Record<string, RouteEstimate>>({})
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
  // Acuerdos con proveedores de los servicios especiales (se envían al programar)
  const [specialServices, setSpecialServices] = useState(EMPTY_SPECIAL_SERVICES)
  // Servicios especiales pedidos en las solicitudes seleccionadas (se heredan al programar)
  const [inheritedLines, setInheritedLines] = useState<InheritedLine[]>([])
  const autoForklift = useRef<Set<string>>(new Set())
  const [newDispatch, setNewDispatch] = useState<NewDispatch>(EMPTY_DISPATCH)
  const [freightShares, setFreightShares] = useState<Record<string, string>>({})
  // Motivo cuando el flete de la ruta difiere del referencial de las solicitudes
  const [freightReason, setFreightReason] = useState('')
  // Observaciones operativas de la programación (obligatorias si la salida queda después de la atención requerida)
  const [notes, setNotes] = useState('')
  const [cubicaje, setCubicaje] = useState<CubicajeCalc | null>(null)
  const [terceroCapacityKg, setTerceroCapacityKg] = useState<number | null>(null)
  const [stockCorte, setStockCorte] = useState<StockCorte | null>(null)
  const [eligibility, setEligibility] = useState<{ key: string; result: DispatchEligibilityResult | null }>({ key: '', result: null })

  const selectedServices = newDispatch.selected_requests.map(selected => pendingRequests.find(r => r.id === selected.id)).filter((r): r is TransportRequest => !!r)
  const forkliftStops = selectedServices.map(request => ({ id: request.id,
    label: `${request.request_number} · ${request.delivery_address || request.delivery_district || 'Destino sin dirección'}` }))
  const routeForklift = forkliftForStops(forklift, forkliftStops)
  const selectedIdsKey = newDispatch.selected_requests.map(r => r.id).join(',')
  useEffect(() => {
    let cancel = false
    const t = window.setTimeout(async () => {
      const ids = selectedIdsKey ? selectedIdsKey.split(',') : []
      if (!ids.length) { autoForklift.current.clear(); setInheritedLines([]); return }
      const { data, error } = await supabase.from('transport_unloading_costs').select(INHERITED_LINE_COLUMNS)
        .in('transport_request_id', ids).in('status', ['ESTIMADO', 'PLANIFICADO']).is('dispatch_id', null).order('created_at')
      if (cancel) return
      if (error) { setInheritedLines([]); toast.error('No se pudieron leer los servicios especiales: ' + error.message); return }
      const lines = (data || []) as unknown as InheritedLine[]
      setInheritedLines(lines)
      // Montacarga pedido en la solicitud: el apoyo abre activado en la parada de esa solicitud (una sola vez).
      const requested = ids.map(id => lines.find(l => l.concept === 'MONTACARGAS' && l.transport_request_id === id)).find(Boolean)
      if (requested && !autoForklift.current.has(requested.transport_request_id)) {
        autoForklift.current.add(requested.transport_request_id)
        setForklift(prev => prev.enabled ? prev : { ...prev, enabled: true, transport_request_id: requested.transport_request_id })
      }
    }, 0)
    return () => { cancel = true; window.clearTimeout(t) }
  }, [supabase, selectedIdsKey])

  const mixedOT = new Set(selectedServices.map(r => r.contract_id || `ORDEN:${r.reference_type || ''}:${r.reference_number || r.id}`)).size > 1
  const selectedDates = [...new Set(selectedServices.map(r => r.required_date?.slice(0,10)).filter((date): date is string => !!date))]
  const customerPickup = selectedServices[0]?.attention_mode === 'RECOJO_CLIENTE'
  const selectedDriver = drivers.find(d => `${d.first_name} ${d.last_name}`.trim() === newDispatch.driver_name.trim())
  const selectedVehicle = vehicles.find(v => v.plate === newDispatch.vehicle_plate)
  const occupiedAssignment = newDispatch.document_type === 'GR' && modalidad === 'PROPIA'
    ? routeAssignment(dispatches, newDispatch.vehicle_plate, selectedDriver?.id) : null
  const openRouteAddition = (id: string) => { setIsModalOpen(false); setAddServiceId(id) }
  // Operación interna con flota propia: recojos y servicios sin OT (traslados, recojos con OC/OS/RQ) no llevan flete.
  // Con OT el flete es costo logístico de su partida; con tercero todo servicio tiene costo (misma regla que la base).
  const internalService = (r: TransportRequest) => modalidad === 'PROPIA' && (r.request_type === 'RECOJO' || !r.contract_id)
  const ownInternalOnly = modalidad === 'PROPIA' && selectedServices.length > 0 && selectedServices.every(internalService)
  const valuedServices = selectedServices.filter(r => !internalService(r))
  // El flete acordado se escribe siempre (propia o tercero); el tarifario solo se usa si el usuario lo elige.
  const freightTyped = manualFreightCost.trim() !== ''
  const routeFreight = customerPickup || ownInternalOnly ? 0 : Math.max(Number(manualFreightCost) || 0, 0)
  const defaultShares = splitFreight(routeFreight, valuedServices)
  const serviceShare = (id: string) => selectedServices.some(r => r.id === id && internalService(r)) ? 0 : Number(freightShares[id] ?? defaultShares.find(r => r.id === id)?.amount ?? 0)
  const allocationMatches = Math.round(selectedServices.reduce((sum, r) => sum + serviceShare(r.id), 0) * 100) === Math.round(routeFreight * 100)
  // Flete acordado vs. referencial (suma del costo de las solicitudes): si difieren se exige motivo, igual que el servidor.
  // Solo cuentan los servicios que llevan flete. Sin motivo: operación interna con flota propia y Nota de Salida sin flete.
  const referentialFreight = valuedServices.reduce((sum, r) => sum + Number(r.service_cost || 0), 0)
  const freightExempt = routeFreight === 0 && (newDispatch.document_type === 'NOTA_SALIDA' || customerPickup || ownInternalOnly)
  const freightNeedsReason = selectedServices.length > 0 && !freightExempt && Math.round(routeFreight * 100) !== Math.round(referentialFreight * 100)
  // Un servicio de transporte de una OT no se programa sin costo, sea flota propia o tercero (misma regla que la base).
  // Excepciones: recojo por el cliente y recojo con flota propia (no se valoriza).
  const costedOT = (r: TransportRequest) => !!r.contract_id && r.attention_mode !== 'RECOJO_CLIENTE' && !internalService(r)
  // Tercero en un servicio sin OT: el Supervisor de Transporte autoriza el flete pactado contra la OC, OS o RQ al programar.
  const externalFunding = newDispatch.document_type === 'GR' && modalidad === 'TERCERO'
    ? selectedServices.filter(r => !r.contract_id && serviceShare(r.id) > 0 && serviceShare(r.id) + Number(r.unloading_estimate_pen || 0) > Number(r.operational_approved_pen || 0))
    : []
  const fundingLabel = externalFunding.map(r => `${r.request_number} S/ ${(serviceShare(r.id) + Number(r.unloading_estimate_pen || 0) - Number(r.operational_approved_pen || 0)).toFixed(2)}`).join(', ')
  // Con tercero el flete pactado con el proveedor es obligatorio, tenga o no OT (el proveedor siempre cobra).
  const terceroFreightMissing = newDispatch.document_type === 'GR' && modalidad === 'TERCERO' && selectedServices.length > 0 && !customerPickup && routeFreight <= 0
  // Con flota propia el flete se escribe (o se toma el tarifario con el botón): ya no se asume en silencio.
  const ownFreightUntyped = newDispatch.document_type === 'GR' && modalidad === 'PROPIA' && selectedServices.length > 0 && !ownInternalOnly && !customerPickup && !freightTyped
  const freightMissing = terceroFreightMissing || (newDispatch.document_type === 'GR' && selectedServices.some(costedOT) && routeFreight <= 0)
  const shareMissing = newDispatch.document_type === 'GR' && mixedOT && selectedServices.some(r => costedOT(r) && serviceShare(r.id) <= 0)

  // Capacidad: el peso declarado en las solicitudes es dato del usuario y bloquea si supera la capacidad registrada;
  // el cubicaje con el stock del ERP es referencial y solo advierte.
  const capacityKg = newDispatch.document_type !== 'GR' ? null : modalidad === 'PROPIA' ? Number(selectedVehicle?.weight_capacity) || null : terceroCapacityKg
  const capacityM3 = newDispatch.document_type === 'GR' && modalidad === 'PROPIA' ? Number(selectedVehicle?.volume_capacity) || null : null
  const declaredKg = selectedServices.reduce((sum, r) => sum + Number(r.estimated_weight || 0), 0)
  const late = lateStops(selectedServices, newDispatch.scheduled_departure)
  const special = specialServicesPayload(specialServices, inheritedLines, routeForklift)
  const eligibilityKey = newDispatch.document_type === 'GR' && modalidad === 'PROPIA' && selectedVehicle && selectedDriver ? `${selectedVehicle.plate}|${selectedDriver.id}` : ''
  const currentEligibility = eligibility.key === eligibilityKey ? eligibility.result : null
  const terceroIncomplete = !tercero.carrier_id || !tercero.placa.trim() || !tercero.conductor.trim() || !tercero.telefono.trim() || !tercero.doc.trim()

  const has = newDispatch.selected_requests.length > 0
  const gr = has && newDispatch.document_type === 'GR'
  const checks: RouteCheck[] = collectChecks([
    !has && { key: 'servicios', label: 'Seleccionar al menos un servicio', step: 1, level: 'block' },
    gr && modalidad === 'PROPIA' && !newDispatch.vehicle_plate && { key: 'placa', label: 'Placa del vehículo', step: 2, level: 'block' },
    gr && modalidad === 'PROPIA' && !newDispatch.driver_name && { key: 'conductor', label: 'Conductor', step: 2, level: 'block' },
    gr && modalidad === 'TERCERO' && terceroIncomplete && { key: 'tercero', label: 'Datos del transportista tercero', step: 2, level: 'block' },
    occupiedAssignment && { key: 'ocupada', label: occupiedAssignment.kind === 'ADD_SERVICE' ? `La unidad ya tiene la ruta ${occupiedAssignment.route.dispatch_number}: agregue el servicio a esa ruta` : occupiedAssignment.kind === 'CLOSING' ? `La ruta ${occupiedAssignment.route.dispatch_number} está pendiente de cierre` : 'La unidad o el conductor tiene otro despacho', step: 2, level: 'block' },
    currentEligibility?.status === 'BLOQUEADO' && { key: 'elegibilidad', label: `Unidad o conductor no habilitado: ${currentEligibility.blocking_reasons.join('; ')}`, step: 2, level: 'block' },
    currentEligibility?.status === 'APTO_CON_OBSERVACION' && { key: 'observaciones-doc', label: `Observaciones documentarias: ${currentEligibility.observation_reasons.join('; ')}`, step: 2, level: 'warn' },
    terceroFreightMissing && { key: 'flete-tercero', label: 'Flete pactado con el proveedor', step: 2, level: 'block' },
    !terceroFreightMissing && ownFreightUntyped && { key: 'flete-propio', label: 'Flete de la ruta (escriba el monto o use el tarifario)', step: 2, level: 'block' },
    !terceroFreightMissing && !ownFreightUntyped && freightMissing && { key: 'flete-ot', label: 'Flete de la ruta: un servicio de OT no puede quedar sin costo', step: 2, level: 'block' },
    shareMissing && { key: 'flete-reparto', label: 'Flete de cada servicio de OT (ninguno en S/ 0)', step: 2, level: 'block' },
    mixedOT && !allocationMatches && { key: 'distribucion', label: 'Distribución del flete por servicio', step: 2, level: 'block' },
    externalFunding.length > 0 && !canAuthorizeFreight && { key: 'autorizacion-tercero', label: `Flete del tercero sin cobertura de la OC, OS o RQ (falta ${fundingLabel}): lo autoriza el Supervisor de Transporte al programar`, step: 2, level: 'block' },
    externalFunding.length > 0 && canAuthorizeFreight && { key: 'autorizacion-tercero', label: `Al programar se autoriza el flete del tercero sobre la OC, OS o RQ (${fundingLabel})`, step: 2, level: 'warn' },
    freightNeedsReason && freightReason.trim().length < 5 && { key: 'motivo-flete', label: 'Motivo del flete distinto al referencial', step: 2, level: 'block' },
    gr && capacityKg != null && declaredKg > capacityKg && { key: 'capacidad', label: `Exceso de capacidad: ${Math.round(declaredKg).toLocaleString('es-PE')} kg declarados para ${Math.round(capacityKg).toLocaleString('es-PE')} kg de la unidad`, step: 2, level: 'block' },
    gr && capacityKg != null && declaredKg <= capacityKg && cubicaje && cubicaje.kg > capacityKg && { key: 'capacidad-ref', label: 'El peso referencial del ERP supera la capacidad de la unidad: confirme la carga real', step: 2, level: 'warn' },
    gr && capacityKg != null && declaredKg <= capacityKg && declaredKg > capacityKg * 0.9 && { key: 'capacidad-90', label: 'La carga declarada supera el 90 % de la capacidad', step: 2, level: 'warn' },
    gr && capacityM3 != null && cubicaje && cubicaje.m3 > capacityM3 && { key: 'volumen', label: 'El volumen estimado supera la capacidad de la unidad', step: 2, level: 'warn' },
    gr && modalidad === 'TERCERO' && capacityKg == null && { key: 'capacidad-tercero', label: 'Unidad del tercero sin capacidad registrada', step: 2, level: 'info' },
    has && !forkliftValid(routeForklift, forkliftStops) && { key: 'montacarga', label: 'Montacarga: parada, proveedor, montacarguista y tarifa por hora', step: 3, level: 'block' },
    has && forkliftValid(routeForklift, forkliftStops) && !!special.error && { key: 'adicionales', label: special.error, step: 3, level: 'block' },
    !newDispatch.scheduled_departure && { key: 'salida', label: 'Fecha y hora de salida', step: 4, level: 'block' },
    late.length > 0 && notes.trim().length < 5 && { key: 'salida-tarde', label: `La salida queda después de la atención requerida (${late.map(r => r.request_number).join(', ')}): indique el motivo en Observaciones`, step: 4, level: 'block' },
    has && stockCorte && stockCorte.estado !== 'VIGENTE' && { key: 'stock', label: stockCorte.estado === 'SIN_CARGA' ? 'Sin carga del stock del ERP' : 'Stock del ERP desactualizado: cargue el Excel «Stock Bodega Despacho»', step: 1, level: 'warn' },
    gr && cubicaje && cubicaje.kgSinMedida > 0 && { key: 'volumen-parcial', label: 'Volumen parcial: hay productos sin densidad configurada', step: 1, level: 'info' },
  ])
  const blockers = blocking(checks)

  const programmingRequests = () => newDispatch.selected_requests.map(req => ({ ...req,
    leg_planned_km: reqDistances.current[req.id] ?? null, freight_share_pen: serviceShare(req.id) }))

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

  // Corte del stock del ERP: alerta del resumen (se consulta al abrir el armado)
  useEffect(() => {
    if (!isModalOpen) return
    let alive = true
    Promise.resolve(supabase.rpc('erp_stock_corte')).then(({ data, error }) => {
      if (alive && !error && (data as { success?: boolean } | null)?.success) setStockCorte(data as StockCorte)
    }, () => {})
    return () => { alive = false }
  }, [isModalOpen, supabase])

  // Capacidad de la unidad registrada del tercero (capacity_tons, si existe en la ficha)
  useEffect(() => {
    let alive = true
    const id = tercero.supplier_vehicle_id
    const t = window.setTimeout(() => {
      if (!id) { setTerceroCapacityKg(null); return }
      void supabase.from('supplier_vehicles').select('*').eq('id', id).maybeSingle().then(({ data }) => {
        const tons = Number((data as Record<string, unknown> | null)?.capacity_tons)
        if (alive) setTerceroCapacityKg(tons > 0 ? tons * 1000 : null)
      })
    }, 0)
    return () => { alive = false; window.clearTimeout(t) }
  }, [supabase, tercero.supplier_vehicle_id])

  // Elegibilidad de unidad y conductor apenas se eligen (se vuelve a verificar al programar)
  useEffect(() => {
    if (!eligibilityKey) return
    let alive = true
    const [plate, driverId] = eligibilityKey.split('|')
    checkDispatchEligibility(plate, driverId).then(result => { if (alive) setEligibility({ key: eligibilityKey, result }) }, () => {})
    return () => { alive = false }
  }, [eligibilityKey])

  const reset = () => {
    setStep(1); setAutoDeparture(''); setAuxiliares([])
    setForklift(EMPTY_FORKLIFT); setSpecialServices(EMPTY_SPECIAL_SERVICES)
    setNewDispatch(EMPTY_DISPATCH)
    setManualFreightCost(''); setFreightReason(''); setNotes(''); setFreightShares({})
    setTercero(TERCERO_VACIO); setModalidad('PROPIA')
  }

  // Detalle del tarifario de la ruta recién programada: si falla, la ruta ya existe; se avisa y se reintenta solo este paso
  const saveQuote = async (dispatchId: string, quote: Record<string, unknown>): Promise<void> => {
    const { error } = await supabase.rpc('set_dispatch_freight_quote', { p_dispatch_id: dispatchId, p_breakdown: quote })
    if (error) toast.error('La ruta se programó, pero no se guardó el detalle del tarifario: ' + error.message, {
      duration: 15000, action: { label: 'Reintentar', onClick: () => { void saveQuote(dispatchId, quote) } },
    })
  }

  // Observaciones operativas: se guardan en la ruta recién programada
  const saveNotes = async (dispatchId: string) => {
    if (!notes.trim()) return
    const { error } = await supabase.rpc('set_dispatch_programming_notes', { p_dispatch_id: dispatchId, p_notes: notes.trim() })
    if (error) toast.error('La ruta se programó, pero no se guardaron las observaciones: ' + error.message)
  }

  // Tiempo y trazo estimados por OSRM: se guardan con la ruta; si falla, la ruta ya quedó programada
  const saveEstimates = async (dispatchId: string) => {
    const items = newDispatch.selected_requests.map(r => reqEstimates.current[r.id] && { request_id: r.id, distance_km: Math.round(reqEstimates.current[r.id].km * 10) / 10,
      duration_min: reqEstimates.current[r.id].minutes, origin: reqEstimates.current[r.id].origin, destination: reqEstimates.current[r.id].destination,
      geometry: reqEstimates.current[r.id].geometry }).filter(Boolean)
    if (!items.length) return
    const { error } = await supabase.rpc('save_dispatch_route_estimates', { p_dispatch: dispatchId, p_items: items })
    if (error) console.warn('No se guardó el estimado de la ruta:', error.message)
  }

  const handleProgramar = async () => {
    if (newDispatch.selected_requests.length === 0) {
      toast.error('Debes seleccionar al menos una solicitud.')
      return
    }
    if (blockers.length) {
      const first = firstBlockedStep(checks, 5)
      if (first) setStep(first)
      toast.error(`Falta completar: ${blockers[0].label}`)
      return
    }
    if (freightMissing || shareMissing) {
      toast.error(terceroFreightMissing ? 'Indique el flete pactado con el proveedor: es obligatorio para programar con tercero.' : freightMissing ? 'Indique el flete de la ruta: un servicio de transporte de una OT no puede quedar sin costo, sea flota propia o tercero.' : 'Cada servicio de OT debe llevar su flete en la distribución.')
      return
    }

    const selectedReqsFull = pendingRequests.filter(pr => newDispatch.selected_requests.some(sr => sr.id === pr.id))
    const isPickup = selectedReqsFull[0]?.attention_mode === 'RECOJO_CLIENTE'
    if (selectedReqsFull.some(r => !r.attention_mode || (r.attention_mode === 'RECOJO_CLIENTE') !== isPickup)) {
      toast.error('Defina la modalidad en Solicitudes; no mezcle recojos por cliente y transporte JRM.'); return
    }
    if (!forkliftValid(routeForklift, forkliftStops)) { toast.error('Seleccione la parada del montacarga y complete proveedor, montacarguista y tarifa por hora.'); return }
    if (special.error) { toast.error(special.error); return }
    if (freightNeedsReason && freightReason.trim().length < 5) { toast.error('Indique el motivo: el flete de la ruta difiere del referencial de las solicitudes (mínimo 5 caracteres).'); return }
    const freight_reason = freightNeedsReason ? freightReason.trim() : null
    // El servidor valida la reserva vigente y el gasto autorizado; saldo cero puede ser una reserva propia.
    setIsSubmitting(true)
    if (modalidad === 'TERCERO' && newDispatch.document_type === 'GR') {
      try {
        if (mixedOT && !allocationMatches) throw new Error('La suma del flete por servicio debe coincidir con el total de la ruta.')
        if (terceroIncomplete) {
          throw new Error('Complete transportista, placa, chofer, documento de identidad y celular del tercero.')
        }
        const firstReq = pendingRequests.find(r => r.id === newDispatch.selected_requests[0].id)
        const freightCost = routeFreight
        const pickupFunding = externalFunding
        if (pickupFunding.length && !window.confirm(`Autorizar el flete contratado al tercero (sin OT):${pickupFunding.map(r => `${r.request_number} · ${referenceLabel(r)} · S/ ${serviceShare(r.id).toFixed(2)}`).join('; ')}. La descarga se añade al importe autorizado. Esta aprobación queda registrada aunque la programación deba reintentarse.`)) return
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
        const { data: newDispatchId, error } = await supabase.rpc('schedule_route_resources', { p: { mode: 'TERCERO', forklift: routeForklift.enabled ? routeForklift : null, auxiliaries: [], special_services: special.value, freight_reason,
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
          await saveQuote(newDispatchId as string, freightQuote)
        }
        if (newDispatchId) { await saveNotes(newDispatchId as string); await saveEstimates(newDispatchId as string) }
        toast.success('Servicio programado. El acceso del proveedor está listo para compartir.')
        if (newDispatchId) {
          const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(newDispatch.scheduled_departure))
          router.push(`/torre-control?despacho=${newDispatchId}&fecha=${day}&proveedor=1`)
        }
        setIsModalOpen(false)
        reset()
        void fetchData()
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
          return
        }
        const result = await checkDispatchEligibility(newDispatch.vehicle_plate, matches[0].id)
        if (result.status === 'BLOQUEADO') {
          toast.error(`Despacho bloqueado: ${result.blocking_reasons.join('; ')}`, {
            description: result.observation_reasons.length ? `Observaciones documentarias: ${result.observation_reasons.join('; ')}` : undefined,
          })
          return
        }
        if (result.status === 'APTO_CON_OBSERVACION') {
          const reasons = result.observation_reasons.join('; ')
          const proceed = window.confirm(`El despacho tiene observaciones: ${reasons}. ¿Desea proceder de todos modos?`)
          if (!proceed) return
        }
      }

      const firstReq = pendingRequests.find(r => r.id === newDispatch.selected_requests[0].id)
      const freightCost = routeFreight
      const { data: newDispatchId, error } = await supabase.rpc('schedule_route_resources', { p: { mode: 'PROPIA', forklift: routeForklift.enabled ? routeForklift : null, auxiliaries: isPickup ? [] : auxiliares, special_services: special.value, freight_reason,
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
        await saveQuote(newDispatchId as string, freightQuote)
      }
      if (newDispatchId) { await saveNotes(newDispatchId as string); await saveEstimates(newDispatchId as string) }
      toast.success(isPickup ? 'Recojo por el cliente programado con Nota de Salida y sin flete JRM.' : 'Despacho programado y financiamiento validado.')
      setIsModalOpen(false)
      reset()
      void fetchData()
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
    if (missingParty) { toast.error(`${request?.request_number} no tiene ${missingParty}: vincúlelo antes de programarla.`); if (request) onLinkRequest(request); return }
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
          const estimate = await calculateRouteEstimate(pickup, delivery)
          const km = estimate?.km
          if (estimate && km) {
            reqDistances.current[reqId] = km // Guardar en caché para la próxima
            reqEstimates.current[reqId] = estimate

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
        } catch {
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
    void lookupFreightRate(modalidad === 'TERCERO' ? 'EXTERNO' : newDispatch.vehicle_plate, updatedIds)
  }

  /** Cambia el orden de atención: mueve la parada `id` a la posición `to` (0 = primera). */
  const moveStop = (id: string, to: number) => setNewDispatch(prev => {
    const list = [...prev.selected_requests]
    const from = list.findIndex(r => r.id === id)
    if (from < 0 || to < 0 || to >= list.length || from === to) return prev
    const [item] = list.splice(from, 1)
    list.splice(to, 0, item)
    return { ...prev, selected_requests: list }
  })

  const changeModalidad = (m: 'PROPIA' | 'TERCERO') => {
    setModalidad(m)
    void lookupFreightRate(m === 'TERCERO' ? 'EXTERNO' : newDispatch.vehicle_plate, newDispatch.selected_requests.map(r => r.id))
  }
  const changeVehicle = (plate: string) => {
    const active = dispatches.find(d => d.vehicle_plate === plate)
    const assigned = drivers.find(d => d.id === (active?.driver_id || vehicles.find(v => v.plate === plate)?.assigned_driver_id))
    setNewDispatch({ ...newDispatch, vehicle_plate: plate, driver_name: assigned ? `${assigned.first_name} ${assigned.last_name}` : newDispatch.driver_name })
    void lookupFreightRate(plate, newDispatch.selected_requests.map(r => r.id))
  }
  const changeDriver = (name: string) => {
    setNewDispatch({ ...newDispatch, driver_name: name })
    const dId = drivers.find(d => `${d.first_name} ${d.last_name}`.trim() === name.trim())?.id
    if (dId) setAuxiliares(list => list.filter(id => assistants.find(a => a.person_id === id)?.driver_id !== dId))
  }

  return {
    isModalOpen, setIsModalOpen, addServiceId, setAddServiceId, step, setStep, isSubmitting, calculatingDistance, autoDeparture,
    detectedFreightRate, loadingRate, manualFreightCost, setManualFreightCost, freightQuote, modalidad, changeModalidad, tercero, setTercero,
    assistants, assistantsLoading, assistantsError, fetchAssistants, auxiliares, setAuxiliares, forklift, setForklift, routeForklift, forkliftStops,
    specialServices, setSpecialServices, inheritedLines, newDispatch, setNewDispatch, freightShares, setFreightShares, freightReason, setFreightReason,
    notes, setNotes, cubicaje, setCubicaje, stockCorte, currentEligibility, selectedServices, selectedDates, customerPickup, selectedDriver, selectedVehicle,
    occupiedAssignment, openRouteAddition, internalService, ownInternalOnly, routeFreight, serviceShare, allocationMatches, referentialFreight, freightNeedsReason,
    costedOT, terceroFreightMissing, freightMissing, mixedOT, capacityKg, capacityM3, declaredKg, late, checks, blockers, canAddService,
    handleProgramar, toggleRequestSelection, moveStop, changeVehicle, changeDriver, vehicles, drivers, dispatches, pendingRequests,
  }
}

export type RouteBuilder = ReturnType<typeof useRouteBuilder>
