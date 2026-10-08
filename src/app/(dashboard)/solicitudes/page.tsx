"use client"
import { TransportWorkflow, TorreControlButton } from '@/components/transport/TransportWorkflow'
import { DataTable } from '@/components/ui/data-table'
import { TableActions, type TableAction } from '@/components/ui/table-actions'
import { TablePagination } from '@/components/ui/table-pagination'
import { PageHeader } from '@/components/ui/page-header'
import { InlineStatusBar } from '@/components/ui/inline-status-bar'
import { FilterToolbar, FilterField, filterControl } from '@/components/ui/filter-toolbar'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'

import { DEFAULT_LEAD_TIME_SETTINGS, evaluateLeadTime, settingsForRequest, limaDateTimeToIso, limaInputParts, formatLeadTimeStatus, type DeliveryZone, type TransportLeadTimeSettings } from '@/lib/transport-lead-time'
import { operatingBudget } from '@/lib/transport-budget'
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Plus, Send, Check, X, Search, Loader2, Clock, CalendarClock, Ban, Edit2, ArrowUpDown, ArrowUp, ArrowDown, Eye, Layers, CheckCircle2, Truck, Copy, FilePen, History } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { usePermissions } from '@/hooks/usePermissions'
import { normalizeRoleName } from '@/lib/roles'
import { OtPicker, type OtNode } from '@/components/solicitudes/OtPicker'
import { QuoteBreakdown } from '@/components/tarifas/TransportTariffManager'
import { serviceAddresses, serviceLabel, serviceKind, SERVICE_KINDS, executionWeightLabels, type RequestExecution, type ServiceKind } from '@/lib/request-service'
import { ServiceTypeBadge } from '@/components/ui/service-type-badge'
import { districtOf } from '@/lib/address'
import { cellDateTime, fullDateTime } from '@/lib/table-format'
import { SupplierOriginPicker } from '@/components/solicitudes/SupplierOriginPicker'
import { FormSection, PendingPanel, PendingStatus } from '@/components/ui/form-section'
import { partyName, referenceLabel, REFERENCE_TYPES, requiresSupplier, type ReferenceType, type Supplier } from '@/lib/suppliers'
import { serviceDate } from '@/lib/request-schedule'

const requestDate = (value: string, withTime = false) => value ? new Date(value).toLocaleString('es-PE', {
  timeZone: 'America/Lima', day: '2-digit', month: '2-digit', year: 'numeric',
  ...(withTime ? { hour: '2-digit', minute: '2-digit' } as const : {}),
}) : 'Sin fecha'

