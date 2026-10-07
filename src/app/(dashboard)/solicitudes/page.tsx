"use client"
import { DataTable } from '@/components/ui/data-table'
import { TableActions, type TableAction } from '@/components/ui/table-actions'
import { TablePagination } from '@/components/ui/table-pagination'

import { operatingBudget } from '@/lib/transport-budget'
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Plus, Send, Check, X, Search, Loader2, Clock, CalendarClock, Ban, Edit2, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { usePermissions } from '@/hooks/usePermissions'
import { normalizeRoleName } from '@/lib/roles'
import { OtPicker, type OtNode } from '@/components/solicitudes/OtPicker'
import { QuoteBreakdown } from '@/components/tarifas/TransportTariffManager'
import { serviceAddresses, serviceLabel, executionWeightLabels, type RequestExecution } from '@/lib/request-service'
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
  const [pageSize, setPageSize] = useState(25)
  const [sort, setSort] = useState<{ key: 'created_at' | 'required_date' | 'service' | 'ot' | 'address' | 'status'; direction: 'asc' | 'desc' }>({ key: 'created_at', direction: 'desc' })
  const statusLabels: Record<string, string> = {
    PENDIENTE: 'Pendiente', 'PENDIENTE DE APROBACIÓN': 'Pendiente', APROBADA: 'Aprobada', APROBADO: 'Aprobada',
    ASIGNADA: 'Asignada', REPROGRAMADA: 'Reprogramada', OBSERVADA: 'Observada', RECHAZADA: 'Rechazada',
    CANCELADA: 'Cancelada', EN_TRANSITO: 'En ruta', EN_DESTINO: 'En destino', ENTREGADA: 'Entregada', FINALIZADA: 'Finalizada',
  }
  const compactService = (request: TransportRequest) => request.attention_mode === 'RECOJO_CLIENTE' ? 'Recojo cliente'
    : request.request_type === 'DESPACHO' ? 'Entrega' : request.request_type === 'RECOJO' ? 'Recojo' : request.request_type === 'TRASLADO' ? 'Punto a punto' : 'Sin identificar'
  const matchesStatus = (status: string, filter: string) => filter === 'TODOS' || status === filter
    || (filter === 'PENDIENTE' && status === 'PENDIENTE DE APROBACIÓN') || (filter === 'APROBADA' && status === 'APROBADO')
  const filteredRequests = requests.filter(r => {
    const matchesSearch = [r.request_number, r.requester_name, r.contracts?.code, r.contracts?.clients?.business_name, r.cargo_description, r.pickup_address, r.delivery_address].join(' ').toLocaleLowerCase('es-PE').includes(searchTerm.trim().toLocaleLowerCase('es-PE'))
    const matchesDateFrom = filterDateFrom === '' || r.required_date >= filterDateFrom
    const matchesDateTo = filterDateTo === '' || r.required_date <= filterDateTo
    const matchesService = filterService === 'TODOS' || (filterService === 'RECOJO_CLIENTE' ? r.attention_mode === 'RECOJO_CLIENTE' : r.attention_mode !== 'RECOJO_CLIENTE' && r.request_type === filterService)
    return matchesSearch && matchesStatus(r.status, filterStatus) && matchesDateFrom && matchesDateTo && matchesService
  }).sort((a, b) => {
    const value = (r: TransportRequest) => sort.key === 'service' ? compactService(r) : sort.key === 'ot' ? r.contracts?.code || ''
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
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [userRole, setUserRole] = useState<string>('')
  
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
    time_window: '',
    contract_id: '',
    cargo_description: '',
    estimated_weight: '',
    estimated_volume: '',
    service_cost: '',
    purchase_order: ''
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

  const checkUser = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('first_name, last_name, roles(name)')
        .eq('id', user.id)
        .single()
      
      if (profile) {
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
    }, 0)
    return () => window.clearTimeout(task)
  }, [fetchRequests, fetchContracts, checkUser])

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

  const openEditModal = async (request: TransportRequest) => {
    const root = contracts.find(c => c.id === request.contract_id)
    if (request.contract_id && !root) { toast.error('La OT de esta solicitud no está disponible para edición.'); return }
    const options = root ? await loadComponentOptions(root.id, request.id) : []
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
      requester_name: request.requester_name,
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
      required_date: request.required_date ? request.required_date.split('T')[0] : '',
      time_window: request.time_window || '',
      contract_id: request.contract_id || '',
      cargo_description: request.cargo_description || '',
      estimated_weight: request.estimated_weight ? request.estimated_weight.toString() : '',
      estimated_volume: request.estimated_volume ? request.estimated_volume.toString() : '',
      service_cost: request.service_cost?.toString() || '',
      purchase_order: request.purchase_order || ''
    })

    setEditingRequestId(request.id)
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

    setIsSubmitting(true)

    try {
      const { data: saved, error } = await supabase.rpc('save_transport_request_attention', {
        p_request_id: editingRequestId,
        p_payload: { ...newRequest, contract_id: newRequest.contract_id || null, service_cost: isCustomerPickup ? 0 : newRequest.service_cost, destination_acknowledged: destinationAcknowledged },
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
        time_window: '',
        contract_id: '',
        cargo_description: '',
        estimated_weight: '',
        estimated_volume: '',
        service_cost: '',
        purchase_order: ''
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
    if (!selectedRequestId || !newRescheduleDate) return;
    
    try {
      setIsSubmitting(true);
      const { data, error } = await supabase.rpc('reprogramar_solicitud', {
        p_request_id: selectedRequestId, p_fecha: newRescheduleDate, p_causa: rescheduleCause, p_detalle: rescheduleDetail || null
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
    const tone = ['PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'REPROGRAMADA'].includes(status) ? 'bg-amber-50 text-amber-800'
      : ['APROBADA', 'APROBADO', 'ENTREGADA', 'FINALIZADA'].includes(status) ? 'bg-emerald-50 text-emerald-800'
      : ['OBSERVADA', 'RECHAZADA'].includes(status) ? 'bg-rose-50 text-rose-800'
      : ['ASIGNADA', 'EN_TRANSITO', 'EN_DESTINO'].includes(status) ? 'bg-blue-50 text-[#002855]' : 'bg-slate-100 text-slate-600'
    return <span title={status.replaceAll('_', ' ')} className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>{statusLabels[status] || status.replaceAll('_', ' ')}</span>
  }

  return (
    <div className="flex min-h-0 w-full flex-col gap-4 mx-auto lg:h-full">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Solicitud de Transporte</h1>
          <p className="text-sm text-slate-500">Control de servicios programados</p>
        </div>
        {canWrite('solicitudes') && (
          <button 
            onClick={() => {
              if (contracts.length === 0) fetchContracts()
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
                time_window: '',
                contract_id: '',
                cargo_description: '',
                estimated_weight: '',
                estimated_volume: '',
                service_cost: '',
                purchase_order: ''
              })
              setIsModalOpen(true)
            }}
            className="flex items-center gap-2 bg-[#002855] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#001d3d] transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" />
            Nueva Solicitud
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm lg:flex-1">
        <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 bg-white p-3 sm:p-4">
          <label className="relative min-w-0 flex-1 basis-60">
            <span className="sr-only">Buscar solicitudes</span><Search className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" aria-hidden="true" />
            <input type="search" placeholder="Buscar OT, solicitud o dirección…" value={searchTerm}
              onChange={event => { setSearchTerm(event.target.value); setPage(1) }}
              className="h-11 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#002855]" />
          </label>
          <label className="min-w-0 text-xs text-slate-500">Desde<input aria-label="Atención desde" type="date" value={filterDateFrom}
            onChange={event => { setFilterDateFrom(event.target.value); setPage(1) }} className="mt-1 block h-11 max-w-full rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-700" /></label>
          <label className="min-w-0 text-xs text-slate-500">Hasta<input aria-label="Atención hasta" type="date" min={filterDateFrom || undefined} value={filterDateTo}
            onChange={event => { setFilterDateTo(event.target.value); setPage(1) }} className="mt-1 block h-11 max-w-full rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-700" /></label>
          <select aria-label="Filtrar por tipo de servicio" value={filterService} onChange={e => { setFilterService(e.target.value); setPage(1) }} className="h-11 max-w-full rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-700">
            <option value="TODOS">Tipo de servicio</option><option value="DESPACHO">Entrega</option><option value="RECOJO">Recojo</option><option value="TRASLADO">Punto a punto</option><option value="RECOJO_CLIENTE">Recojo cliente</option>
          </select>
          <select aria-label="Filtrar estado" value={filterStatus} onChange={e => { setFilterStatus(e.target.value); setPage(1) }} className="h-11 max-w-full rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-700">
            <option value="TODOS">Todos los estados</option>{Array.from(new Set(['PENDIENTE', 'APROBADA', 'ASIGNADA', 'REPROGRAMADA', 'OBSERVADA', 'RECHAZADA', 'CANCELADA', ...requests.map(r => r.status).filter(status => status !== 'PENDIENTE DE APROBACIÓN' && status !== 'APROBADO')])).map(status => <option key={status} value={status}>{statusLabels[status] || status.replaceAll('_', ' ')}</option>)}
          </select>
          <button type="button" onClick={clearFilters} className="min-h-11 rounded-lg px-3 text-sm text-slate-500 hover:bg-slate-50 hover:text-[#002855]">Limpiar</button>
        </div>
        <div aria-label="Resumen por estado" className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 border-b border-slate-200 px-3 py-2 sm:px-4">
          {[{ key: 'TODOS', label: 'Todas' }, { key: 'PENDIENTE', label: 'Pendientes' }, { key: 'APROBADA', label: 'Aprobadas' }, { key: 'ASIGNADA', label: 'Asignadas' }, { key: 'REPROGRAMADA', label: 'Reprogramadas' }].map(tab => <button key={tab.key} type="button" aria-pressed={filterStatus === tab.key} onClick={() => { setFilterStatus(tab.key); setPage(1) }} className={`flex min-h-11 items-center gap-2 border-b-2 text-xs ${filterStatus === tab.key ? 'border-[#002855] font-semibold text-[#002855]' : 'border-transparent text-slate-500 hover:text-[#002855]'}`}>
            {tab.label}<span className="rounded-full bg-slate-100 px-2 py-0.5 tabular-nums text-slate-600">{requests.filter(r => matchesStatus(r.status, tab.key)).length}</span>
          </button>)}
        </div>
        <div role="region" aria-label="Tabla de solicitudes de transporte" tabIndex={0} className="min-h-0 overflow-auto lg:flex-1">
          <DataTable className="block w-full table-fixed text-left lg:min-w-[980px] lg:table"><caption className="sr-only">Solicitud de Transporte: fechas, tipo de servicio, OT, punto de atención, estado y acciones</caption>
            <thead className="sticky top-0 z-10 hidden bg-slate-50 text-xs text-slate-500 lg:table-header-group"><tr>
              {[{ title: 'Fecha solicitud', key: 'created_at', width: 'w-[12%]' }, { title: 'Fecha atención', key: 'required_date', width: 'w-[12%]' }, { title: 'Tipo de servicio', key: 'service', width: 'w-[12%]' }, { title: 'OT', key: 'ot', width: 'w-[7%]' }, { title: 'Punto de atención', key: 'address', width: 'w-[27%]' }, { title: 'Estado', key: 'status', width: 'w-[13%]' }, { title: 'Acciones', width: 'w-[17%]' }].map(column => <th key={column.title} scope="col" className={column.width} aria-sort={column.key && sort.key === column.key ? sort.direction === 'asc' ? 'ascending' : 'descending' : undefined}>
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
                  ...(editable && canReschedule ? [{ id: 'reschedule', label: 'Reprogramar', icon: <CalendarClock className="h-4 w-4" />, onSelect: () => { setSelectedRequestId(req.id); setNewRescheduleDate(req.required_date.split('T')[0] || ''); setIsRescheduleModalOpen(true) } }] : []),
                  ...(editable ? [{ id: 'cancel', label: 'Cancelar servicio', icon: <Ban className="h-4 w-4" />, tone: 'danger' as const, onSelect: () => { void handleCancelRequest(req.id) } }] : []),
                ]
                return <tr key={req.id} className="grid grid-cols-2 hover:bg-slate-50/70 lg:table-row">
                  <td className={cell}>{label('Fecha solicitud')}<p className="font-medium text-slate-700">{requestDate(req.created_at)}</p></td>
                  <td className={cell}>{label('Fecha atención')}<p className="font-medium text-slate-700">{serviceDate(req.required_date)}</p>{req.status === 'REPROGRAMADA' && <p className="mt-0.5 text-xs text-amber-700">Reprogramada</p>}</td>
                  <td className={cell}>{label('Tipo de servicio')}<span title={serviceLabel(req)} className="text-slate-700">{compactService(req)}</span></td>
                  <td className={cell}>{label('OT')}<p className="break-words font-semibold text-[#002855]">{req.contracts?.code || (req.contract_id ? 'OT vinculada' : 'Sin OT')}</p></td>
                  <td className={`${cell} col-span-2`}>{label('Punto de atención')}<div title={addresses.map(place => `${place.label}: ${place.address}`).join(' → ')} className="text-slate-700">
                    {addresses.map((place, index) => <p key={place.label} className={addresses.length === 1 ? 'line-clamp-2 break-words leading-5' : 'truncate leading-5'}>{addresses.length > 1 && <span className="text-slate-400">{index === 0 ? 'Origen: ' : '→ '}</span>}{place.address}</p>)}
                  </div></td>
                  <td className={cell}>{label('Estado')}{getStatusBadge(req.status)}</td>
                  <td className={cell}>{label('Acciones')}<div className="flex flex-wrap items-center gap-1.5 lg:flex-nowrap">
                    <button type="button" onClick={() => void openRequestDetails(req)} aria-label={`Ver detalle de ${req.request_number}`} className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-[#002855] hover:border-slate-300 hover:bg-slate-50">Ver detalle</button>
                    <TableActions label={`Más acciones de ${req.request_number}`} actions={actions} />
                  </div></td>
                </tr>
              })}
            </tbody>
          </DataTable>
        </div>
        <TablePagination total={loading ? 0 : filteredRequests.length} page={currentPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1) }} />
      </div>

      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingRequestId ? "Editar Solicitud" : "Crear Nueva Solicitud"}
        maxWidth="max-w-4xl"
      >
        <form onSubmit={handleCreateRequest} className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Solicitante</label>
              <input 
                type="text" 
                required
                disabled={userRole !== 'admin'}
                placeholder="Nombre completo"
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none disabled:bg-slate-100 disabled:text-slate-500"
                value={newRequest.requester_name}
                onChange={(e) => setNewRequest({...newRequest, requester_name: e.target.value})}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Área / Departamento</label>
              <select
                required
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                value={newRequest.department}
                onChange={(e) => {
                  setNewRequest({...newRequest, department: e.target.value})
                }}
              >
                <option value="" disabled>Seleccionar Área...</option>
                <option value="OT (Administración de Contratos)">OT (Administración de Contratos)</option>
                <option value="Recursos Humanos">Recursos Humanos</option>
                <option value="Logística">Logística</option>
                <option value="Gerencia">Gerencia</option>
                <option value="Producción">Producción</option>
                <option value="Almacén">Almacén</option>
                <option value="Otros">Otros</option>
              </select>
            </div>
            
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Modalidad de atención *</label>
              <select value={newRequest.attention_mode} onChange={e => { setNewRequest(prev => ({ ...prev, attention_mode: e.target.value as AttentionMode, service_cost: '' })); setQuote(null) }}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900">
                <option value="TRANSPORTE_JRM">Transporte gestionado por JRM</option><option value="RECOJO_CLIENTE">Recojo por el cliente</option>
              </select>
              <p className="mt-1 text-xs text-slate-600">El armado de ruta heredará esta modalidad. {isCustomerPickup ? 'Flete JRM: S/ 0.00. Se emite Nota de Salida; otros recursos conservan sus costos.' : 'El supervisor asignará unidad propia o proveedor.'}</p>
            </div>
            {isCustomerPickup && <div className="md:col-span-2 grid grid-cols-1 gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3 md:grid-cols-3">
              {([['pickup_customer','Cliente que recoge'],['pickup_contact','Contacto autorizado'],['pickup_phone','Teléfono del contacto']] as const).map(([key,label]) => <label key={key} className="text-sm text-slate-700">{label} (opcional)<input value={newRequest[key]} type={key === 'pickup_phone' ? 'tel' : 'text'} onChange={e => setNewRequest(prev => ({ ...prev, [key]: e.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2" /></label>)}
            </div>}
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">OT / Proyecto asociado {otRequired ? '*' : '(opcional)'}</label>
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
            </div>
          </div>

          {newRequest.contract_id && (
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
          )}

          <div className="bg-slate-50 p-4 rounded-lg border border-slate-200 mt-4">
            <label className="block text-sm font-semibold text-slate-800 mb-3">Tipo de Solicitud</label>
            <div className="flex gap-6">
              <label className="flex items-center gap-2 cursor-pointer">
                <input 
                  type="radio" 
                  name="request_type" 
                  value="DESPACHO"
                  checked={newRequest.request_type === 'DESPACHO'}
                  onChange={(e) => {
                    const selC = contracts.find(c => c.id === newRequest.contract_id)
                    setNewRequest({
                      ...newRequest, 
                      request_type: e.target.value, 
                      pickup_address: 'Planta Chilca', 
                      delivery_address: selC?.destination_address || '',
                      delivery_department: selC?.destination_department || '',
                      delivery_province: selC?.destination_province || '',
                      delivery_district: selC?.destination_district || ''
                    })
                  }}
                  className="w-4 h-4 text-[#002855] focus:ring-[#002855]"
                />
                <span className="text-sm font-medium text-slate-700">Despacho (Salida de Planta)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input 
                  type="radio" 
                  name="request_type" 
                  value="RECOJO"
                  checked={newRequest.request_type === 'RECOJO'}
                  onChange={(e) => setNewRequest({...newRequest, request_type: e.target.value, pickup_address: '', pickup_department: '', pickup_province: '', pickup_district: '', delivery_address: 'Planta Chilca', delivery_department: 'LIMA', delivery_province: 'CAÑETE', delivery_district: 'CHILCA'})}
                  className="w-4 h-4 text-[#002855] focus:ring-[#002855]"
                />
                <span className="text-sm font-medium text-slate-700">Recojo (Retorno a Planta)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input 
                  type="radio" 
                  name="request_type" 
                  value="TRASLADO"
                  checked={newRequest.request_type === 'TRASLADO'}
                  onChange={(e) => setNewRequest({...newRequest, request_type: e.target.value, pickup_address: '', pickup_department: '', pickup_province: '', pickup_district: '', delivery_address: '', delivery_department: '', delivery_province: '', delivery_district: ''})}
                  className="w-4 h-4 text-[#002855] focus:ring-[#002855]"
                />
                <span className="text-sm font-medium text-slate-700">Traslado (Punto a Punto)</span>
              </label>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
            <div className="col-span-2 md:col-span-2 border border-slate-200 rounded-lg p-3 bg-slate-50/50">
              <h4 className="text-sm font-semibold text-slate-800 mb-2">Origen de Carga</h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="md:col-span-3">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Dirección Exacta</label>
                  <input 
                    type="text" 
                    required
                    className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newRequest.pickup_address}
                    onChange={(e) => setNewRequest({...newRequest, pickup_address: e.target.value})}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Departamento</label>
                  <input 
                    type="text" 
                    placeholder="Ej. LIMA"
                    className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newRequest.pickup_department}
                    onChange={(e) => setNewRequest({...newRequest, pickup_department: e.target.value.toUpperCase()})}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Provincia</label>
                  <input 
                    type="text" 
                    placeholder="Ej. CAÑETE"
                    className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newRequest.pickup_province}
                    onChange={(e) => setNewRequest({...newRequest, pickup_province: e.target.value.toUpperCase()})}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Distrito *</label>
                  <input 
                    type="text" 
                    required
                    placeholder="Ej. CHILCA"
                    className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newRequest.pickup_district}
                    onChange={(e) => setNewRequest({...newRequest, pickup_district: e.target.value.toUpperCase()})}
                  />
                </div>
              </div>
            </div>
            
            <div className="col-span-2 md:col-span-2 border border-slate-200 rounded-lg p-3 bg-slate-50/50">
              <h4 className="text-sm font-semibold text-slate-800 mb-2">Destino de Carga</h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="md:col-span-3">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Dirección Exacta</label>
                  <input 
                    type="text" 
                    list="historical-delivery-addresses"
                    required
                    className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newRequest.delivery_address}
                    onChange={(e) => setNewRequest({...newRequest, delivery_address: e.target.value})}
                  />
                  <datalist id="historical-delivery-addresses">
                    {Array.from(new Set(contracts.map(c => c.destination_address).filter(Boolean))).map((addr, idx) => (
                      <option key={idx} value={addr} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Departamento</label>
                  <input 
                    type="text" 
                    placeholder="Ej. LIMA"
                    className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newRequest.delivery_department}
                    onChange={(e) => setNewRequest({...newRequest, delivery_department: e.target.value.toUpperCase()})}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Provincia</label>
                  <input 
                    type="text" 
                    placeholder="Ej. LIMA"
                    className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newRequest.delivery_province}
                    onChange={(e) => setNewRequest({...newRequest, delivery_province: e.target.value.toUpperCase()})}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Distrito *</label>
                  <input 
                    type="text" 
                    required
                    placeholder="Ej. ATE"
                    className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newRequest.delivery_district}
                    onChange={(e) => setNewRequest({...newRequest, delivery_district: e.target.value.toUpperCase()})}
                  />
                </div>
              </div>
            </div>
            <div className="col-span-2 md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Fecha Requerida</label>
              <input 
                type="date" 
                required
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                value={newRequest.required_date}
                onChange={(e) => setNewRequest({...newRequest, required_date: e.target.value})}
              />
            </div>
            <div className="col-span-2 md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Ventana Horaria (Opcional)</label>
              <input 
                type="text" 
                placeholder="Ej. 08:00 AM - 12:00 PM"
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                value={newRequest.time_window}
                onChange={(e) => setNewRequest({...newRequest, time_window: e.target.value})}
              />
            </div>
          </div>

          {!newRequest.contract_id && <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{([['estimated_weight','Peso estimado (kg)'],['estimated_volume','Volumen estimado (m³)']] as const).map(([key,label]) => <label key={key} className="text-sm text-slate-700">{label}<input type="number" min="0" step="0.01" value={newRequest[key]} onChange={e => setNewRequest(prev => ({ ...prev, [key]: e.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" /></label>)}</div>}
          <div className="border-t border-slate-200 pt-6 mt-4">
            <h3 className="text-lg font-semibold text-slate-800 mb-4">Información de la Carga</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Descripción General / Glosa *</label>
                <textarea 
                  required
                  rows={3}
                  placeholder="Ej. 20 bobinas de acero para el proyecto Sur..."
                  className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none resize-none"
                  value={newRequest.cargo_description}
                  onChange={(e) => setNewRequest({...newRequest, cargo_description: e.target.value})}
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Orden de Compra / Orden de Servicio (Opcional)</label>
                <input 
                  type="text" 
                  placeholder="Ej. OC-2023-001"
                  className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                  value={newRequest.purchase_order || ''}
                  onChange={(e) => setNewRequest({...newRequest, purchase_order: e.target.value})}
                />
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
              <div className="md:col-span-2 rounded-lg border border-slate-200 p-3">
                <label className="block text-sm font-semibold text-slate-800">¿La entrega requiere descarga especial? *</label>
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
              </div>
            </div>
          </div>

          <div className="pt-4 flex justify-end gap-3 border-t border-slate-200 mt-4">
            <button 
              type="button" 
              onClick={() => setIsModalOpen(false)}
              className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg transition-colors"
            >
              Cancelar
            </button>
            <button 
              type="submit" 
              disabled={isSubmitting || componentsLoading || (otRequired && !newRequest.contract_id) || (Boolean(newRequest.contract_id) && selectedOptions.length === 0)}
              className="px-4 py-2 bg-[#002855] text-white font-medium rounded-lg hover:bg-[#001d3d] transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {editingRequestId ? "Actualizar Solicitud" : "Enviar Solicitud"}
            </button>
          </div>
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
            <div><span className="block text-xs text-slate-500">Código / Emisión</span><strong>{selectedRequestDetails.request_number}</strong><p className="mt-1">{requestDate(selectedRequestDetails.created_at, true)}</p></div><div><span className="block text-xs text-slate-500">Tipo de servicio</span>{serviceLabel(selectedRequestDetails)}</div><div><span className="block text-xs text-slate-500">Cliente</span>{selectedRequestDetails.contracts?.clients?.business_name || 'Sin cliente registrado'}</div><div><span className="block text-xs text-slate-500">Área / Departamento</span>{selectedRequestDetails.department}</div><div><span className="block text-xs text-slate-500">Solicitante</span>{selectedRequestDetails.requester_name}</div>
            <div><span className="block text-xs text-slate-500">Fecha requerida</span>{serviceDate(selectedRequestDetails.required_date)}{selectedRequestDetails.time_window && <p className="mt-1 flex items-center gap-1 text-xs"><Clock className="h-3 w-3" />{selectedRequestDetails.time_window}</p>}</div>
            <div><span className="block text-xs text-slate-500">Origen</span>{selectedRequestDetails.pickup_address || 'Sin origen'}</div>
            <div><span className="block text-xs text-slate-500">Destino</span>{selectedRequestDetails.delivery_address || 'Sin destino'}</div>
          </div>
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
              min={new Date().toISOString().split('T')[0]}
              className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
              value={newRescheduleDate}
              onChange={(e) => setNewRescheduleDate(e.target.value)}
            />
          </div>
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
              disabled={isSubmitting}
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
