"use client"
import { useState, useEffect, useRef } from 'react'
import { Truck, MapPin, Loader2, PlayCircle, Calendar, Plus, FileText, ArrowRight, CheckCircle2, DollarSign, Tag, Search, Filter, Save } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { calculateRouteDistance } from '@/lib/routing'
import { usePermissions } from '@/hooks/usePermissions'

interface TransportRequest {
  id: string
  request_number: string
  requester_name: string
  pickup_address: string
  delivery_address: string
  request_type?: string
  status: string
  created_at: string
  required_date?: string
  contract_id?: string
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
    transport_request_items?: Array<{
      weight?: number
      quantity?: number
      volume_m3?: number
    }>
  }
}

interface Dispatch {
  id: string
  dispatch_number: string
  driver_name: string
  vehicle_plate: string
  scheduled_departure: string
  status: string
  estimated_distance_km?: number
  dispatch_requests?: DispatchRequest[]
}

export default function DespachoPage() {
  const { canWrite } = usePermissions()
  const supabase = createClient()
  const [pendingRequests, setPendingRequests] = useState<TransportRequest[]>([])
  const [dispatches, setDispatches] = useState<Dispatch[]>([])
  const [vehicles, setVehicles] = useState<any[]>([])
  const [drivers, setDrivers] = useState<any[]>([])
  
  const alertedDispatches = useRef<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)

  const [searchTerm, setSearchTerm] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filterStatus, setFilterStatus] = useState('TODOS')

  const filteredDispatches = dispatches.filter((d: any) => {
    const matchSearch = searchTerm === '' || 
      d.dispatch_number.toLowerCase().includes(searchTerm.toLowerCase()) || 
      d.vehicle_plate.toLowerCase().includes(searchTerm.toLowerCase()) || 
      d.driver_name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchStatus = filterStatus === 'TODOS' || d.status === filterStatus;
    return matchSearch && matchStatus;
  })
  
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [selectedDispatchDetail, setSelectedDispatchDetail] = useState<Dispatch | null>(null)
  
  // Modal de Documentos
  const [isDocModalOpen, setIsDocModalOpen] = useState(false)
  const [docModalData, setDocModalData] = useState<Dispatch | null>(null)
  const [isSavingDocs, setIsSavingDocs] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [calculatingDistance, setCalculatingDistance] = useState(false)
"use client"
import { useState, useEffect, useRef } from 'react'
import { Truck, MapPin, Loader2, PlayCircle, Calendar, Plus, FileText, ArrowRight, CheckCircle2, DollarSign, Tag, Search, Filter, Save } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { calculateRouteDistance } from '@/lib/routing'
import { usePermissions } from '@/hooks/usePermissions'

interface TransportRequest {
  id: string
  request_number: string
  requester_name: string
  pickup_address: string
  delivery_address: string
  request_type?: string
  status: string
  created_at: string
  required_date?: string
  contract_id?: string
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
    transport_request_items?: Array<{
      weight?: number
      quantity?: number
      volume_m3?: number
    }>
  }
}

interface Dispatch {
  id: string
  dispatch_number: string
  driver_name: string
  vehicle_plate: string
  scheduled_departure: string
  status: string
  estimated_distance_km?: number
  dispatch_requests?: DispatchRequest[]
}

