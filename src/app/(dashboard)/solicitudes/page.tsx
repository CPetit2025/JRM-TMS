"use client"
import { useState, useEffect } from 'react'
import { Plus, Send, Check, X, Search, Filter, Loader2, Calendar, Clock, CalendarClock, Ban, Activity, Edit2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { usePermissions } from '@/hooks/usePermissions'

interface TransportRequest {
  id: string
  request_number: string
  requester_name: string
  department: string
  pickup_address: string
  delivery_address: string
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
  contracts?: {
    code: string
    clients?: {
      business_name: string
    }
  }
}

interface WorkOrder {
  id: string
  ot_number: string
  location?: string
  destination_address?: string
  budget_amount?: number
  consumed_budget?: number
}

interface Contract {
  id: string
  code: string
  type: string
  status: string
  balance_pen: number
  destination_address?: string
  destination_department?: string
  destination_province?: string
  destination_district?: string
  clients?: {
    business_name: string
  }
}

export default function SolicitudesPage() {
  const { canWrite } = usePermissions()
  const supabase = createClient()
  
  const [requests, setRequests] = useState<TransportRequest[]>([])
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([])
  const [contracts, setContracts] = useState<Contract[]>([])
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
    purchase_order: ''
  })
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null)

  useEffect(() => {
    fetchRequests()
    fetchWorkOrders()
    fetchContracts()
    checkUser()
  }, [])

  const checkUser = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('first_name, last_name, roles(name)')
        .eq('id', user.id)
        .single()
      
      if (profile) {
        setNewRequest(prev => ({...prev, requester_name: `${profile.first_name} ${profile.last_name}`}))
        const roleName = Array.isArray(profile.roles) ? profile.roles[0]?.name : (profile.roles as any)?.name
        if (roleName) {
          setUserRole(roleName.toLowerCase())
        }
      }
    }
  }

  const fetchRequests = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('transport_requests')
        .select(`
          *,
          contracts(
            code,
            clients(business_name)
          )
        `)
        .order('created_at', { ascending: false })

      if (error) throw error
      setRequests(data || [])
    } catch (error: any) {
      toast.error('Error al cargar solicitudes: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  const fetchWorkOrders = async () => {
    try {
      const { data, error } = await supabase
        .from('work_orders')
        .select('id, ot_number, destination_address, budget_amount')

      if (error) throw error
      
      const formatted = (data || []).map(ot => {
        return {
          id: ot.id,
          ot_number: ot.ot_number,
          destination_address: ot.destination_address,
          budget_amount: Number(ot.budget_amount) || 0,
          consumed_budget: 0
        }
      })
      setWorkOrders(formatted)
    } catch (error: any) {
      console.error('Error al cargar OTs:', error.message || error)
    }
  }

  const fetchContracts = async () => {
    try {
      const { data, error } = await supabase
        .from('contracts')
        .select(`
          id, code, type, status,
          destination_address, destination_department, destination_province, destination_district,
          clients ( business_name ),
          contract_budgets (
            balance_pen
          )
        `)
        .eq('status', 'ACTIVO')

      if (error) throw error
      
      const formatted = (data || []).map((c: any) => ({
        id: c.id,
        code: c.code,
        type: c.type,
        status: c.status,
        destination_address: c.destination_address,
        destination_department: c.destination_department,
        destination_province: c.destination_province,
        destination_district: c.destination_district,
        clients: c.clients,
        balance_pen: Number(c.contract_budgets?.[0]?.balance_pen) || 0
      }))
      setContracts(formatted)
    } catch (error: any) {
      console.error('Error al cargar contratos:', error.message)
    }
  }

  const handleContractChange = (contractId: string) => {
    const selectedContract = contracts.find(c => c.id === contractId)
    setNewRequest(prev => {
      let updated = { ...prev, contract_id: contractId }
      
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
    setNewRequest({
      requester_name: request.requester_name,
      department: request.department,
      request_type: request.request_type,
      pickup_address: request.pickup_address,
      pickup_department: (request as any).pickup_department || '',
      pickup_province: (request as any).pickup_province || '',
      pickup_district: (request as any).pickup_district || '',
      delivery_address: request.delivery_address,
      delivery_department: (request as any).delivery_department || '',
      delivery_province: (request as any).delivery_province || '',
      delivery_district: (request as any).delivery_district || '',
      required_date: request.required_date ? request.required_date.split('T')[0] : '',
      time_window: request.time_window || '',
      contract_id: request.contract_id || '',
      cargo_description: request.cargo_description || '',
      estimated_weight: request.estimated_weight ? request.estimated_weight.toString() : '',
      estimated_volume: request.estimated_volume ? request.estimated_volume.toString() : '',
      purchase_order: request.purchase_order || ''
    })

    setEditingRequestId(request.id)
    setIsModalOpen(true)
  }

  const handleCreateRequest = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!newRequest.cargo_description || !newRequest.cargo_description.trim()) {
      toast.error('Debes ingresar la descripción general de la carga.')
      return
    }

    const isOTDepartment = newRequest.department === 'OT (Administración de Contratos)' || newRequest.department.startsWith('OT -');

    if (isOTDepartment) {
      if (!newRequest.contract_id) {
        toast.error('Para este departamento, es OBLIGATORIO seleccionar un Contrato/OT.')
        return
      }
      
      // Validar saldo
      const selectedContract = contracts.find(c => c.id === newRequest.contract_id)
      if (selectedContract && selectedContract.balance_pen <= 0) {
        toast.error(`El contrato ${selectedContract.code} tiene saldo agotado o negativo. No se pueden generar más solicitudes.`)
        return
      }
    }

    setIsSubmitting(true)
    const requestNumber = `SOL-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`

    try {
      const finalDepartment = newRequest.department === 'OT (Administración de Contratos)' && newRequest.contract_id
        ? `OT - ${newRequest.contract_id}`
        : newRequest.department;

      const totalWeight = newRequest.estimated_weight ? parseFloat(newRequest.estimated_weight) : 0;
      const totalVolume = newRequest.estimated_volume ? parseFloat(newRequest.estimated_volume) : 0;

      if (editingRequestId) {
        const { error: updateError } = await supabase
          .from('transport_requests')
          .update({
            requester_name: newRequest.requester_name,
            department: finalDepartment,
            pickup_address: newRequest.pickup_address,
            pickup_department: newRequest.pickup_department,
            pickup_province: newRequest.pickup_province,
            pickup_district: newRequest.pickup_district,
            delivery_address: newRequest.delivery_address,
            delivery_department: newRequest.delivery_department,
            delivery_province: newRequest.delivery_province,
            delivery_district: newRequest.delivery_district,
            required_date: newRequest.required_date,
            time_window: newRequest.time_window,
            cargo_description: newRequest.cargo_description,
            estimated_weight: totalWeight,
            estimated_volume: totalVolume,
            request_type: newRequest.request_type,
            contract_id: newRequest.contract_id || null,
            purchase_order: newRequest.purchase_order || null
          })
          .eq('id', editingRequestId)
          
        if (updateError) throw updateError
        
      } else {
        const { error: requestError } = await supabase
          .from('transport_requests')
          .insert([{ 
            request_number: requestNumber,
            requester_name: newRequest.requester_name,
            department: finalDepartment,
            pickup_address: newRequest.pickup_address,
            pickup_department: newRequest.pickup_department,
            pickup_province: newRequest.pickup_province,
            pickup_district: newRequest.pickup_district,
            delivery_address: newRequest.delivery_address,
            delivery_department: newRequest.delivery_department,
            delivery_province: newRequest.delivery_province,
            delivery_district: newRequest.delivery_district,
            required_date: newRequest.required_date,
            time_window: newRequest.time_window,
            cargo_description: newRequest.cargo_description,
            estimated_weight: totalWeight,
            estimated_volume: totalVolume,
            request_type: newRequest.request_type,
            contract_id: newRequest.contract_id || null,
            purchase_order: newRequest.purchase_order || null,
            status: 'PENDIENTE DE APROBACIÓN'
          }])

        if (requestError) throw requestError
      }

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
        purchase_order: ''
      }))
      fetchRequests()
    } catch (error: any) {
      toast.error('Error al enviar solicitud: ' + error.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const updateStatus = async (id: string, newStatus: string) => {
    try {
      const { error } = await supabase
        .from('transport_requests')
        .update({ status: newStatus })
        .eq('id', id)

      if (error) throw error
      
      toast.success(`Solicitud ${newStatus.toLowerCase()}`)
      fetchRequests()
    } catch (error: any) {
      toast.error('Error al actualizar estado: ' + error.message)
    }
  }

  const handleCancelRequest = async (id: string) => {
    if (!confirm('¿Estás seguro de cancelar esta solicitud? Si ya estaba en un despacho, será retirada.')) return;
    try {
      await supabase.from('dispatch_requests').delete().eq('transport_request_id', id);
      
      const { error } = await supabase.from('transport_requests').update({ status: 'CANCELADA' }).eq('id', id);
      if (error) throw error;
      
      toast.success('Solicitud cancelada exitosamente.');
      fetchRequests();
    } catch (err: any) {
      toast.error('Error al cancelar: ' + err.message);
    }
  }

  const handleRescheduleRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRequestId || !newRescheduleDate) return;
    
    try {
      setIsSubmitting(true);
      const { error } = await supabase
        .from('transport_requests')
        .update({ 
          status: 'REPROGRAMADA', 
          required_date: newRescheduleDate 
        })
        .eq('id', selectedRequestId);
        
      if (error) throw error;
      
      toast.success('Solicitud reprogramada exitosamente.');
      setIsRescheduleModalOpen(false);
      fetchRequests();
    } catch (err: any) {
      toast.error('Error al reprogramar: ' + err.message);
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
    <div className="space-y-6 w-full mx-auto">
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

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
          <div className="relative w-72">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input 
              type="text" 
              placeholder="Buscar por código o solicitante..." 
              className="w-full pl-9 pr-4 py-2 bg-white text-slate-900 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#002855]"
            />
          </div>
          <button className="flex items-center gap-2 px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100">
            <Filter className="w-4 h-4" />
            Filtrar
          </button>
        </div>

        <div className="overflow-auto max-h-[calc(100vh-220px)]">
          <table className="w-full text-left border-collapse relative">
            <thead className="sticky top-0 z-10 shadow-[0_1px_0_0_#e2e8f0]">
              <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
                <th className="p-4 font-semibold whitespace-nowrap">Código / Emisión</th>
                <th className="p-4 font-semibold whitespace-nowrap">Fecha Req. / Ventana</th>
                <th className="p-4 font-semibold whitespace-nowrap">OT / Contrato</th>
                <th className="p-4 font-semibold">Cliente</th>
                <th className="p-4 font-semibold">Origen</th>
                <th className="p-4 font-semibold">Destino</th>
                <th className="p-4 font-semibold">Carga</th>
                <th className="p-4 font-semibold">Estado</th>
                <th className="p-4 font-semibold text-right">Acciones</th>
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
              ) : requests.length === 0 ? (
                <tr>
                  <td colSpan={9} className="p-8 text-center text-slate-500">
                    No hay solicitudes registradas.
                  </td>
                </tr>
              ) : (
                requests.map(req => (
                  <tr key={req.id} className="hover:bg-slate-50 transition-colors">
                    <td className="p-4">
                      <div className="flex flex-col">
                        <button 
                          onClick={() => setSelectedRequestDetails(req)}
                          className="font-bold text-[#002855] text-sm text-left hover:underline hover:text-blue-600 transition-all"
                        >
                          {req.request_number}
                        </button>
                        <span className="text-[10px] text-slate-500 font-medium whitespace-nowrap mt-0.5">
                          {new Date(req.created_at).toLocaleString()}
                        </span>
                      </div>
                    </td>
                    <td className="p-4 text-sm text-slate-600">
                      <div className="flex flex-col">
                        <span className="flex items-center gap-1 font-semibold text-[#002855]">
                          <Calendar className="w-3 h-3 text-slate-400" />
                          {new Date(req.required_date).toLocaleDateString()}
                        </span>
                        {req.time_window && (
                          <span className="flex items-center gap-1 text-[11px] font-bold text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded w-fit mt-1">
                            <Clock className="w-3 h-3" />
                            {req.time_window}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-4">
                      <div className="flex flex-col">
                        {req.purchase_order ? (
                          <span className="font-bold text-slate-700 text-sm">{req.purchase_order}</span>
                        ) : (
                          <span className="text-slate-400 text-sm">-</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      {req.contracts?.clients?.business_name ? (
                        <span className="text-sm font-medium text-[#002855]">{req.contracts.clients.business_name}</span>
                      ) : (
                        <span className="text-sm text-slate-400">-</span>
                      )}
                    </td>
                    <td className="p-4 max-w-[180px]">
                      <span className="text-sm text-slate-800 block truncate" title={req.pickup_address}>
                        {req.pickup_address || '-'}
                      </span>
                    </td>
                    <td className="p-4 max-w-[180px]">
                      <span className="text-sm text-slate-800 block truncate" title={req.delivery_address}>
                        {req.delivery_address || '-'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm max-w-[250px]">
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
                      </div>
                    </td>
                    <td className="p-4">
                      {getStatusBadge(req.status)}
                    </td>
                    <td className="p-4 text-right">
                      {(req.status === 'PENDIENTE DE APROBACIÓN' || req.status === 'PENDIENTE') && (userRole.includes('admin') || userRole.includes('supervisor') || userRole.includes('despacho') || userRole.includes('transporte')) && (
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
                      {canWrite('solicitudes') && (req.status === 'PENDIENTE DE APROBACIÓN' || req.status === 'PENDIENTE' || req.status === 'APROBADA') && (
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
                  setNewRequest({...newRequest, department: e.target.value, contract_id: ''})
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
            
            {newRequest.department === 'OT (Administración de Contratos)' && (
              <div className="col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Contrato / OT Asociada (Buscar y Seleccionar) *</label>
                <div className="relative">
                  <input
                    type="text"
                    list="contracts-list"
                    required
                    placeholder="Escriba el código o seleccione de la lista..."
                    className="w-full px-3 py-2 bg-yellow-50 text-slate-900 border border-yellow-300 rounded-lg focus:ring-2 focus:ring-yellow-500 outline-none"
                    value={(newRequest as any).contract_code_input !== undefined ? (newRequest as any).contract_code_input : (contracts.find(c => c.id === newRequest.contract_id)?.code || '')}
                    onChange={(e) => {
                      const val = e.target.value
                      const matched = contracts.find(c => c.code === val)
                      if (matched) {
                        setNewRequest(prev => {
                          let updated = { ...prev, contract_id: matched.id, contract_code_input: val }
                          if (prev.request_type === 'DESPACHO') {
                            updated.delivery_address = matched.destination_address || ''
                            updated.delivery_department = matched.destination_department || ''
                            updated.delivery_province = matched.destination_province || ''
                            updated.delivery_district = matched.destination_district || ''
                          }
                          return updated
                        })
                      } else {
                        setNewRequest(prev => ({ ...prev, contract_id: '', contract_code_input: val }))
                      }
                    }}
                  />
                  <datalist id="contracts-list">
                    {contracts.map(c => (
                      <option key={c.id} value={c.code}>{c.type} - {c.clients?.business_name}</option>
                    ))}
                  </datalist>
                </div>
                {newRequest.contract_id && (
                  <div className={`mt-1.5 flex items-center gap-1.5 text-xs font-semibold ${(contracts.find(c => c.id === newRequest.contract_id)?.balance_pen || 0) <= 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                    {(contracts.find(c => c.id === newRequest.contract_id)?.balance_pen || 0) <= 0 ? (
                      <>
                        <Ban className="w-3.5 h-3.5" />
                        Partida Agotada o Negativa (S/ {(contracts.find(c => c.id === newRequest.contract_id)?.balance_pen || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })})
                      </>
                    ) : (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        Partida Disponible: S/ {(contracts.find(c => c.id === newRequest.contract_id)?.balance_pen || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
            {newRequest.department !== 'OT (Administración de Contratos)' && (
              <div className="col-span-2 mt-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">¿Asociar a Contrato/OT? (Opcional, Buscar y Seleccionar)</label>
                <div className="relative">
                  <input
                    type="text"
                    list="contracts-list-optional"
                    placeholder="Escriba el código o seleccione de la lista..."
                    className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                    value={(newRequest as any).contract_code_input !== undefined ? (newRequest as any).contract_code_input : (contracts.find(c => c.id === newRequest.contract_id)?.code || '')}
                    onChange={(e) => {
                      const val = e.target.value
                      const matched = contracts.find(c => c.code === val)
                      if (matched) {
                        setNewRequest(prev => {
                          let updated = { ...prev, contract_id: matched.id, contract_code_input: val }
                          if (prev.request_type === 'DESPACHO') {
                            updated.delivery_address = matched.destination_address || ''
                            updated.delivery_department = matched.destination_department || ''
                            updated.delivery_province = matched.destination_province || ''
                            updated.delivery_district = matched.destination_district || ''
                          }
                          return updated
                        })
                      } else {
                        setNewRequest(prev => ({ ...prev, contract_id: '', contract_code_input: val }))
                      }
                    }}
                  />
                  <datalist id="contracts-list-optional">
                    {contracts.map(c => (
                      <option key={c.id} value={c.code}>{c.type} - {c.clients?.business_name}</option>
                    ))}
                  </datalist>
                </div>
                {newRequest.contract_id && (
                  <div className={`mt-1.5 flex items-center gap-1.5 text-xs font-semibold ${(contracts.find(c => c.id === newRequest.contract_id)?.balance_pen || 0) <= 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                    {(contracts.find(c => c.id === newRequest.contract_id)?.balance_pen || 0) <= 0 ? (
                      <>
                        <Ban className="w-3.5 h-3.5" />
                        Partida Agotada o Negativa (S/ {(contracts.find(c => c.id === newRequest.contract_id)?.balance_pen || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })})
                      </>
                    ) : (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        Partida Disponible: S/ {(contracts.find(c => c.id === newRequest.contract_id)?.balance_pen || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

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
                <label className="block text-sm font-medium text-slate-700 mb-1">Peso Estimado Total (kg) - Opcional</label>
                <div className="flex gap-2">
                  <input 
                    type="number" 
                    min="0"
                    step="0.01"
                    placeholder="Peso (KG)"
                    className="w-1/2 px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newRequest.estimated_weight}
                    onChange={(e) => setNewRequest({...newRequest, estimated_weight: e.target.value})}
                  />
                  <input 
                    type="number" 
                    min="0"
                    step="0.01"
                    placeholder="Volumen (M3)"
                    className="w-1/2 px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newRequest.estimated_volume}
                    onChange={(e) => setNewRequest({...newRequest, estimated_volume: e.target.value})}
                  />
                </div>
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
              disabled={isSubmitting || (newRequest.contract_id ? (contracts.find(c => c.id === newRequest.contract_id)?.balance_pen || 0) <= 0 : false)}
              className="px-4 py-2 bg-[#002855] text-white font-medium rounded-lg hover:bg-[#001d3d] transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {editingRequestId ? "Actualizar Solicitud" : "Enviar Solicitud"}
            </button>
          </div>
        </form>
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
