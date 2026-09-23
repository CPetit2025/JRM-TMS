"use client"
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Plus, Send, Check, X, Search, Filter, Loader2, Calendar, Clock, CalendarClock, Ban, Activity, Edit2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { usePermissions } from '@/hooks/usePermissions'
import { normalizeRoleName } from '@/lib/roles'

interface TransportRequest {
  id: string
  request_number: string
  requester_name: string
  department: string
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

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

export default function SolicitudesPage() {
  const { canWrite } = usePermissions()
  const supabase = useMemo(() => createClient(), [])
  
  const [requests, setRequests] = useState<TransportRequest[]>([])
  const [requestSummaries, setRequestSummaries] = useState<Record<string, RequestSummary>>({})
  const [contracts, setContracts] = useState<Contract[]>([])
  const [contractSearch, setContractSearch] = useState('')
  const [componentOptions, setComponentOptions] = useState<ComponentOption[]>([])
  const [selectedComponents, setSelectedComponents] = useState<Record<string, SelectedComponent>>({})
  const [componentsLoading, setComponentsLoading] = useState(false)
  const [destinationAcknowledged, setDestinationAcknowledged] = useState(false)
  const componentLoadId = useRef(0)
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filterStatus, setFilterStatus] = useState('TODOS')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')

  const filteredRequests = requests.filter(r => {
    const matchesSearch = searchTerm === '' || r.request_number.toLowerCase().includes(searchTerm.toLowerCase()) || r.requester_name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = filterStatus === 'TODOS' || r.status === filterStatus;
    const matchesDateFrom = filterDateFrom === '' || r.required_date >= filterDateFrom;
    const matchesDateTo = filterDateTo === '' || r.required_date <= filterDateTo;
    return matchesSearch && matchesStatus && matchesDateFrom && matchesDateTo;
  });

  
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [userRole, setUserRole] = useState<string>('')
  