export default function DespachoPage() {
  const { canWrite } = usePermissions()
  const supabase = createClient()
  const [pendingRequests, setPendingRequests] = useState<TransportRequest[]>([])
  const [dispatches, setDispatches] = useState<Dispatch[]>([])
  const [vehicles, setVehicles] = useState<any[]>([])
  const [drivers, setDrivers] = useState<any[]>([])
  
  const alertedDispatches = useRef<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)

  const [searchTerm, setSearchTerm] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filterStatus, setFilterStatus] = useState('TODOS')

  const filteredDispatches = dispatches.filter((d: any) => {
    const matchSearch = searchTerm === '' || 
      d.dispatch_number.toLowerCase().includes(searchTerm.toLowerCase()) || 
      d.vehicle_plate.toLowerCase().includes(searchTerm.toLowerCase()) || 
      d.driver_name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchStatus = filterStatus === 'TODOS' || d.status === filterStatus;
    return matchSearch && matchStatus;
  })
  
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [selectedDispatchDetail, setSelectedDispatchDetail] = useState<Dispatch | null>(null)
  
  // Modal de Documentos
  const [isDocModalOpen, setIsDocModalOpen] = useState(false)
  const [docModalData, setDocModalData] = useState<Dispatch | null>(null)
  const [isSavingDocs, setIsSavingDocs] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [calculatingDistance, setCalculatingDistance] = useState(false)
  const reqDistances = useRef<Record<string, number>>({})

  // Freight rate lookup state
  const [detectedFreightRate, setDetectedFreightRate] = useState<{ rate: number; district: string; zone: string } | null>(null)
  const [loadingRate, setLoadingRate] = useState(false)
  const [manualFreightCost, setManualFreightCost] = useState<string>('')
  const [newDispatch, setNewDispatch] = useState<{
    selected_requests: { id: string, document_number: string, leg_planned_km?: number }[],
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

  const lookupFreightRate = async (plate: string, selectedReqIds: string[]) => {
    if (!plate || selectedReqIds.length === 0) { setDetectedFreightRate(null); return }
    setLoadingRate(true)
    try {
      const selectedReqs = pendingRequests.filter(r => selectedReqIds.includes(r.id))
      const deliveries = selectedReqs.map(r => r.delivery_address).filter(Boolean)
      let found = null
      for (const addr of deliveries) {
        const district = extractDistrict(addr)
        const { data } = await supabase
          .from('freight_rates')
          .select('rate, district, zone')
          .eq('plate_number', plate)
          .ilike('district', district)
          .limit(1)
          .maybeSingle()
        if (data) { found = { rate: data.rate, district: data.district, zone: data.zone }; break }
      }
      setDetectedFreightRate(found)
    } catch (e) {
      setDetectedFreightRate(null)
    } finally {
      setLoadingRate(false)
    }
  }

  useEffect(() => {
    fetchData()

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
      supabase.removeChannel(channel)
    }
  }, [])

  const fetchData = async () => {
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
        .order('created_at', { ascending: false })

      if (reqError) throw reqError
      setPendingRequests(reqData || [])

      // 2. Obtener los despachos ya programados con sus múltiples solicitudes
      // Ahora usamos dispatch_requests
      const { data: dispatchData, error: dispatchError } = await supabase
        .from('dispatches')
        .select(`
          id, dispatch_number, driver_name, vehicle_plate, scheduled_departure, status, estimated_distance_km,
          dispatch_requests (
            transport_request_id,
            status,
            document_type,
            document_number,
            transport_requests (
              id,
              request_number,
              request_type,
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
        .in('status', ['PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'RETORNO', 'ESPERANDO_AUTORIZACION'])
        .order('created_at', { ascending: false })

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
      const { data: vData } = await supabase.from('vehicles').select('plate, brand, model, carriers(business_name)').eq('status', 'DISPONIBLE')
      const { data: dData } = await supabase.from('drivers').select('first_name, last_name, document_number, carriers(business_name)')
      
      setVehicles(vData || [])
      setDrivers(dData || [])

    } catch (error: any) {
      toast.error('Error al cargar datos de despacho: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSaveDocuments = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!docModalData || !docModalData.dispatch_requests) return
    setIsSavingDocs(true)
    
    try {
      for (const req of docModalData.dispatch_requests) {
        if (!req.document_number?.trim()) {
          toast.error('Todos los documentos deben estar completos.')
          setIsSavingDocs(false)
          return
        }
      }

      for (const req of docModalData.dispatch_requests) {
        const { error } = await supabase
          .from('dispatch_requests')
          .update({ document_number: req.document_number })
          .eq('dispatch_id', docModalData.id)
          .eq('transport_request_id', req.transport_request_id)
        if (error) throw error
      }

      toast.success('Documentos vinculados correctamente')
      setIsDocModalOpen(false)
      fetchData()
    } catch (error: any) {
      toast.error('Error al guardar documentos: ' + error.message)
    } finally {
      setIsSavingDocs(false)
    }
  }

  const handleProgramar = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newDispatch.selected_requests.length === 0) {
      toast.error('Debes seleccionar al menos una solicitud.')
      return
    }

    // (Validación de documentos removida)

    // Validar saldo del contrato de las solicitudes seleccionadas
    const selectedReqsFull = pendingRequests.filter(pr => newDispatch.selected_requests.some(sr => sr.id === pr.id))
    for (const req of selectedReqsFull) {
      if (req.contracts && req.contracts.contract_budgets && req.contracts.contract_budgets.length > 0) {
        const balance = req.contracts.contract_budgets[0].balance_pen || 0;
        if (balance <= 0) {
          toast.error(`⚠️ ALERTA DE PRESUPUESTO: La solicitud ${req.request_number} pertenece al contrato ${req.contracts.code} que no tiene saldo disponible (S/ ${balance}). No se puede despachar sin ampliación de presupuesto.`, { duration: 8000 })
          return
        }
      }
    }

    setIsSubmitting(true)

    try {
      let dispatchId: string;

      if (newDispatch.document_type !== 'NOTA_SALIDA') {
        // ✅ REGLA DE NEGOCIO: Un conductor solo puede tener UNA ruta activa a la vez.
        // Verificar si el conductor ya tiene un despacho activo
        const { data: driverActiveDispatch, error: driverCheckError } = await supabase
          .from('dispatches')
          .select('id, dispatch_number, status')
          .eq('driver_name', newDispatch.driver_name)
          .in('status', ['PROGRAMADO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO'])
          .limit(1)
          .maybeSingle()

        if (driverCheckError) {
          console.error("Error checking driver active dispatch:", driverCheckError)
          throw driverCheckError
        }

        if (driverActiveDispatch) {
          toast.error(
            `⚠️ El conductor "${newDispatch.driver_name}" ya tiene el despacho ${driverActiveDispatch.dispatch_number} activo (estado: ${driverActiveDispatch.status}). Debe completar o liquidar esa ruta antes de asignar una nueva.`,
            { duration: 8000 }
          )
          setIsSubmitting(false)
          return
        }

        // Verificar si el vehículo ya tiene un despacho activo
        const { data: vehicleActiveDispatch, error: vehicleCheckError } = await supabase
          .from('dispatches')
          .select('id, dispatch_number, driver_name, status')
          .eq('vehicle_plate', newDispatch.vehicle_plate)
          .in('status', ['PROGRAMADO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO'])
          .limit(1)
          .maybeSingle()

        if (vehicleCheckError) throw vehicleCheckError

        if (vehicleActiveDispatch) {
          toast.error(
            `⚠️ El vehículo ${newDispatch.vehicle_plate} ya está asignado al despacho ${vehicleActiveDispatch.dispatch_number} con el conductor "${vehicleActiveDispatch.driver_name}". Use otro vehículo.`,
            { duration: 8000 }
          )
          setIsSubmitting(false)
          return
        }
      }

      // If no active dispatch was found (or if it's NOTA_SALIDA), create a new one
      if (!dispatchId!) {
        const dispatchNumber = `DESP-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`

        // Determinamos el contrato asociado (usando el de la primera OT seleccionada)
        const firstReq = pendingRequests.find(r => r.id === newDispatch.selected_requests[0].id)
        const activeContractId = firstReq?.contracts?.id || null

        // Calcular costo efectivo
        let effectiveFreightCost = 0
        if (detectedFreightRate && detectedFreightRate.rate > 0) {
          effectiveFreightCost = detectedFreightRate.rate
        } else if (manualFreightCost && !isNaN(Number(manualFreightCost))) {
          effectiveFreightCost = Number(manualFreightCost)
        }

        const { data: insertData, error: insertError } = await supabase
          .from('dispatches')
          .insert([{
            dispatch_number: dispatchNumber,
            driver_name: newDispatch.document_type === 'NOTA_SALIDA' ? 'CLIENTE' : newDispatch.driver_name,
            vehicle_plate: newDispatch.document_type === 'NOTA_SALIDA' ? 'EXTERNO' : newDispatch.vehicle_plate,
            scheduled_departure: newDispatch.scheduled_departure,
            status: 'PROGRAMADO',
            estimated_distance_km: newDispatch.estimated_distance_km || 0,
            freight_cost: effectiveFreightCost,
            contract_id: activeContractId
          }])
          .select()
          .single()

        if (insertError) throw insertError
        dispatchId = insertData.id

        // Llamar a RPC para crear el Servicio de Contrato formalmente (Paso 5)
        if (activeContractId && effectiveFreightCost > 0 && newDispatch.document_type !== 'NOTA_SALIDA') {
          const { data: serviceData, error: serviceError } = await supabase.rpc('register_contract_service', {
            p_contract_id: activeContractId,
            p_service_type: 'FLETE',
            p_description: `Flete ${detectedFreightRate ? '(Automático)' : '(Manual)'} - Despacho ${dispatchNumber}`,
            p_amount_pen: effectiveFreightCost,
            p_service_date: newDispatch.scheduled_departure.split('T')[0],
            p_plate: newDispatch.vehicle_plate,
            p_driver_name: newDispatch.driver_name,
            p_category: 'Contrato'
          })
          if (serviceError) {
            console.error('Error al generar servicio de contrato:', serviceError)
            toast.error('⚠️ Despacho creado, pero hubo un error al registrar el servicio en el contrato.')
          } else if (serviceData) {
            // Enlazar el servicio generado con el despacho para evitar duplicidad y permitir trazabilidad
            const { error: updateServiceError } = await supabase
              .from('contract_services')
              .update({ dispatch_id: dispatchId })
              .eq('id', serviceData)
            if (updateServiceError) console.error('Error linking service to dispatch:', updateServiceError)
          }
        }
      }

      // 2. Insertar los dispatch_requests con su GR
      const reqToInsert = newDispatch.selected_requests.map((req, idx) => ({
        dispatch_id: dispatchId,
        transport_request_id: req.id,
        status: 'PROGRAMADO',
        document_type: newDispatch.document_type,
        document_number: req.document_number,
        leg_planned_km: req.leg_planned_km || 0,
        sequence_order: idx + 1
      }))

      const { error: joinError } = await supabase
        .from('dispatch_requests')
        .insert(reqToInsert)

      if (joinError) throw joinError

      // 3. Actualizar el estado de las solicitudes a 'ASIGNADA'
      const { error: updateError } = await supabase
        .from('transport_requests')
        .update({ status: 'ASIGNADA' })
        .in('id', newDispatch.selected_requests.map(r => r.id))

      if (updateError) throw updateError

      toast.success('Despacho programado correctamente')
      setIsModalOpen(false)
      setNewDispatch({ selected_requests: [], driver_name: '', vehicle_plate: '', scheduled_departure: '', estimated_distance_km: '', document_type: 'GR' })
      setManualFreightCost('')
      setManualFreightCost('')
      fetchData()
    } catch (error: any) {
      toast.error('Error al programar el despacho: ' + error.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const startRoute = async (dispatchId: string, dispatchRequests: DispatchRequest[]) => {
    try {
      // Validar que todas las solicitudes tengan documento vinculado antes de iniciar
      const missingDocs = dispatchRequests.some(r => !r.document_number || !r.document_number.trim());
      if (missingDocs) {
        toast.error('Falta vincular documentos (GR/NS) en algunas solicitudes antes de poder iniciar la ruta.');
        return;
                  })
                )}
              </div>
            </div>
            
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
                disabled={isSubmitting || newDispatch.selected_requests.length === 0}
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
                  {selectedDispatchDetail.status}
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
                  const totalWeight = req.transport_request_items?.reduce((sum: number, item: any) => sum + ((item.weight || 0) * (item.quantity || 1)), 0) || 0;
                  const totalVol = req.transport_request_items?.reduce((sum: number, item: any) => sum + ((item.volume_m3 || 0) * (item.quantity || 1)), 0) || 0;
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