type AttentionMode = 'TRANSPORTE_JRM' | 'RECOJO_CLIENTE'
const requiresOt = (area: string) => /^(OT(?:\s*[-(]|$)|administraci[oó]n de contratos$)/i.test(area.trim())

interface TransportRequest {
  id: string
  request_number: string
  requester_name: string
  department: string
  attention_mode?: AttentionMode | null
  pickup_customer?: string | null
  pickup_contact?: string | null
  pickup_phone?: string | null
  site_id?: string | null
  pickup_address: string
  pickup_department?: string
  pickup_province?: string
  pickup_district?: string
  delivery_address: string
  delivery_department?: string
  delivery_province?: string
  delivery_district?: string
  required_date: string
  required_at?: string | null
  delivery_zone?: DeliveryZone | null
  lead_time_policy?: TransportLeadTimeSettings | null
  time_window: string
  cargo_description: string
  estimated_weight: number
  estimated_volume: number
  status: string
  request_type: string
  created_at: string
  contract_id?: string
  service_cost?: number
  purchase_order?: string
  supplier_id?: string | null
  supplier_location_id?: string | null
  reference_type?: string | null
  reference_number?: string | null
  suppliers?: { business_name: string } | null
  budget_shortfall?: number | null
  budget_observation?: string | null
  unloading_required?: boolean | null
  cost_source?: string | null
  cost_override_reason?: string | null
  reserved_pen?: number | null
  approved_at?: string | null
  transport_request_components?: Array<{
    id: string
    component_contract_id: string
    requested_weight_kg: number | null
    requested_volume_m3: number | null
  }>
  contracts?: {
    code: string
    clients?: {
      business_name: string
    }
  }
}

interface Contract {
  id: string
  code: string
  type: string
  status: string
  destination_address?: string
  destination_department?: string
  destination_province?: string
  destination_district?: string
  clients?: {
    business_name: string
  } | { business_name: string }[]
}

type UnloadingHistory = {
  id: string; request_number: string; status: string; created_at: string; required_date: string | null
  unloading_required: boolean | null; delivery: string; score: number
  lines: { concept: string; description: string | null; estimated_pen: number; planned_pen: number | null; actual_pen: number | null; status: string }[] | null
}
const UNLOADING_LABEL: Record<string, string> = { MONTACARGAS: 'Montacargas', GRUA: 'Grúa', ESTIBA: 'Estiba', OTROS: 'Otros' }
const MATCH_LABEL: Record<number, string> = { 3: 'mismo destino', 2: 'mismo cliente y distrito', 1: 'misma OT' }

interface ComponentOption {
  contract_id: string
  code: string
  component_type: 'CONTRATO' | 'OT_INDEPENDIENTE' | 'SUBCONTRATO' | 'ERROR'
  status: string
  total_weight_kg: number | null
  total_volume_m3: number | null
  destination_address: string | null
  already_requested_kg: number
  allocated_pen: number | null
  reserved_pen: number | null
  consumed_pen: number | null
  balance_pen: number | null
}

interface SelectedComponent {
  weight_kg: string
  volume_m3: string
}

interface RequestSummary {
  request_id: string
  dispatch_count: number
  dispatch_numbers: string[]
  root_allocated_pen: number | null
  root_balance_pen: number | null
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : (error as { message?: string })?.message || String(error)

export default function SolicitudesPage() {
  const { canWrite, role } = usePermissions()
  // F2: aprueba/rechaza el Supervisor de Despacho; reprograman él y el Administrador de Contratos
  const canApprove = canWrite('despacho-aprobacion')
  const canReschedule = canApprove || canWrite('despacho') || role === 'administrador de contratos'
  const supabase = useMemo(() => createClient(), [])
  
  const [requests, setRequests] = useState<TransportRequest[]>([])
  const [requestSummaries, setRequestSummaries] = useState<Record<string, RequestSummary>>({})
  const [contracts, setContracts] = useState<Contract[]>([])
  const [, setContractSearch] = useState('')
  const [otNodes, setOtNodes] = useState<OtNode[]>([])  // OT madre/independientes con sus subcontratos y errores
  const [componentOptions, setComponentOptions] = useState<ComponentOption[]>([])
  const [selectedComponents, setSelectedComponents] = useState<Record<string, SelectedComponent>>({})
  const [componentsLoading, setComponentsLoading] = useState(false)
  const [destinationAcknowledged, setDestinationAcknowledged] = useState(false)
  const componentLoadId = useRef(0)
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [filterStatus, setFilterStatus] = useState('TODOS')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')
  const [filterService, setFilterService] = useState('TODOS')

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [sort, setSort] = useState<{ key: 'created_at' | 'required_date' | 'service' | 'ot' | 'requester' | 'client' | 'address' | 'status'; direction: 'asc' | 'desc' }>({ key: 'created_at', direction: 'desc' })
  const statusLabels: Record<string, string> = {
    PENDIENTE: 'Pendiente', 'PENDIENTE DE APROBACIÓN': 'Pendiente', APROBADA: 'Aprobada', APROBADO: 'Aprobada',
    ASIGNADA: 'Asignada', REPROGRAMADA: 'Reprogramada', OBSERVADA: 'Observada', RECHAZADA: 'Rechazada',
    CANCELADA: 'Cancelada', EN_TRANSITO: 'En ruta', EN_DESTINO: 'En destino', ENTREGADA: 'Entregada', FINALIZADA: 'Finalizada',
  }
  const compactService = (request: TransportRequest) => { const kind = serviceKind(request); return kind ? SERVICE_KINDS[kind].short : 'Sin identificar' }
  const matchesStatus = (status: string, filter: string) => filter === 'TODOS' || status === filter
    || (filter === 'PENDIENTE' && status === 'PENDIENTE DE APROBACIÓN') || (filter === 'APROBADA' && status === 'APROBADO')
  const filteredRequests = requests.filter(r => {
    const matchesSearch = [r.request_number, r.requester_name, r.contracts?.code, r.contracts?.clients?.business_name, r.suppliers?.business_name, referenceLabel(r), r.cargo_description, r.pickup_address, r.delivery_address].join(' ').toLocaleLowerCase('es-PE').includes(searchTerm.trim().toLocaleLowerCase('es-PE'))
    const matchesDateFrom = filterDateFrom === '' || r.required_date >= filterDateFrom
    const matchesDateTo = filterDateTo === '' || r.required_date <= filterDateTo
    const matchesService = filterService === 'TODOS' || serviceKind(r) === filterService
    return matchesSearch && matchesStatus(r.status, filterStatus) && matchesDateFrom && matchesDateTo && matchesService
  }).sort((a, b) => {
    const value = (r: TransportRequest) => sort.key === 'service' ? compactService(r) : sort.key === 'ot' ? r.contracts?.code || '' : sort.key === 'client' ? partyName(r, r.contracts?.clients?.business_name, r.suppliers?.business_name) || '' : sort.key === 'requester' ? r.requester_name || ''
      : sort.key === 'address' ? serviceAddresses(r).map(place => place.address).join(' → ') : sort.key === 'status' ? statusLabels[r.status] || r.status : r[sort.key]
    const comparison = value(a).localeCompare(value(b), 'es-PE', { numeric: true, sensitivity: 'base' })
    return (sort.direction === 'asc' ? comparison : -comparison) || a.id.localeCompare(b.id)
  })
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filteredRequests.length / pageSize)))
  const visibleRequests = filteredRequests.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const changeSort = (key: typeof sort.key) => {
    setSort(previous => ({ key, direction: previous.key === key && previous.direction === 'asc' ? 'desc' : 'asc' }))
    setPage(1)
  }
  const clearFilters = () => { setSearchTerm(''); setFilterStatus('TODOS'); setFilterService('TODOS'); setFilterDateFrom(''); setFilterDateTo(''); setPage(1) }

  const [isModalOpen, setIsModalOpen] = useState(false)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const fetchSuppliers = useCallback(async () => {
    const { data } = await supabase.from('suppliers').select('id, tax_id, business_name, category, contact_name, contact_phone, contact_email, notes, is_active, supplier_locations(id, supplier_id, name, address, department, province, district, contact_name, contact_phone, is_active)')
      .eq('is_active', true).order('business_name')
    return (data || []) as Supplier[]
  }, [supabase])
  const loadSuppliers = useCallback(async () => { const list = await fetchSuppliers(); setSuppliers(list); return list }, [fetchSuppliers])
  useEffect(() => {
    if (isModalOpen && !suppliers.length) void fetchSuppliers().then(setSuppliers)
  }, [isModalOpen, suppliers.length, fetchSuppliers])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [userRole, setUserRole] = useState<string>('')
  const [userId, setUserId] = useState('')
  const [currentRequester, setCurrentRequester] = useState('')
  
  const [isRescheduleModalOpen, setIsRescheduleModalOpen] = useState(false)
  const [selectedRequestDetails, setSelectedRequestDetails] = useState<TransportRequest | null>(null)
  const [detailContracts, setDetailContracts] = useState<Record<string, { code: string; type: string }>>({})
  const [detailEvents, setDetailEvents] = useState<Array<{ id: string; action: string; created_at: string; previous_state: Record<string, unknown> | null; next_state: Record<string, unknown> }>>([])
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [detailExecution, setDetailExecution] = useState<RequestExecution | null>(null)
  const [executionError, setExecutionError] = useState('')
  const detailLoadId = useRef(0)
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null)
  const [newRescheduleDate, setNewRescheduleDate] = useState('')
  const [newRescheduleTime, setNewRescheduleTime] = useState('')
  const [rescheduleZone, setRescheduleZone] = useState<DeliveryZone>('LIMA')
  const [leadTimeSettings, setLeadTimeSettings] = useState<TransportLeadTimeSettings>(DEFAULT_LEAD_TIME_SETTINGS)
  const [leadTimeLoaded, setLeadTimeLoaded] = useState(false)
  const [leadTimeError, setLeadTimeError] = useState('')
  const [registrationPreview, setRegistrationPreview] = useState(() => new Date().toISOString())
  // Causa obligatoria al reprogramar (KPI de Despacho, migración 20261005180000)
  const [rescheduleCause, setRescheduleCause] = useState('')
  const [rescheduleDetail, setRescheduleDetail] = useState('')
  
  const [newRequest, setNewRequest] = useState({
    requester_name: '',
    department: '',
    attention_mode: 'TRANSPORTE_JRM' as AttentionMode,
    pickup_customer: '', pickup_contact: '', pickup_phone: '',
    request_type: 'DESPACHO',
    pickup_address: 'Planta Chilca',
    pickup_department: 'LIMA',
    pickup_province: 'CAÑETE',
    pickup_district: 'CHILCA',
    delivery_address: '',
    delivery_department: '',
    delivery_province: '',
    delivery_district: '',
    required_date: '',
    required_time: '',
    delivery_zone: 'LIMA' as DeliveryZone,
    time_window: '',
    contract_id: '',
    cargo_description: '',
    estimated_weight: '',
    estimated_volume: '',
    service_cost: '',
    purchase_order: '', supplier_id: '', supplier_location_id: '', reference_type: '', reference_number: ''
  })
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null)
  // Costos de descarga estimados (montacargas, grúa, estiba, otros): suman al costo que se valida con la partida
  const [unloading, setUnloading] = useState<{ concept: string; estimated_pen: string; description: string }[]>([])
  // Respuesta obligatoria: ¿la entrega requiere descarga especial? ('' = sin responder)
  const [unloadingAnswer, setUnloadingAnswer] = useState<'' | 'SI' | 'NO'>('')
  const [unloadingHistory, setUnloadingHistory] = useState<UnloadingHistory[]>([])
  // Costo referencial calculado con el tarifario (quote_transport); el usuario no lo edita
  const [quote, setQuote] = useState<Record<string, unknown> | null>(null)
  const [quoting, setQuoting] = useState(false)
  const selectedOptions = componentOptions.filter(option => selectedComponents[option.contract_id])
  const requestedWeight = selectedOptions.reduce((sum, option) =>
    sum + Number(selectedComponents[option.contract_id].weight_kg || 0), 0)
  const requestedVolume = selectedOptions.reduce((sum, option) =>
    sum + Number(selectedComponents[option.contract_id].volume_m3 || 0), 0)
  const mixedDestinations = new Set(selectedOptions.map(option =>
    option.destination_address?.trim().toLowerCase()).filter(Boolean)).size > 1
  const rootBudget = componentOptions.find(option => option.contract_id === newRequest.contract_id)
  const unloadingTotal = unloading.reduce((sum, u) => sum + (Number(u.estimated_pen) || 0), 0)
  const isCustomerPickup = newRequest.attention_mode === 'RECOJO_CLIENTE'
  const otRequired = requiresOt(newRequest.department) || userRole === 'administrador de contratos'
  const estimatedCost = (isCustomerPickup ? 0 : Number(newRequest.service_cost || 0)) + unloadingTotal


  const editingRequest = requests.find(request => request.id === editingRequestId)
  const reschedulingRequest = requests.find(request => request.id === selectedRequestId)
  const requiresDeliveryLeadTime = newRequest.request_type === 'DESPACHO' && !isCustomerPickup
  const requiredAt = limaDateTimeToIso(newRequest.required_date, newRequest.required_time)
  const previewRegisteredAt = editingRequest?.created_at || new Date(Math.ceil(new Date(registrationPreview).getTime() / 60000) * 60000).toISOString()
  const leadTimeEvaluation = evaluateLeadTime({ registeredAt: previewRegisteredAt, requiredAt: requiredAt || previewRegisteredAt, zone: newRequest.delivery_zone, settings: editingRequest?.lead_time_policy || leadTimeSettings })
  const rescheduleRequiredAt = limaDateTimeToIso(newRescheduleDate, newRescheduleTime)
  const rescheduleApplies = reschedulingRequest?.request_type === 'DESPACHO' && reschedulingRequest.attention_mode !== 'RECOJO_CLIENTE'
  const rescheduleEvaluation = evaluateLeadTime({ registeredAt: reschedulingRequest?.created_at || null, requiredAt: rescheduleRequiredAt || reschedulingRequest?.created_at, zone: rescheduleZone, settings: reschedulingRequest?.lead_time_policy || leadTimeSettings })
  const firstAllowed = (value: string | null) => value ? requestDate(new Date(Math.ceil(new Date(value).getTime() / 60000) * 60000).toISOString(), true) : 'Sin plazo'
  const requestLeadTime = (request: TransportRequest) => evaluateLeadTime({ registeredAt: request.created_at, requiredAt: request.required_at || null, zone: request.delivery_zone || null, settings: settingsForRequest(request.lead_time_policy, leadTimeSettings) })

  const fetchLeadTimeSettings = useCallback(async () => {
    const { data, error } = await supabase.rpc('get_transport_lead_time_settings')
    if (error || !data) { setLeadTimeError(error?.message || 'No se pudieron consultar los plazos.'); setLeadTimeLoaded(false); return }
    setLeadTimeSettings(data as TransportLeadTimeSettings); setLeadTimeLoaded(true); setLeadTimeError('')
  }, [supabase])

  useEffect(() => {
    if (!isModalOpen) return
    const timer = window.setInterval(() => setRegistrationPreview(new Date().toISOString()), 15000)
    return () => window.clearInterval(timer)
  }, [isModalOpen])

  const checkUser = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('first_name, last_name, roles(name)')
        .eq('id', user.id)
        .single()
      
      setUserId(user.id)
      if (profile) {
        setCurrentRequester(`${profile.first_name} ${profile.last_name}`)
        setNewRequest(prev => ({...prev, requester_name: `${profile.first_name} ${profile.last_name}`}))
        const roleName = Array.isArray(profile.roles) ? profile.roles[0]?.name : (profile.roles as { name?: string } | null)?.name
        if (roleName) {
          const normalized = normalizeRoleName(roleName)
          setUserRole(normalized)
          if (normalized === 'administrador de contratos') setNewRequest(prev => ({ ...prev, department: 'OT (Administración de Contratos)' }))
        }
      }
    }
  }, [supabase, setNewRequest])

  const fetchRequests = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('transport_requests')
        .select(`
          *,
          suppliers(business_name),
          transport_request_components(id, component_contract_id, requested_weight_kg, requested_volume_m3),
          contracts(
            code,
            clients(business_name)
          )
        `)
        .order('created_at', { ascending: false })

      if (error) throw error
      setRequests(data || [])
      if (data?.length) {
        try {
          const summaries: Record<string, RequestSummary> = {}
          for (let start = 0; start < data.length; start += 500) {
            const ids = data.slice(start, start + 500).map(request => request.id)
            const { data: summaryData, error: summaryError } = await supabase.rpc('get_transport_request_summaries', { p_request_ids: ids })
            if (summaryError) throw summaryError
            for (const summary of (summaryData || []) as RequestSummary[]) summaries[summary.request_id] = summary
          }
          setRequestSummaries(summaries)
        } catch (summaryError: unknown) {
          setRequestSummaries({})
          toast.warning('Solicitudes cargadas sin presupuesto o viajes: ' + errorMessage(summaryError))
        }
      } else setRequestSummaries({})
    } catch (error: unknown) {
      toast.error('Error al cargar solicitudes: ' + errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [supabase])

  const fetchContracts = useCallback(async () => {
    try {
      const base = `id, code, type, status, parent_contract_id,
          destination_address, destination_department, destination_province, destination_district,
          clients ( business_name )`
      let result: { data: unknown[] | null; error: { message: string } | null } = await supabase.from('contracts')
        .select(`${base}, contract_budgets ( concept, allocated_pen, balance_pen )`).eq('status', 'ACTIVO').order('code')
      // Sin acceso a partidas: se busca igual, sin mostrar saldo
      if (result.error) result = await supabase.from('contracts').select(base).eq('status', 'ACTIVO').order('code')
      const { data, error } = result
      if (error) throw error

      type Row = Contract & { parent_contract_id: string | null; contract_budgets?: { concept: string; allocated_pen: number | null; balance_pen: number | null }[] }
      const rows = (data || []) as unknown as Row[]
      setContracts(rows.filter(c => !c.parent_contract_id && ['CONTRATO', 'OT_INDEPENDIENTE'].includes(c.type)))
      setOtNodes(rows.filter(c => !c.parent_contract_id ? ['CONTRATO', 'OT_INDEPENDIENTE'].includes(c.type) : true).map(c => {
        const budget = (c.contract_budgets || []).find(b => b.concept === 'PARTIDA_TRANSPORTE')
        return {
          id: c.id, code: c.code, type: c.type, parent_contract_id: c.parent_contract_id,
          client_name: (Array.isArray(c.clients) ? c.clients[0]?.business_name : c.clients?.business_name) || null,
          destination_district: c.destination_district || null, destination_address: c.destination_address || null,
          allocated_pen: budget?.allocated_pen ?? null, balance_pen: budget?.balance_pen ?? null,
        }
      }))
    } catch (error: unknown) {
      toast.error('Error al cargar OTs: ' + errorMessage(error))
    }
  }, [supabase])

  useEffect(() => {
    const task = window.setTimeout(() => {
      void fetchRequests()
      void fetchContracts()
      void checkUser()
      void fetchLeadTimeSettings()
    }, 0)
    return () => window.clearTimeout(task)
  }, [fetchRequests, fetchContracts, checkUser, fetchLeadTimeSettings])

  // Memoria: solicitudes anteriores al mismo destino / cliente / OT y la descarga que necesitaron
  useEffect(() => {
    if (!isModalOpen || !newRequest.contract_id || !(newRequest.delivery_address || newRequest.delivery_district)) {
      const t = window.setTimeout(() => setUnloadingHistory([]), 0)
      return () => window.clearTimeout(t)
    }
    let cancel = false
    const t = window.setTimeout(async () => {
      const { data } = await supabase.rpc('get_unloading_history', {
        p_contract_id: newRequest.contract_id, p_delivery_district: newRequest.delivery_district || null,
        p_delivery_address: newRequest.delivery_address || null, p_exclude_request: editingRequestId,
      })
      if (!cancel) setUnloadingHistory((data || []) as UnloadingHistory[])
    }, 500)
    return () => { cancel = true; window.clearTimeout(t) }
  }, [supabase, isModalOpen, newRequest.contract_id, newRequest.delivery_address, newRequest.delivery_district, editingRequestId])

  // Cotización con el tarifario: OT + destino + peso + recursos de descarga
  const unloadingKey = unloadingAnswer === 'SI' ? unloading.map(u => u.concept).join(',') : ''
  useEffect(() => {
    if (!isModalOpen || !newRequest.delivery_district) {
      const t = window.setTimeout(() => setQuote(null), 0)
      return () => window.clearTimeout(t)
    }
    let cancel = false
    const t = window.setTimeout(async () => {
      setQuoting(true)
      const { data, error } = await supabase.rpc('quote_transport', {
        p_contract_id: newRequest.contract_id || null,
        p_stops: [{ district: newRequest.delivery_district, province: newRequest.delivery_province || null, department: newRequest.delivery_department || null }],
        p_weight_kg: requestedWeight > 0 ? requestedWeight : Number(newRequest.estimated_weight) || null, p_vehicle_class: null, p_plate: null,
        p_unloading: unloadingKey ? unloadingKey.split(',').map(concept => ({ concept, quantity: 1 })) : [],
      })
      if (cancel) return
      setQuoting(false)
      if (error) { setQuote(null); return }
      const q = data as Record<string, unknown>
      if (isCustomerPickup) {
        q.freight_total = 0
        q.total = Number(q.unloading_total || 0); q.client_total = null; q.vehicle_class = null
        q.missing = ((q.missing || []) as string[]).filter(m => !/flete|parada adicional/i.test(m))
        q.lines = ((q.lines || []) as { concept: string }[]).filter(l => !['FLETE','PARADA_ADICIONAL'].includes(l.concept))
      }
      setQuote(q)
      // El costo referencial sigue siempre al tarifario (flete + paradas; la descarga va en sus propias líneas)
      setNewRequest(prev => ({ ...prev, service_cost: String(Number(q.freight_total) || 0) }))
      const lines = (q.lines || []) as { concept: string; unit_rate: number }[]
      setUnloading(list => list.map(u => {
        const hit = lines.find(l => l.concept === u.concept)
        return { ...u, estimated_pen: hit ? String(hit.unit_rate) : '' }
      }))
    }, 500)
    return () => { cancel = true; window.clearTimeout(t) }
  }, [supabase, isModalOpen, newRequest.contract_id, newRequest.delivery_district, newRequest.delivery_province, newRequest.delivery_department, requestedWeight, newRequest.estimated_weight, isCustomerPickup, unloadingKey, setNewRequest])

  const quoteFreight = isCustomerPickup ? 0 : Number(quote?.freight_total || 0)

  const applyUnloadingReference = (h: UnloadingHistory) => {
    const lines = (h.lines || []).map(l => ({
      concept: l.concept, description: l.description || '',
      estimated_pen: '',  // el monto lo pone el tarifario
    }))
    setUnloadingAnswer(lines.length ? 'SI' : 'NO')
    setUnloading(lines)
    toast.success(`Se copiaron los recursos de descarga de ${h.request_number}; el costo lo calcula el tarifario.`)
  }

  const loadComponentOptions = async (contractId: string, requestId: string | null = null) => {
    const loadId = ++componentLoadId.current
    if (!contractId) { setComponentOptions([]); return null }
    setComponentsLoading(true)
    const { data, error } = await supabase.rpc('get_transport_request_component_options', {
      p_root_id: contractId, p_request_id: requestId
    })
    if (loadId !== componentLoadId.current) return null
    setComponentsLoading(false)
    if (error) { setComponentOptions([]); toast.error('No se pudieron cargar los componentes: ' + error.message); return null }
    const options = (data || []) as ComponentOption[]
    setComponentOptions(options)
    return options
  }

  const handleContractChange = (contractId: string) => {
    const selectedContract = contracts.find(c => c.id === contractId)
    if (newRequest.contract_id && newRequest.contract_id !== contractId && Object.keys(selectedComponents).length) {
      toast.info('Se limpiaron los componentes al cambiar de OT.')
    }
    setSelectedComponents({})
    setDestinationAcknowledged(false)
    setContractSearch(selectedContract?.code || '')
    void loadComponentOptions(contractId)
    setNewRequest(prev => {
      const updated = { ...prev, contract_id: contractId }
      
      // Si es despacho, heredamos la dirección del contrato al destino
      if (prev.request_type === 'DESPACHO' && selectedContract) {
        updated.delivery_address = selectedContract.destination_address || ''
        updated.delivery_department = selectedContract.destination_department || ''
        updated.delivery_province = selectedContract.destination_province || ''
        updated.delivery_district = selectedContract.destination_district || ''
      }
      
      return updated
    })
  }

  // Borrador de la solicitud nueva: se guarda en este equipo mientras se llena y se ofrece al volver a abrir.
  type RequestDraft = { saved_at: string; request: typeof newRequest; components: typeof selectedComponents; unloadingAnswer: typeof unloadingAnswer; unloading: typeof unloading }
  const draftKey = userId ? `jrm:solicitud-borrador:${userId}` : ''
  const [draftFound, setDraftFound] = useState<RequestDraft | null>(null)
  const readDraft = (): RequestDraft | null => {
    if (!draftKey) return null
    try { const raw = window.localStorage.getItem(draftKey); return raw ? JSON.parse(raw) as RequestDraft : null } catch { return null }
  }
  const clearDraft = () => { try { if (draftKey) window.localStorage.removeItem(draftKey) } catch { /* sin almacenamiento */ } setDraftFound(null) }
  const draftDirty = Boolean(newRequest.contract_id || newRequest.cargo_description.trim() || newRequest.supplier_id || newRequest.required_date
    || newRequest.reference_number.trim() || (newRequest.request_type !== 'RECOJO' && newRequest.delivery_address.trim()) || unloadingAnswer)
  useEffect(() => {
    if (!isModalOpen || editingRequestId || !draftKey || draftFound || !draftDirty) return
    const timer = window.setTimeout(() => {
      const draft: RequestDraft = { saved_at: new Date().toISOString(), request: newRequest, components: selectedComponents, unloadingAnswer, unloading }
      try { window.localStorage.setItem(draftKey, JSON.stringify(draft)) } catch { /* sin almacenamiento: el borrador es opcional */ }
    }, 800)
    return () => window.clearTimeout(timer)
  }, [isModalOpen, editingRequestId, draftKey, draftFound, draftDirty, newRequest, selectedComponents, unloadingAnswer, unloading])
  const resumeDraft = (draft: RequestDraft) => {
    setNewRequest(prev => ({ ...prev, ...draft.request, requester_name: prev.requester_name }))
    setUnloadingAnswer(draft.unloadingAnswer || ''); setUnloading(draft.unloading || [])
    setDraftFound(null)
    if (draft.request.contract_id) {
      void loadComponentOptions(draft.request.contract_id).then(() => setSelectedComponents(draft.components || {}))
    }
  }

  const openEditModal = async (request: TransportRequest, duplicate = false) => {
    const root = contracts.find(c => c.id === request.contract_id)
    if (request.contract_id && !root) { toast.error('La OT de esta solicitud no está disponible para edición.'); return }
    const options = root ? await loadComponentOptions(root.id, duplicate ? undefined : request.id) : []
    if (!options) return
    const unavailable = (request.transport_request_components || []).filter(item =>
      !options.some(option => option.contract_id === item.component_contract_id))
    if (unavailable.length) {
      toast.error('Esta solicitud contiene componentes inactivos o ya desvinculados de la OT; no se pueden editar sin revisión de datos.')
      return
    }
    setContractSearch(root?.code || '')
    setDestinationAcknowledged(false)
    setSelectedComponents(Object.fromEntries((request.transport_request_components || []).map(item => [
      item.component_contract_id,
      { weight_kg: item.requested_weight_kg?.toString() || '', volume_m3: item.requested_volume_m3?.toString() || '' }
    ])))
    setNewRequest({
      requester_name: duplicate ? currentRequester || newRequest.requester_name : request.requester_name,
      department: request.department.startsWith('OT -') ? 'OT (Administración de Contratos)' : request.department,
      attention_mode: request.attention_mode || 'TRANSPORTE_JRM',
      pickup_customer: request.pickup_customer || '', pickup_contact: request.pickup_contact || '', pickup_phone: request.pickup_phone || '',
      request_type: request.request_type,
      pickup_address: request.pickup_address,
      pickup_department: request.pickup_department || '',
      pickup_province: request.pickup_province || '',
      pickup_district: request.pickup_district || '',
      delivery_address: request.delivery_address,
      delivery_department: request.delivery_department || '',
      delivery_province: request.delivery_province || '',
      delivery_district: request.delivery_district || '',
      required_date: duplicate ? '' : request.required_at ? limaInputParts(request.required_at).date : request.required_date ? request.required_date.split('T')[0] : '',
      required_time: duplicate ? '' : request.required_at ? limaInputParts(request.required_at).time : '',
      delivery_zone: request.delivery_zone || 'LIMA',
      time_window: request.time_window || '',
      contract_id: request.contract_id || '',
      cargo_description: request.cargo_description || '',
      estimated_weight: request.estimated_weight ? request.estimated_weight.toString() : '',
      estimated_volume: request.estimated_volume ? request.estimated_volume.toString() : '',
      service_cost: request.service_cost?.toString() || '',
      purchase_order: duplicate ? '' : request.purchase_order || '', supplier_id: request.supplier_id || '', supplier_location_id: request.supplier_location_id || '',
      reference_type: request.reference_type || '', reference_number: duplicate ? '' : request.reference_number || ''
    })

    void fetchLeadTimeSettings()
    setEditingRequestId(duplicate ? null : request.id)
    setDraftFound(null)
    if (duplicate) {
      setRegistrationPreview(new Date().toISOString())
      toast.info(`Copia de ${request.request_number}: indique la fecha de atención y el número de documento.`)
    }
    const { data: unloadingRows } = await supabase.from('transport_unloading_costs')
      .select('concept, estimated_pen, description').eq('transport_request_id', request.id).eq('status', 'ESTIMADO')
    setUnloading((unloadingRows || []).map(u => ({ concept: u.concept, estimated_pen: String(u.estimated_pen), description: u.description || '' })))
    setUnloadingAnswer(request.unloading_required === true || (unloadingRows?.length || 0) > 0 ? 'SI' : request.unloading_required === false ? 'NO' : '')
    setIsModalOpen(true)
  }

  const openRequestDetails = async (request: TransportRequest) => {
    const loadId = ++detailLoadId.current
    setSelectedRequestDetails(request)
    setDetailsLoading(true)
    setDetailContracts({})
    setDetailEvents([])
    setDetailExecution(null)
    setExecutionError('')
    const ids = (request.transport_request_components || []).map(item => item.component_contract_id)
    const [contractsResult, eventsResult, executionResult] = await Promise.all([
      ids.length ? supabase.from('contracts').select('id, code, type').in('id', ids) : Promise.resolve({ data: [], error: null }),
      supabase.from('transport_request_events').select('id, action, created_at, previous_state, next_state').eq('request_id', request.id).order('created_at', { ascending: false }),
      supabase.rpc('get_transport_request_execution', { p_request_id: request.id }),
    ])
    if (loadId !== detailLoadId.current) return
    if (executionResult.error) setExecutionError(errorMessage(executionResult.error))
    else setDetailExecution(executionResult.data as RequestExecution)
    if (contractsResult.error || eventsResult.error) toast.error('No se pudo cargar todo el historial de la solicitud.')
    setDetailContracts(Object.fromEntries((contractsResult.data || []).map(c => [c.id, { code: c.code, type: c.type }])))
    setDetailEvents((eventsResult.data || []) as typeof detailEvents)
    setDetailsLoading(false)
  }

  const handleCreateRequest = async (e: React.FormEvent) => {
    e.preventDefault()
    if (requiresDeliveryLeadTime && !leadTimeLoaded) { toast.error('No se pudieron consultar los plazos. Reintenta antes de guardar.'); return }
    if (!requiredAt) { toast.error('Selecciona fecha y hora de atención válidas.'); return }
    if (requiresDeliveryLeadTime && leadTimeEvaluation.enough === false) {
      toast.error(`La entrega requiere ${leadTimeEvaluation.hours} horas de anticipación. Selecciona desde ${firstAllowed(leadTimeEvaluation.minimumAt)}.`); return
    }
    if (!newRequest.cargo_description || !newRequest.cargo_description.trim()) {
      toast.error('Debes ingresar la descripción general de la carga.')
      return
    }

    if ((otRequired && !newRequest.contract_id) || (newRequest.contract_id && !contracts.some(c => c.id === newRequest.contract_id))) {
      toast.error('Selecciona una OT madre activa.')
      return
    }
    const selected = componentOptions.filter(c => selectedComponents[c.contract_id])
    if (newRequest.contract_id && !selected.length) { toast.error('Selecciona al menos un componente.'); return }
    const destinations = new Set(selected.map(c => c.destination_address?.trim().toLowerCase()).filter(Boolean))
    if (destinations.size > 1 && !destinationAcknowledged) {
      toast.error('Confirma el destino principal o separa la solicitud.')
      return
    }
    if (!unloadingAnswer) { toast.error('Indica si la entrega requiere descarga especial (montacargas, grúa, estiba u otros).'); return }
    if (unloadingAnswer === 'SI' && unloading.length === 0) { toast.error('Agrega al menos un recurso de descarga o marca "No".'); return }
    const priorNeed = unloadingHistory.find(h => h.score >= 2 && (h.unloading_required || (h.lines || []).length > 0))
    if (unloadingAnswer === 'NO' && priorNeed && !window.confirm(
      `La solicitud ${priorNeed.request_number} (${MATCH_LABEL[priorNeed.score]}) necesitó ` +
      `${(priorNeed.lines || []).map(l => UNLOADING_LABEL[l.concept] || l.concept).join(', ') || 'descarga especial'}. ¿Confirmas que esta entrega NO requiere descarga?`)) {
      return
    }
    const rootBalance = rootBudget?.balance_pen
    if (!Number.isFinite(estimatedCost) || estimatedCost < 0 || unloading.some(u => !(Number(u.estimated_pen) >= 0))) {
      toast.error('Revise los costos estimados.')
      return
    }
    if (newRequest.contract_id && estimatedCost > 0 && estimatedCost > Number(rootBalance || 0) && !window.confirm(
      `El costo estimado (flete + descarga S/ ${estimatedCost.toLocaleString('es-PE')}) supera el saldo de la partida ` +
      `(S/ ${Number(rootBalance || 0).toLocaleString('es-PE')}). La solicitud quedará OBSERVADA y no se atenderá hasta ampliar la partida. ¿Registrar de todos modos?`)) {
      return
    }
    for (const component of selected) {
      const values = selectedComponents[component.contract_id]
      const weight = values.weight_kg === '' ? null : Number(values.weight_kg)
      const volume = values.volume_m3 === '' ? null : Number(values.volume_m3)
      if ((weight !== null && (!Number.isFinite(weight) || weight < 0)) ||
          (volume !== null && (!Number.isFinite(volume) || volume < 0))) {
        toast.error(`Peso o volumen inválido para ${component.code}.`)
        return
      }
      if (weight !== null && Number(component.total_weight_kg) > 0 &&
          weight + Number(component.already_requested_kg) > Number(component.total_weight_kg) + 0.01) {
        toast.error(`El peso de ${component.code} supera su saldo pendiente.`)
        return
      }
    }

    if (requiresSupplier({ request_type: newRequest.request_type, attention_mode: newRequest.attention_mode }) && !newRequest.supplier_id) {
      toast.error('Seleccione el proveedor del recojo o traslado. Si no existe, use «Nuevo proveedor» en la misma solicitud.')
      return
    }
    if (newRequest.reference_type && !newRequest.reference_number.trim()) {
      toast.error(`Ingrese el número de ${newRequest.reference_type}.`)
      return
    }
    setIsSubmitting(true)

    try {
      const { data: saved, error } = await supabase.rpc('save_transport_request_full', {
        p_request_id: editingRequestId,
        p_payload: { ...newRequest, purchase_order: newRequest.reference_type === 'OC' ? newRequest.reference_number : newRequest.reference_type ? '' : newRequest.purchase_order, required_at: requiredAt, delivery_zone: requiresDeliveryLeadTime ? newRequest.delivery_zone : null, contract_id: newRequest.contract_id || null, service_cost: isCustomerPickup ? 0 : newRequest.service_cost, destination_acknowledged: destinationAcknowledged },
        p_unloading: unloadingAnswer === 'SI' ? unloading.map(x => ({ concept: x.concept, estimated_pen: Number(x.estimated_pen) || 0, description: x.description || null })) : [],
        p_components: selected.map(c => ({
          contract_id: c.contract_id,
          weight_kg: selectedComponents[c.contract_id].weight_kg || null,
          volume_m3: selectedComponents[c.contract_id].volume_m3 || null
        }))
      })
      if (error) throw error
      if (saved?.status === 'OBSERVADA') toast.warning(newRequest.contract_id ? 'Solicitud observada: la partida no cubre los costos a cargo de JRM.' : 'Solicitud registrada y observada: vincule una OT para financiar los gastos JRM antes de aprobar y programar.')

      toast.success('Solicitud enviada correctamente')
      if (!editingRequestId) clearDraft()
      setUnloading([]); setUnloadingAnswer(''); setUnloadingHistory([])
      setQuote(null)
      setIsModalOpen(false)
      setNewRequest(prev => ({
        ...prev, 
        attention_mode: 'TRANSPORTE_JRM', pickup_customer: '', pickup_contact: '', pickup_phone: '',
        department: userRole === 'administrador de contratos' ? 'OT (Administración de Contratos)' : '',
        pickup_address: 'Planta Chilca',
        pickup_department: 'LIMA',
        pickup_province: 'CAÑETE',
        pickup_district: 'CHILCA',
        delivery_address: '',
        delivery_department: '',
        delivery_province: '',
        delivery_district: '',
        required_date: '',
        required_time: '',
        delivery_zone: 'LIMA' as DeliveryZone,
        time_window: '',
        contract_id: '',
        cargo_description: '',
        estimated_weight: '',
        estimated_volume: '',
        service_cost: '',
        purchase_order: '', supplier_id: '', supplier_location_id: '', reference_type: '', reference_number: ''
      }))
      setContractSearch('')
      setComponentOptions([])
      setSelectedComponents({})
      setDestinationAcknowledged(false)
      fetchRequests()
    } catch (error: unknown) {
      toast.error('Error al enviar solicitud: ' + errorMessage(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  const updateStatus = async (id: string, newStatus: string) => {
    try {
      const { error } = await supabase.rpc('set_transport_request_status', {
        p_request_id: id, p_new_status: newStatus, p_required_date: null
      })

      if (error) throw error

      if (newStatus === 'APROBADA') {
        // Sin saldo en la partida la aprobación deja la solicitud OBSERVADA (no se reserva)
        const { data: after } = await supabase.from('transport_requests').select('status, budget_observation').eq('id', id).maybeSingle()
        if (after?.status === 'OBSERVADA') {
          toast.warning(`No se aprobó: ${after.budget_observation || 'partida insuficiente'}.`)
          fetchRequests()
          return
        }
      }
      toast.success(`Solicitud ${newStatus.toLowerCase()}`)
      fetchRequests()
    } catch (error: unknown) {
      toast.error('Error al actualizar estado: ' + errorMessage(error))
    }
  }

  const handleCancelRequest = async (id: string) => {
    if (!confirm('¿Cancelar esta solicitud? Si está en un despacho que aún no sale, se retira del despacho (sin paradas el despacho se cancela y libera la partida).')) return;
    try {
      const { error } = await supabase.rpc('set_transport_request_status', {
        p_request_id: id, p_new_status: 'CANCELADA', p_required_date: null
      })
      if (error) throw error;
      
      toast.success('Solicitud cancelada exitosamente.');
      fetchRequests();
    } catch (err: unknown) {
      toast.error('Error al cancelar: ' + errorMessage(err));
    }
  }

  const handleRescheduleRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRequestId || !newRescheduleDate || !rescheduleRequiredAt) return;
    if (rescheduleApplies && !leadTimeLoaded) { toast.error('No se pudieron consultar los plazos.'); return }
    if (rescheduleApplies && rescheduleEvaluation.enough === false) { toast.error(`Selecciona desde ${firstAllowed(rescheduleEvaluation.minimumAt)}; la reprogramación conserva el registro original.`); return }
    
    try {
      setIsSubmitting(true);
      const { data, error } = await supabase.rpc('reprogramar_solicitud_at', {
        p_request_id: selectedRequestId, p_required_at: rescheduleRequiredAt, p_delivery_zone: rescheduleApplies ? rescheduleZone : null, p_causa: rescheduleCause, p_detalle: rescheduleDetail || null
      })
        
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || 'No se pudo reprogramar');
      
      toast.success('Solicitud reprogramada exitosamente.');
      setRescheduleCause(''); setRescheduleDetail('');
      setIsRescheduleModalOpen(false);
      fetchRequests();
    } catch (err: unknown) {
      toast.error('Error al reprogramar: ' + errorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  const getStatusBadge = (status: string) => {
    const tone: StatusTone = ['PENDIENTE', 'PENDIENTE DE APROBACIÓN'].includes(status) ? 'warning'
      : status === 'REPROGRAMADA' ? 'special'
      : ['APROBADA', 'APROBADO', 'ENTREGADA', 'FINALIZADA'].includes(status) ? 'success'
      : ['OBSERVADA', 'RECHAZADA'].includes(status) ? 'danger'
      : ['ASIGNADA', 'EN_TRANSITO', 'EN_DESTINO'].includes(status) ? 'info' : 'neutral'
    return <StatusBadge tone={tone} title={status.replaceAll('_', ' ')}>{statusLabels[status] || status.replaceAll('_', ' ')}</StatusBadge>
  }

  // Destinos frecuentes: del cliente de la OT elegida o, sin OT, de las solicitudes visibles.
  const clientName = (c?: { clients?: { business_name: string } | { business_name: string }[] | null } | null) => Array.isArray(c?.clients) ? c?.clients[0]?.business_name : c?.clients?.business_name
  const selectedClient = clientName(contracts.find(c => c.id === newRequest.contract_id))
  const frequentDestinations = useMemo(() => {
    const groups = new Map<string, { address: string; department: string; province: string; district: string; count: number; last: string }>()
    for (const r of requests) {
      if (r.request_type === 'RECOJO' || !r.delivery_address?.trim() || ['CANCELADA', 'RECHAZADA'].includes(r.status)) continue
      if (selectedClient && clientName(r.contracts) !== selectedClient) continue
      const key = `${r.delivery_address.trim().toLocaleLowerCase('es-PE')}|${(r.delivery_district || '').toLocaleLowerCase('es-PE')}`
      const g = groups.get(key)
      if (g) { g.count++; if (r.created_at > g.last) g.last = r.created_at }
      else groups.set(key, { address: r.delivery_address.trim(), department: r.delivery_department || '', province: r.delivery_province || '', district: (r.delivery_district || districtOf(r.delivery_address) || '').toUpperCase(), count: 1, last: r.created_at })
    }
    return [...groups.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last)).slice(0, 6)
  }, [requests, selectedClient])

  const needsSupplier = requiresSupplier({ request_type: newRequest.request_type, attention_mode: newRequest.attention_mode })
  const changeRequestType = (type: string) => {
    if (type === newRequest.request_type) return
    if (type === 'DESPACHO') {
      const selC = contracts.find(c => c.id === newRequest.contract_id)
      setNewRequest({ ...newRequest, request_type: type, pickup_address: 'Planta Chilca', pickup_department: 'LIMA', pickup_province: 'CAÑETE', pickup_district: 'CHILCA',
        delivery_address: selC?.destination_address || '', delivery_department: selC?.destination_department || '', delivery_province: selC?.destination_province || '', delivery_district: selC?.destination_district || '' })
    } else if (type === 'RECOJO') {
      setNewRequest({ ...newRequest, request_type: type, pickup_address: '', pickup_department: '', pickup_province: '', pickup_district: '', delivery_address: 'Planta Chilca', delivery_department: 'LIMA', delivery_province: 'CAÑETE', delivery_district: 'CHILCA' })
    } else {
      setNewRequest({ ...newRequest, request_type: type, pickup_address: '', pickup_department: '', pickup_province: '', pickup_district: '', delivery_address: '', delivery_department: '', delivery_province: '', delivery_district: '' })
    }
  }
  // Lo que falta para enviar, en el orden del formulario; cada ítem lleva a su sección.
  const pendingItems = ([
    !newRequest.requester_name.trim() && { label: 'Solicitante', target: 'req-servicio' },
    !newRequest.department && { label: 'Área / departamento', target: 'req-servicio' },
    otRequired && !newRequest.contract_id && { label: 'OT madre', target: 'req-ot' },
    Boolean(newRequest.contract_id) && !componentsLoading && selectedOptions.length === 0 && { label: 'Componentes de la OT', target: 'req-ot' },
    mixedDestinations && !destinationAcknowledged && { label: 'Confirmar destino principal', target: 'req-ot' },
    needsSupplier && !newRequest.supplier_id && { label: 'Proveedor de origen', target: 'req-proveedor' },
    (!newRequest.pickup_address.trim() || !newRequest.pickup_district.trim()) && { label: 'Origen: dirección y distrito', target: 'req-ruta' },
    (!newRequest.delivery_address.trim() || !newRequest.delivery_district.trim()) && { label: 'Destino: dirección y distrito', target: 'req-ruta' },
    !requiredAt && { label: 'Fecha y hora de atención', target: 'req-fecha' },
    Boolean(requiredAt) && requiresDeliveryLeadTime && leadTimeEvaluation.enough === false && { label: 'Anticipación mínima', target: 'req-fecha' },
    !newRequest.cargo_description.trim() && { label: 'Glosa de la carga', target: 'req-carga' },
    Boolean(newRequest.reference_type) && !newRequest.reference_number.trim() && { label: `Número de ${newRequest.reference_type}`, target: 'req-carga' },
    !unloadingAnswer && { label: 'Descarga especial (Sí/No)', target: 'req-descarga' },
  ].filter(Boolean) as { label: string; target: string }[])

  return (
    <div className="flex min-h-0 w-full flex-col gap-2.5 mx-auto lg:h-full">
      <PageHeader showTitle title="Solicitud de Transporte" description="Control de servicios programados" actions={<>
        {canWrite('solicitudes') && (
          <button 
            onClick={() => {
              if (contracts.length === 0) fetchContracts()
              setRegistrationPreview(new Date().toISOString())
              void fetchLeadTimeSettings()
              setEditingRequestId(null)
              setUnloading([]); setUnloadingAnswer(''); setUnloadingHistory([])
              setQuote(null)
              setContractSearch('')
              setComponentOptions([])
              setSelectedComponents({})
              setDestinationAcknowledged(false)
              componentLoadId.current++
              setNewRequest({
                requester_name: newRequest.requester_name,
                attention_mode: 'TRANSPORTE_JRM', pickup_customer: '', pickup_contact: '', pickup_phone: '',
        department: userRole === 'administrador de contratos' ? 'OT (Administración de Contratos)' : '',
                request_type: 'DESPACHO',
                pickup_address: 'Planta Chilca',
                pickup_department: 'LIMA',
                pickup_province: 'CAÑETE',
                pickup_district: 'CHILCA',
                delivery_address: '',
                delivery_department: '',
                delivery_province: '',
                delivery_district: '',
                required_date: '',
                required_time: '',
                delivery_zone: 'LIMA' as DeliveryZone,
                time_window: '',
                contract_id: '',
                cargo_description: '',
                estimated_weight: '',
                estimated_volume: '',
                service_cost: '',
                purchase_order: '', supplier_id: '', supplier_location_id: '', reference_type: '', reference_number: ''
              })
              setDraftFound(readDraft())
              setIsModalOpen(true)
            }}
            className="flex h-10 items-center justify-center gap-2 rounded-lg bg-jrm-navy px-5 font-semibold text-white shadow-sm transition-colors hover:bg-jrm-navy-dark"
          >
            <Plus aria-hidden className="h-4 w-4" />
            Nueva Solicitud
          </button>
        )}
        <TorreControlButton />
      </>} />
      <div className="flex flex-wrap items-center gap-2">
      <TransportWorkflow current="solicitud" torre={false} />
      <div className="ml-auto min-w-0"><InlineStatusBar label="Resumen por estado (filtra la tabla)" active={filterStatus} loading={loading} onChange={key => { setFilterStatus(key); setPage(1) }}
        items={([{ key: 'TODOS', label: 'Todas', icon: <Layers />, tone: 'navy' }, { key: 'PENDIENTE', label: 'Pendientes', icon: <Clock />, tone: 'amber' },
          { key: 'APROBADA', label: 'Aprobadas', icon: <CheckCircle2 />, tone: 'emerald' }, { key: 'ASIGNADA', label: 'Asignadas', icon: <Truck />, tone: 'blue' },
          { key: 'REPROGRAMADA', label: 'Reprogramadas', icon: <CalendarClock />, tone: 'violet' }] as const).map(tab => ({ ...tab, count: requests.filter(r => matchesStatus(r.status, tab.key)).length }))} /></div>
      </div>

      <FilterToolbar compact label="Búsqueda y filtros de solicitudes" onClear={clearFilters}>
        <label className="relative min-w-[15rem] flex-1 basis-60">
          <span className="sr-only">Buscar solicitudes</span><Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" aria-hidden="true" />
          <input type="search" placeholder="Buscar OT, solicitud o dirección…" value={searchTerm}
            onChange={event => { setSearchTerm(event.target.value); setPage(1) }}
            className={`${filterControl} pl-9`} />
        </label>
        <FilterField inline label="Desde" className="w-48"><input aria-label="Atención desde" type="date" value={filterDateFrom}
          onChange={event => { setFilterDateFrom(event.target.value); setPage(1) }} className={filterControl} /></FilterField>
        <FilterField inline label="Hasta" className="w-48"><input aria-label="Atención hasta" type="date" min={filterDateFrom || undefined} value={filterDateTo}
          onChange={event => { setFilterDateTo(event.target.value); setPage(1) }} className={filterControl} /></FilterField>
        <FilterField inline label="Tipo de servicio" className="w-64"><select aria-label="Filtrar por tipo de servicio" value={filterService} onChange={e => { setFilterService(e.target.value); setPage(1) }} className={filterControl}>
          <option value="TODOS">Todos</option>{(Object.keys(SERVICE_KINDS) as ServiceKind[]).map(kind => <option key={kind} value={kind}>{SERVICE_KINDS[kind].short}</option>)}
        </select></FilterField>
        <FilterField inline label="Estado" className="w-60"><select aria-label="Filtrar estado" value={filterStatus} onChange={e => { setFilterStatus(e.target.value); setPage(1) }} className={filterControl}>
          <option value="TODOS">Todos los estados</option>{Array.from(new Set(['PENDIENTE', 'APROBADA', 'ASIGNADA', 'REPROGRAMADA', 'OBSERVADA', 'RECHAZADA', 'CANCELADA', ...requests.map(r => r.status).filter(status => status !== 'PENDIENTE DE APROBACIÓN' && status !== 'APROBADO')])).map(status => <option key={status} value={status}>{statusLabels[status] || status.replaceAll('_', ' ')}</option>)}
          </select></FilterField>
      </FilterToolbar>

      <div className="flex min-h-0 flex-col overflow-hidden rounded-jrm border border-jrm-line bg-jrm-surface shadow-jrm-card lg:flex-1">
        <div role="region" aria-label="Tabla de solicitudes de transporte" tabIndex={0} className="min-h-0 overflow-auto lg:flex-1">
          <DataTable dense className="block w-full table-fixed text-left lg:min-w-[940px] lg:table"><caption className="sr-only">Solicitud de Transporte: fechas, tipo de servicio, OT, punto de atención, estado y acciones</caption>
            <thead className="sticky top-0 z-10 hidden bg-slate-50 text-xs text-slate-500 lg:table-header-group"><tr>
              {[{ title: 'Solicitada', key: 'created_at', width: 'w-[10%]' }, { title: 'Atención', key: 'required_date', width: 'w-[10%]' }, { title: 'Servicio', key: 'service', width: 'w-[11%]' }, { title: 'OT', key: 'ot', width: 'w-[7%]' }, { title: 'Solicitante', key: 'requester', width: 'w-[13%]' }, { title: 'Empresa', key: 'client', width: 'w-[14%] 2xl:w-[12%]' }, { title: 'Punto de atención', key: 'address', width: 'w-[13%] 2xl:w-[11%]' }, { title: 'Estado', key: 'status', width: 'w-[12%]' }, { title: 'Acciones', width: 'w-[10%] 2xl:w-[14%]' }].map(column => <th key={column.title} scope="col" className={column.width} aria-sort={column.key && sort.key === column.key ? sort.direction === 'asc' ? 'ascending' : 'descending' : undefined}>
                {column.key ? <button type="button" onClick={() => changeSort(column.key as typeof sort.key)} aria-label={`Ordenar por ${column.title.toLowerCase()}`} className="flex min-h-8 items-center gap-1.5 text-left hover:text-[#002855]">{column.title}{sort.key === column.key ? sort.direction === 'asc' ? <ArrowUp className="h-3 w-3 shrink-0" /> : <ArrowDown className="h-3 w-3 shrink-0" /> : <ArrowUpDown className="h-3 w-3 shrink-0 text-slate-400" />}</button> : column.title}
              </th>)}
            </tr></thead>
            <tbody className="block divide-y divide-slate-100 lg:table-row-group">
              {loading || !visibleRequests.length ? <tr className="block lg:table-row"><td colSpan={7} className="p-8 text-center text-sm text-slate-500">{loading ? <><Loader2 className="mx-auto mb-2 h-6 w-6 animate-spin" />Cargando solicitudes…</> : 'No hay solicitudes para estos filtros.'}</td></tr> : visibleRequests.map(req => {
                const cell = 'min-w-0 text-sm'
                const label = (value: string) => <p className="mb-1 text-xs font-medium text-slate-500 lg:hidden">{value}</p>
                const addresses = serviceAddresses(req)
                const editable = (canWrite('solicitudes') || canApprove || canReschedule) && ['PENDIENTE DE APROBACIÓN','PENDIENTE','REPROGRAMADA','APROBADA','OBSERVADA','ASIGNADA'].includes(req.status)
                const actions: TableAction[] = [
                  ...(['PENDIENTE DE APROBACIÓN','PENDIENTE','REPROGRAMADA'].includes(req.status) && canApprove ? [
                    { id: 'approve', label: 'Aprobar solicitud', icon: <Check className="h-4 w-4" />, onSelect: () => { void updateStatus(req.id, 'APROBADA') } },
                    { id: 'reject', label: 'Rechazar solicitud', icon: <X className="h-4 w-4" />, tone: 'danger' as const, onSelect: () => { void updateStatus(req.id, 'RECHAZADA') } },
                  ] : []),
                  ...(editable && canWrite('solicitudes') && req.status !== 'ASIGNADA' ? [{ id: 'edit', label: 'Editar solicitud', icon: <Edit2 className="h-4 w-4" />, onSelect: () => { void openEditModal(req) } }] : []),
                  ...(canWrite('solicitudes') ? [{ id: 'duplicate', label: 'Duplicar como nueva', icon: <Copy className="h-4 w-4" />, onSelect: () => { if (contracts.length === 0) fetchContracts(); void openEditModal(req, true) } }] : []),
                  ...(editable && canReschedule ? [{ id: 'reschedule', label: 'Reprogramar', icon: <CalendarClock className="h-4 w-4" />, onSelect: () => { setSelectedRequestId(req.id); setNewRescheduleDate(req.required_at ? limaInputParts(req.required_at).date : req.required_date.split('T')[0] || ''); setNewRescheduleTime(req.required_at ? limaInputParts(req.required_at).time : ''); setRescheduleZone(req.delivery_zone || 'LIMA'); void fetchLeadTimeSettings(); setIsRescheduleModalOpen(true) } }] : []),
                  ...(editable ? [{ id: 'cancel', label: 'Cancelar servicio', icon: <Ban className="h-4 w-4" />, tone: 'danger' as const, onSelect: () => { void handleCancelRequest(req.id) } }] : []),
                ]
                return <tr key={req.id} className="grid grid-cols-2 hover:bg-slate-50/70 lg:table-row">
                  <td className={cell}>{label('Solicitada')}<span className="whitespace-nowrap text-slate-700" title={fullDateTime(req.created_at)}>{cellDateTime(req.created_at)}</span></td>
                  <td className={cell}>{label('Atención')}{(() => {
                    const lead = req.request_type === 'DESPACHO' && req.attention_mode !== 'RECOJO_CLIENTE' ? requestLeadTime(req) : null
                    const note = [req.status === 'REPROGRAMADA' ? 'Reprogramada' : '', !req.required_at ? 'Sin hora registrada' : lead && leadTimeLoaded ? formatLeadTimeStatus(lead.status) : ''].filter(Boolean).join(' · ')
                    return <span title={note || undefined} className={`whitespace-nowrap ${lead?.enough === false ? 'font-semibold text-red-700' : req.status === 'REPROGRAMADA' ? 'font-semibold text-amber-700' : 'text-slate-700'}`}>{req.required_at ? cellDateTime(req.required_at) : serviceDate(req.required_date)}</span>
                  })()}</td>
                  <td className={cell}>{label('Servicio')}<ServiceTypeBadge request={req} /></td>
                  <td className={cell}>{label('OT')}<span className="whitespace-nowrap font-semibold text-[#002855]" title={[`Solicitud ${req.request_number}`, req.contracts?.code && referenceLabel(req)].filter(Boolean).join(' · ')}>{req.contracts?.code || (req.contract_id ? 'OT vinculada' : referenceLabel(req) || 'Sin OT')}</span></td>
                  <td className={cell}>{label('Solicitante')}<p className="truncate text-slate-700" title={[req.requester_name, req.department].filter(Boolean).join(' · ') || undefined}>{req.requester_name || 'Sin solicitante'}</p></td>
                  <td className={cell}>{label('Empresa')}{(() => { const party = partyName(req, req.contracts?.clients?.business_name, req.suppliers?.business_name); return <p className="truncate text-slate-700" title={party ? `${requiresSupplier(req) ? 'Proveedor' : 'Cliente'}: ${party}` : undefined}>{party || (requiresSupplier(req) ? 'Proveedor sin vincular' : 'Sin cliente')}</p> })()}</td>
                  <td className={`${cell} col-span-2`}>{label('Punto de atención')}<div title={addresses.map(place => `${place.label}: ${place.address}`).join(' → ')} className="text-slate-700">
                    <p className="truncate leading-5">{addresses.map((place, index) => <span key={place.label}>{index > 0 && <span className="text-slate-400"> → </span>}{districtOf(place.address, place.label === 'Entrega' ? req.delivery_district : req.pickup_district)}</span>)}</p>
                  </div></td>
                  <td className={cell}>{label('Estado')}{getStatusBadge(req.status)}</td>
                  <td className={cell}>{label('Acciones')}<div className="flex flex-wrap items-center gap-1.5 lg:flex-nowrap">
                    <button type="button" onClick={() => void openRequestDetails(req)} title="Ver detalle" aria-label={`Ver detalle de ${req.request_number}`} className="inline-flex min-h-11 items-center justify-center gap-1 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-jrm-navy hover:border-slate-300 hover:bg-slate-50 lg:min-h-0 lg:h-8"><Eye aria-hidden className="h-3.5 w-3.5" /><span className="lg:hidden 2xl:inline">Ver detalle</span></button>
                    <TableActions compact label={`Más acciones de ${req.request_number}`} actions={actions} />
                  </div></td>
                </tr>
              })}
            </tbody>
          </DataTable>
        </div>
        <TablePagination total={loading ? 0 : filteredRequests.length} page={currentPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1) }} itemLabel="resultados" pageSizeOptions={[10, 20, 50, 100]} compact />
      </div>

      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingRequestId ? 'Editar solicitud de transporte' : 'Nueva solicitud de transporte'}
        maxWidth="max-w-7xl"
        footer={<div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <PendingStatus count={pendingItems.length} readyText="Lista para enviar" />
            {!editingRequestId && <span className="text-xs text-slate-500">Se guarda como borrador en este equipo mientras la llena.</span>}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setIsModalOpen(false)} className="rounded-lg px-4 py-2 font-medium text-slate-600 transition-colors hover:bg-slate-100">Cancelar</button>
            <button type="submit" form="request-form"
              disabled={isSubmitting || (requiresDeliveryLeadTime && !leadTimeLoaded) || !requiredAt || (requiresDeliveryLeadTime && leadTimeEvaluation.enough === false) || componentsLoading || (otRequired && !newRequest.contract_id) || (Boolean(newRequest.contract_id) && selectedOptions.length === 0)}
              className="flex items-center gap-2 rounded-lg bg-[#002855] px-4 py-2 font-medium text-white transition-colors hover:bg-[#001d3d] disabled:opacity-50">
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {editingRequestId ? 'Actualizar solicitud' : 'Enviar solicitud'}
            </button>
          </div>
        </div>}
      >
        <form id="request-form" onSubmit={handleCreateRequest} className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0 space-y-4">
            {draftFound && !editingRequestId && <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
              <FilePen aria-hidden className="h-5 w-5 shrink-0" />
              <span className="min-w-0 flex-1">Tiene un borrador sin enviar del {fullDateTime(draftFound.saved_at)}{draftFound.request.cargo_description ? ` · «${draftFound.request.cargo_description.slice(0, 60)}»` : ''}.</span>
              <button type="button" onClick={() => resumeDraft(draftFound)} className="rounded-lg bg-[#002855] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#001d3d]">Retomar borrador</button>
              <button type="button" onClick={clearDraft} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-blue-900 hover:bg-blue-100">Descartar</button>
            </div>}
            <FormSection id="req-servicio" step={1} title="Servicio" hint="Tipo de servicio, modalidad y solicitante">
              <div role="radiogroup" aria-label="Tipo de solicitud" className="grid gap-2 sm:grid-cols-3">
                {REQUEST_TYPE_OPTIONS.map(option => {
                  const active = newRequest.request_type === option.value
                  return <button key={option.value} type="button" role="radio" aria-checked={active} onClick={() => changeRequestType(option.value)}
                    className={`rounded-lg border p-3 text-left transition-colors ${active ? 'border-[#002855] bg-blue-50 ring-1 ring-[#002855]' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'}`}>
                    <ServiceTypeBadge kind={option.value === 'DESPACHO' ? (newRequest.contract_id ? 'ENTREGA_OT' : 'ENTREGA') : option.kind} />
                    <span className="mt-1.5 block text-sm font-semibold text-slate-900">{option.title}</span>
                    <span className="block text-xs text-slate-500">{option.hint}</span>
                  </button>
                })}
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <label className="block text-sm font-medium text-slate-700">Solicitante *
                  <input type="text" required disabled={userRole !== 'admin'} placeholder="Nombre completo" className={field}
                    value={newRequest.requester_name} onChange={e => setNewRequest({ ...newRequest, requester_name: e.target.value })} /></label>
                <label className="block text-sm font-medium text-slate-700">Área / departamento *
                  <select required className={field} value={newRequest.department} onChange={e => setNewRequest({ ...newRequest, department: e.target.value })}>
                    <option value="" disabled>Seleccionar área…</option>
                    {REQUEST_AREAS.map(area => <option key={area} value={area}>{area}</option>)}
                  </select></label>
                <label className="block text-sm font-medium text-slate-700">Modalidad de atención *
                  <select value={newRequest.attention_mode} onChange={e => { setNewRequest(prev => ({ ...prev, attention_mode: e.target.value as AttentionMode, service_cost: '' })); setQuote(null) }} className={field}>
                    <option value="TRANSPORTE_JRM">Transporte gestionado por JRM</option><option value="RECOJO_CLIENTE">Recojo por el cliente</option>
                  </select></label>
              </div>
              <p className="mt-1.5 text-xs text-slate-500">El armado de ruta heredará esta modalidad. {isCustomerPickup ? 'Flete JRM: S/ 0.00. Se emite Nota de Salida; otros recursos conservan sus costos.' : 'El supervisor asignará unidad propia o proveedor.'}</p>
            {isCustomerPickup && <div className="mt-3 grid grid-cols-1 gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3 md:grid-cols-3">
              {([['pickup_customer','Cliente que recoge'],['pickup_contact','Contacto autorizado'],['pickup_phone','Teléfono del contacto']] as const).map(([key,label]) => <label key={key} className="text-sm text-slate-700">{label} (opcional)<input value={newRequest[key]} type={key === 'pickup_phone' ? 'tel' : 'text'} onChange={e => setNewRequest(prev => ({ ...prev, [key]: e.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2" /></label>)}
            </div>}
            </FormSection>

            <FormSection id="req-ot" step={2} title="OT / proyecto" hint={otRequired ? 'Obligatoria para el área seleccionada' : 'Opcional: vincula la carga a una OT y sus componentes'}>
              <OtPicker
                nodes={otNodes}
                value={newRequest.contract_id}
                onSelect={(rootId, childId) => {
                  if (rootId !== newRequest.contract_id) handleContractChange(rootId)
                  if (childId) {
                    setSelectedComponents(prev => ({ ...prev, [childId]: prev[childId] || { weight_kg: '', volume_m3: '' } }))
                    toast.info('Se marcó el componente seleccionado; indica su peso.')
                  }
                }}
                onClear={() => {
                  if (Object.keys(selectedComponents).length) toast.info('Se limpiaron los componentes al quitar la OT.')
                  setContractSearch('')
                  setNewRequest(prev => ({ ...prev, contract_id: '' }))
                  setSelectedComponents({})
                  setComponentOptions([])
                  setDestinationAcknowledged(false)
                  componentLoadId.current++
                }}
              />
              {newRequest.contract_id && componentOptions.length > 0 && (() => {
                const root = componentOptions.find(c => c.contract_id === newRequest.contract_id)
                return root && <p className="mt-1 text-xs text-slate-600">
                  Partida bruta OT raíz: S/ {Number(root.allocated_pen || 0).toLocaleString('es-PE')} ·
                  Operación 80%: S/ {operatingBudget(Number(root.allocated_pen || 0)).toLocaleString('es-PE')} · Saldo operativo: S/ {Number(root.balance_pen || 0).toLocaleString('es-PE')}
                  <span className="block text-amber-700">Presupuestos de hijos pendientes de clasificación; no se suman.</span>
                </p>
              })()}
              {newRequest.contract_id && <div className="mt-3">
            <div className="rounded-lg border border-slate-200 p-4 space-y-3">
              <div>
                <h3 className="font-semibold text-slate-800">Componentes incluidos en la solicitud</h3>
                <p className="text-xs text-slate-500">Indica únicamente la carga de este requerimiento. El peso contractual de la OT madre puede incluir a sus hijos.</p>
              </div>
              {componentsLoading ? <p className="text-sm text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Cargando componentes...</p> :
                componentOptions.map(option => {
                  const checked = Boolean(selectedComponents[option.contract_id])
                  const pending = Math.max(0, Number(option.total_weight_kg || 0) - Number(option.already_requested_kg || 0))
                  return <div key={option.contract_id} className={`rounded-md border p-3 ${checked ? 'border-blue-300 bg-blue-50/40' : 'border-slate-200'}`}>
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input type="checkbox" className="mt-1" checked={checked} onChange={e => {
                        setSelectedComponents(prev => {
                          const next = { ...prev }
                          if (e.target.checked) next[option.contract_id] = { weight_kg: '', volume_m3: '' }
                          else delete next[option.contract_id]
                          return next
                        })
                        setDestinationAcknowledged(false)
                      }} />
                      <span className="flex-1 text-sm">
                        <strong>{option.code}</strong> · {option.component_type === 'SUBCONTRATO' ? 'Subcontrato' : option.component_type === 'ERROR' ? 'Error' : 'OT Madre'} · {option.status === 'ACTIVO' ? 'Activo' : option.status}
                        <span className="block text-xs text-slate-500">
                          Peso contractual: {Number(option.total_weight_kg || 0).toLocaleString('es-PE')} kg ·
                          {Number(option.total_weight_kg || 0) > 0 ? ` pendiente estimado: ${pending.toLocaleString('es-PE')} kg` : ' peso pendiente no verificable'}
                          {option.destination_address ? ` · Destino: ${option.destination_address}` : ''}
                        </span>
                        {Number(option.allocated_pen || 0) > 0 && <span className="block text-xs text-amber-700">Partida propia: S/ {Number(option.allocated_pen).toLocaleString('es-PE')} · Saldo: S/ {Number(option.balance_pen || 0).toLocaleString('es-PE')} (naturaleza sin clasificar)</span>}
                      </span>
                    </label>
                    {checked && <div className="grid grid-cols-2 gap-3 mt-3 ml-7">
                      <label className="text-xs text-slate-600">Peso a transportar (kg)
                        <input type="number" min="0" step="0.01" className="block w-full mt-1 p-2 border rounded bg-white text-slate-900"
                          value={selectedComponents[option.contract_id].weight_kg}
                          onChange={e => setSelectedComponents(prev => ({ ...prev, [option.contract_id]: { ...prev[option.contract_id], weight_kg: e.target.value } }))} />
                      </label>
                      <label className="text-xs text-slate-600">Volumen a transportar (m³)
                        <input type="number" min="0" step="0.01" className="block w-full mt-1 p-2 border rounded bg-white text-slate-900"
                          value={selectedComponents[option.contract_id].volume_m3}
                          onChange={e => setSelectedComponents(prev => ({ ...prev, [option.contract_id]: { ...prev[option.contract_id], volume_m3: e.target.value } }))} />
                      </label>
                    </div>}
                  </div>
                })}
              {mixedDestinations && <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900">
                Los componentes seleccionados tienen destinos diferentes. Separa la solicitud o confirma que todos se entregarán en el destino principal indicado abajo.
                <label className="flex items-center gap-2 mt-2 font-medium"><input type="checkbox" checked={destinationAcknowledged} onChange={e => setDestinationAcknowledged(e.target.checked)} />Confirmo el destino principal</label>
              </div>}
              <div className="bg-slate-50 rounded p-3 text-sm text-slate-700">
                <strong>Resumen:</strong> {selectedOptions.length} componentes · {requestedWeight.toLocaleString('es-PE')} kg solicitados · {requestedVolume.toLocaleString('es-PE')} m³
                {rootBudget && <span className="block mt-1">Saldo OT raíz: S/ {Number(rootBudget.balance_pen || 0).toLocaleString('es-PE')} · Costo estimado: S/ {estimatedCost.toLocaleString('es-PE')} · Saldo proyectado: S/ {(Number(rootBudget.balance_pen || 0) - estimatedCost).toLocaleString('es-PE')}</span>}
              </div>
            </div>
              </div>}
            </FormSection>

            {needsSupplier && <FormSection id="req-proveedor" step={3} title="Proveedor de origen" hint="¿No existe? Regístrelo aquí mismo con «Nuevo proveedor» o «Nuevo punto».">
              <SupplierOriginPicker suppliers={suppliers} reload={loadSuppliers}
                value={{ supplier_id: newRequest.supplier_id, supplier_location_id: newRequest.supplier_location_id, pickup_address: newRequest.pickup_address, pickup_department: newRequest.pickup_department, pickup_province: newRequest.pickup_province, pickup_district: newRequest.pickup_district, pickup_contact: newRequest.pickup_contact, pickup_phone: newRequest.pickup_phone }}
                onChange={patch => setNewRequest(prev => ({ ...prev, ...patch }))} />
            </FormSection>}

            <FormSection id="req-ruta" step={needsSupplier ? 4 : 3} title="Origen y destino" hint={newRequest.request_type === 'DESPACHO' ? 'Sale de planta; el destino se completa con la OT' : newRequest.request_type === 'RECOJO' ? 'Retorna a Planta Chilca' : 'Traslado entre dos puntos'}>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
                  <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Origen</p>
                  <label className="block text-xs font-medium text-slate-700">Dirección exacta *
                    <input type="text" required className={fieldSm} value={newRequest.pickup_address} onChange={e => setNewRequest({ ...newRequest, pickup_address: e.target.value })} /></label>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <label className="block text-xs font-medium text-slate-700">Departamento<input type="text" placeholder="Ej. LIMA" className={fieldSm} value={newRequest.pickup_department} onChange={e => setNewRequest({ ...newRequest, pickup_department: e.target.value.toUpperCase() })} /></label>
                    <label className="block text-xs font-medium text-slate-700">Provincia<input type="text" placeholder="Ej. CAÑETE" className={fieldSm} value={newRequest.pickup_province} onChange={e => setNewRequest({ ...newRequest, pickup_province: e.target.value.toUpperCase() })} /></label>
                    <label className="block text-xs font-medium text-slate-700">Distrito *<input type="text" required placeholder="Ej. CHILCA" className={fieldSm} value={newRequest.pickup_district} onChange={e => setNewRequest({ ...newRequest, pickup_district: e.target.value.toUpperCase() })} /></label>
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
                  <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Destino</p>
                  <label className="block text-xs font-medium text-slate-700">Dirección exacta *
                    <input type="text" list="historical-delivery-addresses" required className={fieldSm} value={newRequest.delivery_address} onChange={e => setNewRequest({ ...newRequest, delivery_address: e.target.value })} /></label>
                  <datalist id="historical-delivery-addresses">{Array.from(new Set(contracts.map(c => c.destination_address).filter(Boolean))).map((addr, idx) => <option key={idx} value={addr} />)}</datalist>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <label className="block text-xs font-medium text-slate-700">Departamento<input type="text" placeholder="Ej. LIMA" className={fieldSm} value={newRequest.delivery_department} onChange={e => setNewRequest({ ...newRequest, delivery_department: e.target.value.toUpperCase() })} /></label>
                    <label className="block text-xs font-medium text-slate-700">Provincia<input type="text" placeholder="Ej. LIMA" className={fieldSm} value={newRequest.delivery_province} onChange={e => setNewRequest({ ...newRequest, delivery_province: e.target.value.toUpperCase() })} /></label>
                    <label className="block text-xs font-medium text-slate-700">Distrito *<input type="text" required placeholder="Ej. ATE" className={fieldSm} value={newRequest.delivery_district} onChange={e => setNewRequest({ ...newRequest, delivery_district: e.target.value.toUpperCase() })} /></label>
                  </div>
                </div>
              </div>
              {newRequest.request_type !== 'RECOJO' && frequentDestinations.length > 0 && <div className="mt-3">
                <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-600"><History aria-hidden className="h-3.5 w-3.5" />Destinos frecuentes {selectedClient ? `de ${selectedClient}` : 'de sus solicitudes'}</p>
                <div className="flex flex-wrap gap-1.5">{frequentDestinations.map(d => {
                  const active = newRequest.delivery_address.trim().toLocaleLowerCase('es-PE') === d.address.toLocaleLowerCase('es-PE')
                  return <button key={`${d.address}|${d.district}`} type="button" title={`${d.address} · usado ${d.count} ${d.count === 1 ? 'vez' : 'veces'}`}
                    onClick={() => setNewRequest(prev => ({ ...prev, delivery_address: d.address, delivery_department: d.department, delivery_province: d.province, delivery_district: d.district }))}
                    className={`max-w-xs truncate rounded-full border px-2.5 py-1 text-xs transition-colors ${active ? 'border-[#002855] bg-blue-50 font-semibold text-[#002855]' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50'}`}>
                    <b>{d.district || 'Sin distrito'}</b> · {d.address}</button>
                })}</div>
              </div>}
              {!newRequest.contract_id && <div className="mt-3 grid grid-cols-2 gap-3">{([['estimated_weight', 'Peso estimado (kg)'], ['estimated_volume', 'Volumen estimado (m³)']] as const).map(([key, label]) => <label key={key} className="block text-sm font-medium text-slate-700">{label}<input type="number" min="0" step="0.01" value={newRequest[key]} onChange={e => setNewRequest(prev => ({ ...prev, [key]: e.target.value }))} className={field} /></label>)}</div>}
            </FormSection>

            <FormSection id="req-fecha" step={needsSupplier ? 5 : 4} title="Fecha de atención" hint="Hora de Lima">
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block text-sm font-medium text-slate-700">Fecha *
                  <input type="date" required className={field} value={newRequest.required_date} onChange={e => setNewRequest({ ...newRequest, required_date: e.target.value })} /></label>
                <label className="block text-sm font-medium text-slate-700" htmlFor="request-required-time">Hora *
                  <input id="request-required-time" type="time" required value={newRequest.required_time} onChange={event => setNewRequest({ ...newRequest, required_time: event.target.value })} className={field} /></label>
                <label className="block text-sm font-medium text-slate-700">Ventana horaria (opcional)
                  <input type="text" placeholder="Ej. 08:00 AM - 12:00 PM" className={field} value={newRequest.time_window} onChange={e => setNewRequest({ ...newRequest, time_window: e.target.value })} /></label>
            {requiresDeliveryLeadTime && <div className="space-y-3 sm:col-span-3">
              <label className="block text-sm font-medium text-slate-700">Zona de entrega
                <select value={newRequest.delivery_zone} onChange={event => setNewRequest({ ...newRequest, delivery_zone: event.target.value as DeliveryZone })} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900"><option value="LIMA">Lima y Callao</option><option value="PROVINCIA">Provincia</option><option value="EXTERIOR">Exterior</option></select>
              </label>
              <div role="status" className={`rounded-lg p-3 text-sm ${requiredAt && leadTimeEvaluation.enough === false ? 'bg-red-50 text-red-800' : 'bg-blue-50 text-blue-900'}`}>
                {!leadTimeLoaded ? <span>{leadTimeError || 'Consultando plazos…'} <button type="button" onClick={() => void fetchLeadTimeSettings()} className="underline">Reintentar</button></span> : leadTimeEvaluation.minimumAt ? <><strong>{leadTimeEvaluation.hours} horas mínimas de anticipación.</strong> Primera atención permitida: {firstAllowed(leadTimeEvaluation.minimumAt)}.{requiredAt && leadTimeEvaluation.enough === false && <p className="mt-1">La fecha y hora seleccionadas son anteriores al mínimo. Corrígelas para guardar.</p>}<p className="mt-1 text-xs">{editingRequest ? `Se conserva el registro original: ${requestDate(editingRequest.created_at, true)}.` : 'El plazo definitivo comienza al guardar. El primer horario sugerido se redondea al siguiente minuto.'}</p></> : 'El control está desactivado para esta zona.'}
              </div>
            </div>}
              </div>
            </FormSection>

            <FormSection id="req-carga" step={needsSupplier ? 6 : 5} title="Carga y documento" hint="Glosa, documento de referencia y costo referencial">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="block text-sm font-medium text-slate-700 md:col-span-2">Descripción general / glosa *
                  <textarea required rows={3} placeholder="Ej. 20 bobinas de acero para el proyecto Sur..." className={`${field} resize-none`}
                    value={newRequest.cargo_description} onChange={e => setNewRequest({ ...newRequest, cargo_description: e.target.value })} /></label>
                <div>
                  <span className="mb-1 block text-sm font-medium text-slate-700">Documento de referencia (opcional)</span>
                  <div className="flex gap-2">
                    <select aria-label="Tipo de documento" value={newRequest.reference_type} onChange={e => setNewRequest({ ...newRequest, reference_type: e.target.value, reference_number: e.target.value ? newRequest.reference_number : '' })}
                      className="w-36 rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 outline-none focus:ring-2 focus:ring-[#002855]">
                      <option value="">Sin documento</option>
                      {(Object.keys(REFERENCE_TYPES) as ReferenceType[]).map(k => <option key={k} value={k}>{k} · {REFERENCE_TYPES[k]}</option>)}
                    </select>
                    <input type="text" aria-label="Número de documento" disabled={!newRequest.reference_type} placeholder={newRequest.reference_type ? `Número de ${newRequest.reference_type}` : newRequest.purchase_order ? `Registrado antes: ${newRequest.purchase_order}` : 'Elija el tipo'}
                      className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 outline-none focus:ring-2 focus:ring-[#002855] disabled:bg-slate-100"
                      value={newRequest.reference_number} onChange={e => setNewRequest({ ...newRequest, reference_number: e.target.value })} />
                  </div>
                </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Costo referencial del flete {quoting && <Loader2 className="ml-1 inline h-3 w-3 animate-spin" />}
                </label>
                <div className="w-full px-3 py-2 bg-slate-50 text-slate-900 border border-slate-200 rounded-lg font-semibold tabular-nums">
                  S/ {quoteFreight.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  {isCustomerPickup ? 'El cliente gestiona el transporte: no se cotiza ni reserva flete JRM.' : 'Costo referencial según tarifario. Los gastos JRM se imputan a la partida de una OT antes de aprobar y programar; el armado de ruta valida el importe.'}
                </p>
                {quote ? <QuoteBreakdown quote={quote} compact />
                  : <p className="text-xs text-slate-400 mt-1">Elige la OT y el distrito de destino para calcularlo.</p>}
              </div>
              </div>
            </FormSection>

            <FormSection id="req-descarga" step={needsSupplier ? 7 : 6} title="Descarga especial *" hint="¿La entrega requiere montacargas, grúa, estiba u otros?">
                <p className="text-xs text-slate-500 mb-2">Montacargas, grúa, estiba u otros en el punto de entrega. Mantienen su costo a cargo de JRM, incluso cuando el cliente recoge.</p>
                <div className="flex gap-4 mb-2">
                  {(['NO', 'SI'] as const).map(v => (
                    <label key={v} className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm cursor-pointer ${unloadingAnswer === v ? 'border-[#002855] bg-blue-50 font-semibold text-[#002855]' : 'border-slate-300 text-slate-700'}`}>
                      <input type="radio" name="unloading_required" checked={unloadingAnswer === v} onChange={() => {
                        setUnloadingAnswer(v)
                        if (v === 'SI' && unloading.length === 0) setUnloading([{ concept: 'MONTACARGAS', estimated_pen: '', description: '' }])
                      }} />
                      {v === 'SI' ? 'Sí, requiere' : 'No requiere'}
                    </label>
                  ))}
                </div>

                {unloadingHistory.length > 0 && (
                  <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-sm text-amber-900">
                    <p className="font-semibold mb-1">Referencia de solicitudes anteriores</p>
                    <ul className="space-y-1.5">
                      {unloadingHistory.slice(0, 3).map(h => {
                        const needs = (h.lines || []).length > 0
                        return (
                          <li key={h.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span><strong>{h.request_number}</strong> <span className="text-xs text-amber-800">({MATCH_LABEL[h.score] || 'referencia'}{h.required_date ? ` · ${new Date(h.required_date).toLocaleDateString('es-PE')}` : ''})</span>:</span>
                            <span>{needs ? (h.lines || []).map(l => {
                              const amount = l.actual_pen ?? l.planned_pen ?? l.estimated_pen
                              const kind = l.actual_pen != null ? 'real' : l.planned_pen != null ? 'planificado' : 'estimado'
                              return `${UNLOADING_LABEL[l.concept] || l.concept}${Number(amount) > 0 ? ` S/ ${Number(amount).toLocaleString('es-PE')} ${kind}` : ' (sin monto)'}`
                            }).join(' · ') : 'no requirió descarga'}</span>
                            <button type="button" onClick={() => applyUnloadingReference(h)} className="text-xs font-semibold text-[#002855] underline">Usar como referencia</button>
                          </li>
                        )
                      })}
                    </ul>
                    {unloadingAnswer === 'NO' && unloadingHistory.some(h => h.score >= 2 && (h.lines || []).length > 0) && (
                      <p className="mt-1.5 text-xs font-semibold text-red-700">Atención: una entrega anterior a este destino sí necesitó descarga especial.</p>
                    )}
                  </div>
                )}

                {unloadingAnswer === 'SI' && <>
                  {unloading.map((u, i) => (
                    <div key={i} className="flex flex-wrap gap-2 mb-2">
                      <select value={u.concept} onChange={e => setUnloading(list => list.map((x, j) => j === i ? { ...x, concept: e.target.value } : x))}
                        className="px-2 py-1.5 bg-white border border-slate-300 rounded-lg text-sm">
                        <option value="MONTACARGAS">Montacargas</option><option value="GRUA">Grúa</option>
                        <option value="ESTIBA">Estiba</option><option value="OTROS">Otros</option>
                      </select>
                      <span className={`w-36 px-2 py-1.5 rounded-lg text-sm tabular-nums border ${u.estimated_pen ? 'bg-slate-50 border-slate-200 text-slate-800' : 'bg-amber-50 border-amber-200 text-amber-700'}`}
                        title="Monto referencial del tarifario">
                        {u.estimated_pen ? `S/ ${Number(u.estimated_pen).toLocaleString('es-PE', { minimumFractionDigits: 2 })}` : 'Sin tarifa'}
                      </span>
                      <input type="text" placeholder="Detalle (capacidad, horas, cuadrilla…)" value={u.description}
                        onChange={e => setUnloading(list => list.map((x, j) => j === i ? { ...x, description: e.target.value } : x))}
                        className="flex-1 min-w-[140px] px-2 py-1.5 bg-white border border-slate-300 rounded-lg text-sm" />
                      <button type="button" onClick={() => setUnloading(list => list.filter((_, j) => j !== i))}
                        className="px-2 text-slate-400 hover:text-red-600 text-sm">Quitar</button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setUnloading(list => [...list, { concept: 'MONTACARGAS', estimated_pen: '', description: '' }])}
                    className="text-sm text-[#002855] font-medium hover:underline">+ Agregar recurso de descarga</button>
                  {unloadingTotal > 0 && <span className="ml-3 text-xs text-slate-600">Total descarga: S/ {unloadingTotal.toLocaleString('es-PE')}</span>}
                </>}
            </FormSection>
          </div>

          <aside className="space-y-3 lg:sticky lg:top-0 lg:self-start">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
              <p className="mb-3 text-xs font-bold uppercase tracking-wide text-slate-500">Resumen</p>
              <dl className="space-y-2">
                <div><dt className="text-xs text-slate-500">Servicio</dt><dd className="mt-0.5"><ServiceTypeBadge full request={{ request_type: newRequest.request_type, attention_mode: newRequest.attention_mode, contract_id: newRequest.contract_id || null }} /></dd></div>
                <div><dt className="text-xs text-slate-500">OT</dt><dd className="font-semibold text-slate-900">{contracts.find(c => c.id === newRequest.contract_id)?.code || 'Sin OT'}{selectedOptions.length > 0 && <span className="font-normal text-slate-500"> · {selectedOptions.length} comp.</span>}</dd></div>
                {needsSupplier && <div><dt className="text-xs text-slate-500">Proveedor</dt><dd className="truncate font-semibold text-slate-900">{suppliers.find(s => s.id === newRequest.supplier_id)?.business_name || '—'}</dd></div>}
                <div><dt className="text-xs text-slate-500">Ruta</dt><dd className="font-semibold text-slate-900">{newRequest.pickup_district || '—'} → {newRequest.delivery_district || '—'}</dd></div>
                <div><dt className="text-xs text-slate-500">Atención</dt><dd className="font-semibold text-slate-900">{requiredAt ? fullDateTime(requiredAt) : '—'}</dd></div>
                <div><dt className="text-xs text-slate-500">Documento</dt><dd className="font-semibold text-slate-900">{referenceLabel(newRequest) || 'Sin documento'}</dd></div>
                <div><dt className="text-xs text-slate-500">Flete referencial{unloadingTotal > 0 ? ' + descarga' : ''}</dt><dd className="font-semibold tabular-nums text-slate-900">S/ {(quoteFreight + unloadingTotal).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</dd></div>
              </dl>
            </div>
            <PendingPanel items={pendingItems} doneText="Revise el resumen y envíe la solicitud." />
          </aside>
        </form>
      </Modal>

      <Modal
        isOpen={Boolean(selectedRequestDetails)}
        onClose={() => { detailLoadId.current++;setSelectedRequestDetails(null) }}
        title={`Solicitud ${selectedRequestDetails?.request_number || ''}`}
        maxWidth="max-w-2xl"
      >
        {selectedRequestDetails && <div className="space-y-5 text-sm text-slate-700">
          <div className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-4">
            <div><span className="block text-xs text-slate-500">OT madre</span><strong>{detailExecution?.ot_code || selectedRequestDetails.contracts?.code || (selectedRequestDetails.contract_id ? 'OT vinculada sin código disponible' : 'Sin OT')}</strong></div>
            <div><span className="block text-xs text-slate-500">Estado</span>{getStatusBadge(selectedRequestDetails.status)}</div>
            <div><span className="block text-xs text-slate-500">Código / Emisión</span><strong>{selectedRequestDetails.request_number}</strong><p className="mt-1">{requestDate(selectedRequestDetails.created_at, true)}</p></div><div><span className="block text-xs text-slate-500">Tipo de servicio</span>{serviceLabel(selectedRequestDetails)}</div><div><span className="block text-xs text-slate-500">Cliente</span>{selectedRequestDetails.contracts?.clients?.business_name || 'Sin cliente registrado'}</div><div><span className="block text-xs text-slate-500">Proveedor de origen</span>{selectedRequestDetails.suppliers?.business_name || (requiresSupplier(selectedRequestDetails) ? 'Proveedor sin vincular' : 'No aplica')}</div><div><span className="block text-xs text-slate-500">Documento de referencia</span>{referenceLabel(selectedRequestDetails) || 'Sin documento'}</div><div><span className="block text-xs text-slate-500">Área / Departamento</span>{selectedRequestDetails.department}</div><div><span className="block text-xs text-slate-500">Solicitante</span>{selectedRequestDetails.requester_name}</div>
            <div><span className="block text-xs text-slate-500">Fecha requerida</span>{selectedRequestDetails.required_at ? requestDate(selectedRequestDetails.required_at, true) : serviceDate(selectedRequestDetails.required_date)}{selectedRequestDetails.time_window && <p className="mt-1 flex items-center gap-1 text-xs"><Clock className="h-3 w-3" />{selectedRequestDetails.time_window}</p>}</div>
            <div><span className="block text-xs text-slate-500">Origen</span>{selectedRequestDetails.pickup_address || 'Sin origen'}</div>
            <div><span className="block text-xs text-slate-500">Destino</span>{selectedRequestDetails.delivery_address || 'Sin destino'}</div>
          </div>
          {selectedRequestDetails.request_type === 'DESPACHO' && selectedRequestDetails.attention_mode !== 'RECOJO_CLIENTE' && <div className="rounded-lg border border-slate-200 p-4"><h3 className="font-semibold text-slate-900">Anticipación de entrega</h3><p className="mt-2">{!selectedRequestDetails.required_at ? 'Sin evaluación: registro histórico sin fecha y hora precisas.' : !leadTimeLoaded ? 'Configuración no disponible.' : formatLeadTimeStatus(requestLeadTime(selectedRequestDetails).status)}</p>{leadTimeLoaded && selectedRequestDetails.required_at && requestLeadTime(selectedRequestDetails).minimumAt && <p className="mt-1 text-xs text-slate-500">Zona: {selectedRequestDetails.delivery_zone || 'Sin zona'} · Plazo: {requestLeadTime(selectedRequestDetails).hours} horas · Primera atención permitida: {firstAllowed(requestLeadTime(selectedRequestDetails).minimumAt)}</p>}</div>}
          <div className="rounded-lg border border-slate-200 p-4"><h3 className="font-semibold text-slate-900">Glosa / Detalle de carga</h3><p className="mt-2 whitespace-pre-wrap break-words">{selectedRequestDetails.cargo_description || 'Sin glosa registrada'}</p>{selectedRequestDetails.purchase_order && <p className="mt-2 text-xs">Orden de compra: {selectedRequestDetails.purchase_order}</p>}{selectedRequestDetails.budget_observation && <p className="mt-3 rounded-lg bg-rose-50 p-3 text-xs text-rose-800">Observación: {selectedRequestDetails.budget_observation}</p>}</div>
          <div>
            <h3 className="font-semibold text-slate-900 mb-2">Componentes incluidos</h3>
            {detailsLoading ? <p className="text-slate-500">Cargando detalle...</p> :
              selectedRequestDetails.transport_request_components?.length ?
                <div className="divide-y rounded-lg border border-slate-200">
                  {selectedRequestDetails.transport_request_components.map(item => <div key={item.id} className="flex justify-between gap-4 p-3">
                    <span><strong>{detailContracts[item.component_contract_id]?.code || item.component_contract_id}</strong>
                      <span className="block text-xs text-slate-500">{detailContracts[item.component_contract_id]?.type || 'Componente histórico'}</span></span>
                    <span className="text-right">{item.requested_weight_kg === null ? 'Peso sin registrar' : `${Number(item.requested_weight_kg).toLocaleString('es-PE')} kg`}
                      <span className="block text-xs text-slate-500">{item.requested_volume_m3 === null ? 'Volumen sin registrar' : `${Number(item.requested_volume_m3).toLocaleString('es-PE')} m³`}</span></span>
                  </div>)}
                </div> : <p className="text-slate-500">La solicitud histórica no tiene componentes identificados con certeza.</p>}
          </div>
          <div className="grid grid-cols-2 gap-3 rounded-lg bg-blue-50 p-4">
            <div><span className="block text-xs text-slate-500">Peso solicitado (estimado)</span><strong>{selectedRequestDetails.estimated_weight > 0 ? `${Number(selectedRequestDetails.estimated_weight).toLocaleString('es-PE')} kg` : 'Sin peso solicitado registrado'}</strong></div>
            <div><span className="block text-xs text-slate-500">Volumen de cabecera</span><strong>{Number(selectedRequestDetails.estimated_volume || 0).toLocaleString('es-PE')} m³</strong></div>
            <div><span className="block text-xs text-slate-500">Modalidad de atención</span><strong>{selectedRequestDetails.attention_mode === 'RECOJO_CLIENTE' ? 'Recojo por el cliente' : selectedRequestDetails.attention_mode === 'TRANSPORTE_JRM' ? 'Transporte JRM' : 'Pendiente de confirmar'}</strong><p className="text-xs text-slate-600">{selectedRequestDetails.pickup_customer} {selectedRequestDetails.pickup_contact} {selectedRequestDetails.pickup_phone}</p></div>
            <div><span className="block text-xs text-slate-500">Costo estimado, una vez por solicitud</span><strong>S/ {Number(selectedRequestDetails.service_cost || 0).toLocaleString('es-PE')}</strong></div>
            <div><span className="block text-xs text-slate-500">Partida OT raíz</span><strong>{requestSummaries[selectedRequestDetails.id]?.root_allocated_pen == null ? 'Sin registrar' : `S/ ${Number(requestSummaries[selectedRequestDetails.id].root_allocated_pen).toLocaleString('es-PE')}`}</strong></div>
            <div><span className="block text-xs text-slate-500">Saldo actual OT raíz</span><strong>{requestSummaries[selectedRequestDetails.id]?.root_balance_pen == null ? 'Sin registrar' : `S/ ${Number(requestSummaries[selectedRequestDetails.id].root_balance_pen).toLocaleString('es-PE')}`}</strong></div>
          </div>
          <section className="space-y-3"><h3 className="font-semibold text-slate-900">Ejecución del servicio · kilómetros y peso sustentado</h3><p className="text-xs leading-5 text-slate-500">Los kilómetros pertenecen al tramo de esta solicitud; el retorno y el total de la ruta no se reparten entre sus OT. El peso real requiere guía validada y peso completo de SALIDA APT. Recojos y guías compartidas quedan pendientes de sustento específico.</p>
            {detailsLoading ? <p className="text-slate-500">Consultando viajes y mediciones…</p> : executionError ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">No se pudo consultar la ejecución: {executionError}</p> : !detailExecution?.legs.length ? <p className="rounded-lg bg-slate-50 p-3 text-slate-500">Sin viajes vinculados; aún no hay kilómetros ni peso transportado registrados.</p> : <div className="overflow-hidden rounded-lg border border-slate-200"><DataTable className="block w-full text-left md:table"><thead className="hidden bg-slate-50 text-xs text-slate-500 md:table-header-group"><tr>{['Viaje / Unidad','Estado / Guía','KM del tramo','Peso real transportado'].map(t => <th key={t} className="p-3" scope="col">{t}</th>)}</tr></thead><tbody className="block divide-y md:table-row-group">{detailExecution.legs.map(leg => <tr key={leg.dispatch_id} className="grid grid-cols-1 sm:grid-cols-2 md:table-row"><td className="p-3 align-top"><p className="break-words text-xs font-bold text-[#002855]">{leg.dispatch_number}</p><p className="mt-1 text-xs">{leg.vehicle_plate || 'Sin unidad'} · {leg.driver_name || 'Sin conductor'}</p><p className="mt-1 text-xs text-slate-500">Parada {leg.sequence ?? 'sin orden'}</p></td><td className="p-3 align-top"><p className="text-xs font-semibold">{leg.dispatch_status} · {leg.conformity}</p><p className="mt-1 text-xs text-slate-500">Guía: {leg.guide_number || 'Sin guía registrada'}</p></td><td className="p-3 align-top"><p className="mb-1 text-xs text-slate-500 md:hidden">KM del tramo</p><p className="font-semibold">{leg.actual_km == null ? 'Sin medición' : `${Number(leg.actual_km).toLocaleString('es-PE',{maximumFractionDigits:3})} km`}</p><p className="mt-1 text-xs text-slate-500">{leg.actual_km == null ? leg.modalidad === 'TERCERO' ? 'Proveedor sin trazado GPS registrado' : 'Sin trazado GPS registrado' : leg.gps_complete === true ? 'GPS completo' : 'GPS parcial · no es el recorrido completo'}</p></td><td className="p-3 align-top"><p className="mb-1 text-xs text-slate-500 md:hidden">Peso real transportado</p><p className="font-semibold">{leg.actual_weight_kg == null ? 'Sin peso real sustentado' : `${Number(leg.actual_weight_kg).toLocaleString('es-PE')} kg`}</p><p className="mt-1 max-w-64 text-xs leading-5 text-slate-500">{executionWeightLabels[leg.weight_status] || 'Origen del peso no identificado'}</p></td></tr>)}</tbody></DataTable></div>}
          </section>
          <div>
            <h3 className="font-semibold text-slate-900 mb-2">Historial</h3>
            {detailEvents.length ? <div className="space-y-2">{detailEvents.map(event => <details key={event.id} className="rounded border border-slate-200 p-3">
              <summary className="cursor-pointer">{event.action === 'CREATED' ? 'Creada' : event.action === 'UPDATED' ? 'Actualizada' : 'Estado cambiado'} · {requestDate(event.created_at, true)}</summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-slate-600">{JSON.stringify({ anterior: event.previous_state, nuevo: event.next_state }, null, 2)}</pre>
            </details>)}</div> : <p className="text-slate-500">No hay eventos de auditoría registrados para esta solicitud.</p>}
          </div>
        </div>}
      </Modal>

      <Modal
        isOpen={isRescheduleModalOpen}
        onClose={() => setIsRescheduleModalOpen(false)}
        title="Reprogramar Solicitud"
        maxWidth="max-w-md"
      >
        <form onSubmit={handleRescheduleRequest} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Nueva Fecha Requerida</label>
            <input 
              type="date" 
              required
              min={limaInputParts(new Date().toISOString()).date}
              className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
              value={newRescheduleDate}
              onChange={(e) => setNewRescheduleDate(e.target.value)}
            />
          </div>
          <div><label htmlFor="reschedule-required-time" className="mb-1 block text-sm font-medium text-slate-700">Nueva hora · Lima</label><input id="reschedule-required-time" type="time" required value={newRescheduleTime} onChange={event => setNewRescheduleTime(event.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900" /></div>
          {rescheduleApplies && <div className="space-y-2"><label className="block text-sm font-medium text-slate-700">Zona de entrega<select value={rescheduleZone} onChange={event => setRescheduleZone(event.target.value as DeliveryZone)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900"><option value="LIMA">Lima y Callao</option><option value="PROVINCIA">Provincia</option><option value="EXTERIOR">Exterior</option></select></label><p role="status" className={`rounded-lg p-3 text-xs ${rescheduleRequiredAt && rescheduleEvaluation.enough === false ? 'bg-red-50 text-red-800' : 'bg-blue-50 text-blue-900'}`}>{!leadTimeLoaded ? leadTimeError || 'Consultando plazos…' : rescheduleEvaluation.minimumAt ? `Primera atención permitida: ${firstAllowed(rescheduleEvaluation.minimumAt)}. Se conserva el registro original de la solicitud.` : 'Control de anticipación desactivado.'}</p></div>}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Causa de la reprogramación</label>
            <select required value={rescheduleCause} onChange={(e) => setRescheduleCause(e.target.value)}
              className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none">
              <option value="">Seleccionar…</option>
              <option value="CLIENTE">Pedido del cliente</option>
              <option value="ALMACEN_SIN_STOCK">Almacén sin stock / material no listo</option>
              <option value="PRODUCCION">Producción no terminó</option>
              <option value="SIN_UNIDAD">Sin unidad disponible</option>
              <option value="SIN_CONDUCTOR">Sin conductor disponible</option>
              <option value="VIA_CLIMA">Vía o clima</option>
              <option value="DOCUMENTOS">Documentos pendientes</option>
              <option value="OTRO">Otro (detallar)</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Detalle {rescheduleCause === 'OTRO' ? '(obligatorio)' : '(opcional)'}</label>
            <input type="text" required={rescheduleCause === 'OTRO'} value={rescheduleDetail} onChange={(e) => setRescheduleDetail(e.target.value)}
              className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none" />
          </div>
          <div className="pt-4 flex justify-end gap-3 border-t border-slate-200">
            <button 
              type="button" 
              onClick={() => setIsRescheduleModalOpen(false)}
              className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg transition-colors"
            >
              Cancelar
            </button>
            <button 
              type="submit" 
              disabled={isSubmitting || (Boolean(rescheduleApplies) && !leadTimeLoaded) || !rescheduleRequiredAt || (Boolean(rescheduleApplies) && rescheduleEvaluation.enough === false)}
              className="px-4 py-2 bg-orange-600 text-white font-medium rounded-lg hover:bg-orange-700 transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarClock className="w-4 h-4" />}
              Confirmar
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}

const REQUEST_AREAS = ['OT (Administración de Contratos)', 'Recursos Humanos', 'Logística', 'Gerencia', 'Producción', 'Almacén', 'Otros']
const REQUEST_TYPE_OPTIONS: { value: string; kind: ServiceKind; title: string; hint: string }[] = [
  { value: 'DESPACHO', kind: 'ENTREGA_OT', title: 'Despacho', hint: 'Salida de planta hacia el cliente' },
  { value: 'RECOJO', kind: 'RECOJO', title: 'Recojo', hint: 'Del proveedor hacia planta' },
  { value: 'TRASLADO', kind: 'PUNTO_A_PUNTO', title: 'Punto a punto', hint: 'Entre dos puntos externos' },
]
const field = 'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-[#002855] disabled:bg-slate-100 disabled:text-slate-500'
const fieldSm = 'mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-[#002855]'