  const [isRescheduleModalOpen, setIsRescheduleModalOpen] = useState(false)
  const [selectedRequestDetails, setSelectedRequestDetails] = useState<TransportRequest | null>(null)
  const [detailContracts, setDetailContracts] = useState<Record<string, { code: string; type: string }>>({})
  const [detailEvents, setDetailEvents] = useState<Array<{ id: string; action: string; created_at: string; previous_state: Record<string, unknown> | null; next_state: Record<string, unknown> }>>([])
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null)
  const [newRescheduleDate, setNewRescheduleDate] = useState('')
  
  const [newRequest, setNewRequest] = useState({
    requester_name: '',
    department: '',
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
  const selectedOptions = componentOptions.filter(option => selectedComponents[option.contract_id])
  const requestedWeight = selectedOptions.reduce((sum, option) =>
    sum + Number(selectedComponents[option.contract_id].weight_kg || 0), 0)
  const requestedVolume = selectedOptions.reduce((sum, option) =>
    sum + Number(selectedComponents[option.contract_id].volume_m3 || 0), 0)
  const mixedDestinations = new Set(selectedOptions.map(option =>
    option.destination_address?.trim().toLowerCase()).filter(Boolean)).size > 1
  const rootBudget = componentOptions.find(option => option.contract_id === newRequest.contract_id)
  const estimatedCost = Number(newRequest.service_cost || 0)

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
          setUserRole(normalizeRoleName(roleName))
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
      const { data, error } = await supabase
        .from('contracts')
        .select(`
          id, code, type, status,
          destination_address, destination_department, destination_province, destination_district,
          clients ( business_name )
        `)
        .eq('status', 'ACTIVO')
        .in('type', ['CONTRATO', 'OT_INDEPENDIENTE'])
        .is('parent_contract_id', null)
        .order('code')

      if (error) throw error
      
      setContracts(data || [])
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
    if (!root) { toast.error('Esta solicitud histórica no tiene una OT madre disponible para edición.'); return }
    const options = await loadComponentOptions(root.id, request.id)
    if (!options) return
    const unavailable = (request.transport_request_components || []).filter(item =>
      !options.some(option => option.contract_id === item.component_contract_id))
    if (unavailable.length) {
      toast.error('Esta solicitud contiene componentes inactivos o ya desvinculados de la OT; no se pueden editar sin revisión de datos.')
      return
    }
    setContractSearch(root.code)
    setDestinationAcknowledged(false)
    setSelectedComponents(Object.fromEntries((request.transport_request_components || []).map(item => [
      item.component_contract_id,
      { weight_kg: item.requested_weight_kg?.toString() || '', volume_m3: item.requested_volume_m3?.toString() || '' }
    ])))
    setNewRequest({
      requester_name: request.requester_name,
      department: request.department.startsWith('OT -') ? 'OT (Administración de Contratos)' : request.department,
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
    setIsModalOpen(true)
  }

  const openRequestDetails = async (request: TransportRequest) => {
    setSelectedRequestDetails(request)
    setDetailsLoading(true)
    setDetailContracts({})
    setDetailEvents([])
    const ids = (request.transport_request_components || []).map(item => item.component_contract_id)
    const [contractsResult, eventsResult] = await Promise.all([
      ids.length ? supabase.from('contracts').select('id, code, type').in('id', ids) : Promise.resolve({ data: [], error: null }),
      supabase.from('transport_request_events').select('id, action, created_at, previous_state, next_state').eq('request_id', request.id).order('created_at', { ascending: false })
    ])
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

    if (!newRequest.contract_id || !contracts.some(c => c.id === newRequest.contract_id)) {
      toast.error('Selecciona una OT madre activa.')
      return
    }
    const selected = componentOptions.filter(c => selectedComponents[c.contract_id])
    if (!selected.length) { toast.error('Selecciona al menos un componente.'); return }
    const destinations = new Set(selected.map(c => c.destination_address?.trim().toLowerCase()).filter(Boolean))
    if (destinations.size > 1 && !destinationAcknowledged) {
      toast.error('Confirma el destino principal o separa la solicitud.')
      return
    }
    const rootBalance = rootBudget?.balance_pen
    if (!Number.isFinite(estimatedCost) || estimatedCost < 0 ||
        (estimatedCost > 0 && estimatedCost > Number(rootBalance || 0))) {
      toast.error('El costo estimado supera el saldo de la OT raíz.')
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
      const { error } = await supabase.rpc('save_transport_request', {
        p_request_id: editingRequestId,
        p_payload: { ...newRequest, destination_acknowledged: destinationAcknowledged },
        p_components: selected.map(c => ({
          contract_id: c.contract_id,
          weight_kg: selectedComponents[c.contract_id].weight_kg || null,
          volume_m3: selectedComponents[c.contract_id].volume_m3 || null
        }))
      })
      if (error) throw error

      toast.success('Solicitud enviada correctamente')
      setIsModalOpen(false)
      setNewRequest(prev => ({
        ...prev, 
        department: '',
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
      
      toast.success(`Solicitud ${newStatus.toLowerCase()}`)
      fetchRequests()
    } catch (error: unknown) {
      toast.error('Error al actualizar estado: ' + errorMessage(error))
    }
  }

  const handleCancelRequest = async (id: string) => {
    if (!confirm('¿Estás seguro de cancelar esta solicitud? Las solicitudes programadas deben retirarse desde Despacho.')) return;
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
      const { error } = await supabase.rpc('set_transport_request_status', {
        p_request_id: selectedRequestId,
        p_new_status: 'REPROGRAMADA', p_required_date: newRescheduleDate
      })
        
      if (error) throw error;
      
      toast.success('Solicitud reprogramada exitosamente.');
      setIsRescheduleModalOpen(false);
      fetchRequests();
    } catch (err: unknown) {
      toast.error('Error al reprogramar: ' + errorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  const getStatusBadge = (status: string) => {
    switch(status) {
      case 'PENDIENTE DE APROBACIÓN':
      case 'PENDIENTE':
        return <span className="bg-yellow-100 text-yellow-800 px-2 py-1 rounded text-xs font-semibold">Pendiente de Aprobación</span>
      case 'APROBADA':
      case 'APROBADO':
        return <span className="bg-green-100 text-green-800 px-2 py-1 rounded text-xs font-semibold">Aprobada</span>
      case 'RECHAZADA':
        return <span className="bg-red-100 text-red-800 px-2 py-1 rounded text-xs font-semibold">Rechazada</span>
      case 'CANCELADA':
        return <span className="bg-slate-200 text-slate-600 px-2 py-1 rounded text-xs font-semibold line-through">Cancelada</span>
      case 'REPROGRAMADA':
        return <span className="bg-orange-100 text-orange-800 px-2 py-1 rounded text-xs font-semibold">Reprogramada</span>
      default:
        return <span className="bg-slate-100 text-slate-800 px-2 py-1 rounded text-xs font-semibold">{status}</span>
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-4 mx-auto">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Solicitudes de Transporte</h1>
          <p className="text-sm text-slate-500">Gestión de requerimientos internos de servicio</p>
        </div>
        {canWrite('solicitudes') && (
          <button 
            onClick={() => {
              if (contracts.length === 0) fetchContracts()
              setEditingRequestId(null)
              setContractSearch('')
              setComponentOptions([])
              setSelectedComponents({})
              setDestinationAcknowledged(false)
              componentLoadId.current++
              setNewRequest({
                requester_name: newRequest.requester_name,
                department: '',
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

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase">Total (Mes)</p>
            <p className="text-2xl font-bold text-[#002855]">{requests.length}</p>
          </div>
          <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center">
            <Activity className="w-5 h-5 text-blue-500" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase">Aprobadas</p>
            <p className="text-2xl font-bold text-green-600">{requests.filter(r => r.status === 'APROBADA' || r.status === 'EN_TRANSITO').length}</p>
          </div>
          <div className="w-10 h-10 rounded-full bg-green-50 flex items-center justify-center">
            <Check className="w-5 h-5 text-green-500" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase">Reprogramadas</p>
            <p className="text-2xl font-bold text-orange-600">{requests.filter(r => r.status === 'REPROGRAMADA').length}</p>
          </div>
          <div className="w-10 h-10 rounded-full bg-orange-50 flex items-center justify-center">
            <CalendarClock className="w-5 h-5 text-orange-500" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase">Canceladas</p>
            <p className="text-2xl font-bold text-slate-600">{requests.filter(r => r.status === 'CANCELADA').length}</p>
          </div>
          <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center">
            <Ban className="w-5 h-5 text-slate-500" />
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
          <div className="relative w-72">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input 
              type="text" 
              placeholder="Buscar por código o solicitante..." 
              value={searchTerm}
              onChange={event => setSearchTerm(event.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-white text-slate-900 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#002855]"
            />
          </div>
          <button onClick={() => setShowFilters(value => !value)} className="flex items-center gap-2 px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100">
            <Filter className="w-4 h-4" />
            Filtrar
          </button>
        </div>
        {showFilters && <div className="flex flex-wrap gap-3 p-4 border-b border-slate-200 bg-slate-50 text-sm">
          <label>Estado <select value={filterStatus} onChange={event => setFilterStatus(event.target.value)} className="ml-2 border rounded p-1 bg-white">
            {['TODOS', 'PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'APROBADA', 'REPROGRAMADA', 'RECHAZADA', 'CANCELADA', 'ASIGNADA'].map(status => <option key={status} value={status}>{status}</option>)}
          </select></label>
          <label>Desde <input type="date" value={filterDateFrom} onChange={event => setFilterDateFrom(event.target.value)} className="ml-2 border rounded p-1 bg-white" /></label>
          <label>Hasta <input type="date" value={filterDateTo} onChange={event => setFilterDateTo(event.target.value)} className="ml-2 border rounded p-1 bg-white" /></label>
        </div>}

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <table className="relative w-full table-fixed border-collapse text-left">
            <colgroup>
              <col className="w-[15%]" />
              <col className="w-[13%]" />
              <col className="w-[13%]" />
              <col className="hidden xl:table-column w-[13%]" />
              <col className="hidden 2xl:table-column w-[12%]" />
              <col className="w-[16%]" />
              <col className="hidden xl:table-column w-[14%]" />
              <col className="w-[14%]" />
              <col className="w-[15%]" />
            </colgroup>
            <thead className="sticky top-0 z-10 shadow-[0_1px_0_0_#e2e8f0]">
              <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
                <th className="p-3 font-semibold">Código / Emisión</th>
                <th className="p-3 font-semibold">Fecha / Ventana</th>
                <th className="p-3 font-semibold">OT / Contrato</th>
                <th className="hidden p-3 font-semibold xl:table-cell">Cliente</th>
                <th className="hidden p-3 font-semibold 2xl:table-cell">Origen</th>
                <th className="p-3 font-semibold">Destino</th>
                <th className="hidden p-3 font-semibold xl:table-cell">Carga</th>
                <th className="p-3 font-semibold">Estado</th>
                <th className="sticky right-0 z-20 bg-slate-50 p-3 text-right font-semibold shadow-[-6px_0_8px_-8px_rgba(15,23,42,0.45)]">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={9} className="p-8 text-center text-slate-500">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                    Cargando solicitudes...
                  </td>
                </tr>
              ) : filteredRequests.length === 0 ? (
                <tr>
                  <td colSpan={9} className="p-8 text-center text-slate-500">
                    No hay solicitudes para los filtros seleccionados.
                  </td>
                </tr>
              ) : (
                filteredRequests.map(req => (
                  <tr key={req.id} className="hover:bg-slate-50 transition-colors">
                    <td className="p-3">
                      <div className="flex flex-col">
                        <button 
                          onClick={() => void openRequestDetails(req)}
                          className="font-bold text-[#002855] text-sm text-left hover:underline hover:text-blue-600 transition-all"
                        >
                          {req.request_number}
                        </button>
                        <span className="text-[10px] text-slate-400 font-medium whitespace-nowrap mt-0.5">
                          Emitido: {new Date(req.created_at).toLocaleDateString('es-PE', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })}
                        </span>
                      </div>
                    </td>
                    <td className="p-3 text-sm">
                      <div className="flex flex-col">
                        <span className="flex items-center gap-1 font-semibold text-[#002855]">
                          <Calendar className="w-3 h-3 text-slate-400" />
                          {(() => { const [y,m,d] = req.required_date.split('T')[0].split('-'); return `${d}/${m}/${y}`; })()}
                        </span>
                        {req.time_window && (
                          <span className="flex items-center gap-1 text-[11px] font-bold text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded w-fit mt-1">
                            <Clock className="w-3 h-3" />
                            {req.time_window}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-3">
                      <div className="flex flex-col">
                        {req.contracts?.code ? (
                          <span className="font-bold text-[#002855] text-sm">{req.contracts.code}</span>
                        ) : req.purchase_order ? (
                          <span className="font-medium text-slate-700 text-sm">{req.purchase_order}</span>
                        ) : (
                          <span className="text-slate-400 text-sm">-</span>
                        )}
                      </div>
                    </td>
                    <td className="hidden p-3 xl:table-cell">
                      {req.contracts?.clients?.business_name ? (
                        <span className="text-sm font-medium text-[#002855]">{req.contracts.clients.business_name}</span>
                      ) : (
                        <span className="text-sm text-slate-400">-</span>
                      )}
                    </td>
                    <td className="hidden p-3 2xl:table-cell">
                      <span className="text-sm text-slate-800 block truncate" title={req.pickup_address}>
                        {req.pickup_address || '-'}
                      </span>
                    </td>
                    <td className="p-3">
                      <span className="text-sm text-slate-800 block truncate" title={req.delivery_address}>
                        {req.delivery_address || '-'}
                      </span>
                    </td>
                    <td className="hidden p-3 text-sm xl:table-cell">
                      <div className="flex flex-col gap-1">
                        {req.cargo_description && (
                          <div className="text-xs text-slate-700 font-medium truncate" title={req.cargo_description}>
                            Glosa: {req.cargo_description}
                          </div>
                        )}
                        {req.estimated_weight > 0 && (
                          <div className="text-[10px] text-slate-400 font-medium">
                            {req.estimated_weight} KG | {req.estimated_volume} M3 Estimados
                          </div>
                        )}
                        <span className="text-[10px] text-slate-500">{req.transport_request_components?.length || 0} componentes</span>
                        <span className="text-[10px] text-slate-500">Costo estimado: S/ {Number(req.service_cost || 0).toLocaleString('es-PE')}</span>
                        <span className="text-[10px] text-slate-500">Viajes: {requestSummaries[req.id]?.dispatch_count ?? '—'}</span>
                      </div>
                    </td>
                    <td className="p-3">
                      {getStatusBadge(req.status)}
                    </td>
                    <td className="sticky right-0 z-10 bg-white p-2 text-right shadow-[-6px_0_8px_-8px_rgba(15,23,42,0.45)]">
                      {(req.status === 'PENDIENTE DE APROBACIÓN' || req.status === 'PENDIENTE' || req.status === 'REPROGRAMADA') && canWrite('despacho') && (
                        <div className="flex justify-end gap-2 mb-2">
                          <button 
                            onClick={() => updateStatus(req.id, 'APROBADA')}
                            title="Aprobar"
                            className="p-1.5 text-green-600 bg-green-50 hover:bg-green-100 transition-colors rounded border border-green-200"
                          >
                            <Check className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={() => updateStatus(req.id, 'RECHAZADA')}
                            title="Rechazar"
                            className="p-1.5 text-red-600 bg-red-50 hover:bg-red-100 transition-colors rounded border border-red-200"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                      {canWrite('solicitudes') && (req.status === 'PENDIENTE DE APROBACIÓN' || req.status === 'PENDIENTE' || req.status === 'REPROGRAMADA' || req.status === 'APROBADA') && (
                        <div className="flex justify-end gap-2 mt-1">
                          <button 
                            onClick={() => openEditModal(req)}
                            title="Editar Solicitud"
                            className="p-1.5 text-blue-600 bg-blue-50 hover:bg-blue-100 transition-colors rounded border border-blue-200"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={() => {
                              setSelectedRequestId(req.id)
                              setNewRescheduleDate(req.required_date.split('T')[0] || '')
                              setIsRescheduleModalOpen(true)
                            }}
                            title="Reprogramar Fecha"
                            className="p-1.5 text-orange-600 bg-orange-50 hover:bg-orange-100 transition-colors rounded border border-orange-200"
                          >
                            <CalendarClock className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={() => handleCancelRequest(req.id)}
                            title="Cancelar Solicitud"
                            className="p-1.5 text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors rounded border border-slate-300"
                          >
                            <Ban className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
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
            
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">OT / Proyecto asociado *</label>
              <input
                type="text"
                list="mother-ots"
                required
                placeholder="Buscar OT madre por código..."
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                value={contractSearch}
                onChange={(e) => {
                  const value = e.target.value
                  setContractSearch(value)
                  const selected = contracts.find(c => c.code === value)
                  if (selected && selected.id !== newRequest.contract_id) handleContractChange(selected.id)
                  else if (newRequest.contract_id) {
                    if (Object.keys(selectedComponents).length) toast.info('Se limpiaron los componentes al cambiar de OT.')
                    setNewRequest(prev => ({ ...prev, contract_id: '' }))
                    setSelectedComponents({})
                    setComponentOptions([])
                    setDestinationAcknowledged(false)
                    componentLoadId.current++
                  }
                }}
              />
              <datalist id="mother-ots">
                {contracts.map(c => <option key={c.id} value={c.code}>{(Array.isArray(c.clients) ? c.clients[0]?.business_name : c.clients?.business_name) || c.type}</option>)}
              </datalist>
              {newRequest.contract_id && componentOptions.length > 0 && (() => {
                const root = componentOptions.find(c => c.contract_id === newRequest.contract_id)
                return root && <p className="mt-1 text-xs text-slate-600">
                  Partida OT raíz: S/ {Number(root.allocated_pen || 0).toLocaleString('es-PE')} ·
                  Saldo: S/ {Number(root.balance_pen || 0).toLocaleString('es-PE')}
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
                <label className="block text-sm font-medium text-slate-700 mb-1">Costo estimado del transporte (S/) · opcional</label>
                <input type="number" min="0" step="0.01" placeholder="0.00"
                  className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg"
                  value={newRequest.service_cost}
                  onChange={e => setNewRequest({ ...newRequest, service_cost: e.target.value })} />
                <p className="text-xs text-slate-500 mt-1">Es una estimación; la reserva de presupuesto ocurre al programar el despacho.</p>
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
              disabled={isSubmitting || componentsLoading || !newRequest.contract_id || selectedOptions.length === 0}
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
        onClose={() => setSelectedRequestDetails(null)}
        title={`Solicitud ${selectedRequestDetails?.request_number || ''}`}
        maxWidth="max-w-2xl"
      >
        {selectedRequestDetails && <div className="space-y-5 text-sm text-slate-700">
          <div className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-4">
            <div><span className="block text-xs text-slate-500">OT madre</span><strong>{selectedRequestDetails.contracts?.code || 'Sin OT identificada'}</strong></div>
            <div><span className="block text-xs text-slate-500">Estado</span>{getStatusBadge(selectedRequestDetails.status)}</div>
            <div><span className="block text-xs text-slate-500">Solicitante</span>{selectedRequestDetails.requester_name}</div>
            <div><span className="block text-xs text-slate-500">Fecha requerida</span>{selectedRequestDetails.required_date?.split('T')[0] || 'Sin fecha'}</div>
            <div><span className="block text-xs text-slate-500">Origen</span>{selectedRequestDetails.pickup_address || 'Sin origen'}</div>
            <div><span className="block text-xs text-slate-500">Destino</span>{selectedRequestDetails.delivery_address || 'Sin destino'}</div>
          </div>
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
            <div><span className="block text-xs text-slate-500">Peso de cabecera</span><strong>{Number(selectedRequestDetails.estimated_weight || 0).toLocaleString('es-PE')} kg</strong></div>
            <div><span className="block text-xs text-slate-500">Volumen de cabecera</span><strong>{Number(selectedRequestDetails.estimated_volume || 0).toLocaleString('es-PE')} m³</strong></div>
            <div><span className="block text-xs text-slate-500">Costo estimado, una vez por solicitud</span><strong>S/ {Number(selectedRequestDetails.service_cost || 0).toLocaleString('es-PE')}</strong></div>
            <div><span className="block text-xs text-slate-500">Partida OT raíz</span><strong>{requestSummaries[selectedRequestDetails.id]?.root_allocated_pen == null ? 'Sin registrar' : `S/ ${Number(requestSummaries[selectedRequestDetails.id].root_allocated_pen).toLocaleString('es-PE')}`}</strong></div>
            <div><span className="block text-xs text-slate-500">Saldo actual OT raíz</span><strong>{requestSummaries[selectedRequestDetails.id]?.root_balance_pen == null ? 'Sin registrar' : `S/ ${Number(requestSummaries[selectedRequestDetails.id].root_balance_pen).toLocaleString('es-PE')}`}</strong></div>
          </div>
          <div><h3 className="font-semibold text-slate-900 mb-1">Viajes vinculados</h3>
            <p>{requestSummaries[selectedRequestDetails.id] ?
              (requestSummaries[selectedRequestDetails.id].dispatch_numbers.join(', ') || 'Sin viajes vinculados') :
              'Resumen de viajes no disponible'}</p>
          </div>
          <div>
            <h3 className="font-semibold text-slate-900 mb-2">Historial</h3>
            {detailEvents.length ? <div className="space-y-2">{detailEvents.map(event => <details key={event.id} className="rounded border border-slate-200 p-3">
              <summary className="cursor-pointer">{event.action === 'CREATED' ? 'Creada' : event.action === 'UPDATED' ? 'Actualizada' : 'Estado cambiado'} · {new Date(event.created_at).toLocaleString('es-PE')}</summary>
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
