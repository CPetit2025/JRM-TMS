"use client"
import { useState, useEffect, useRef } from 'react'
import { Truck, MapPin, Loader2, PlayCircle, Calendar, Plus, FileText, ArrowRight, CheckCircle2, DollarSign, Tag } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { calculateRouteDistance } from '@/lib/routing'

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
  const supabase = createClient()
  const [pendingRequests, setPendingRequests] = useState<TransportRequest[]>([])
  const [dispatches, setDispatches] = useState<Dispatch[]>([])
  const [vehicles, setVehicles] = useState<any[]>([])
  const [drivers, setDrivers] = useState<any[]>([])
  
  const alertedDispatches = useRef<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [selectedDispatchDetail, setSelectedDispatchDetail] = useState<Dispatch | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [calculatingDistance, setCalculatingDistance] = useState(false)
  const reqDistances = useRef<Record<string, number>>({})

  // Freight rate lookup state
  const [detectedFreightRate, setDetectedFreightRate] = useState<{ rate: number; district: string; zone: string } | null>(null)
  const [loadingRate, setLoadingRate] = useState(false)
  
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

  const handleProgramar = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newDispatch.selected_requests.length === 0) {
      toast.error('Debes seleccionar al menos una solicitud.')
      return
    }

    // Validar que todas las OTs tengan documento
    const missingDocs = newDispatch.selected_requests.some(req => !req.document_number.trim())
    if (missingDocs) {
      toast.error('Debes ingresar el número de documento para todas las solicitudes seleccionadas.')
      return
    }

    setIsSubmitting(true)

    try {
      let dispatchId: string;

      if (newDispatch.document_type !== 'NOTA_SALIDA') {
        // Check if there is an active dispatch for this vehicle
        const { data: activeDispatch, error: checkError } = await supabase
          .from('dispatches')
          .select('id, status')
          .eq('vehicle_plate', newDispatch.vehicle_plate)
          .in('status', ['PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (checkError) {
          console.error("Error checking active dispatch:", checkError)
          throw checkError
        }

        if (activeDispatch) {
           dispatchId = activeDispatch.id
           const updatePayload: any = {}
           
           // Update status to EN_CURSO to resume the trip
           if (['ESPERANDO_AUTORIZACION', 'RETORNO'].includes(activeDispatch.status)) {
              updatePayload.status = 'EN_CURSO'
           }
           
           // Always update driver_name to the selected driver to fix the bug where routes aren't shown
           const finalDriverName = newDispatch.driver_name
           if (finalDriverName) {
              updatePayload.driver_name = finalDriverName
           }
           
           if (Object.keys(updatePayload).length > 0) {
              await supabase.from('dispatches').update(updatePayload).eq('id', dispatchId)
           }
        }
      }

      // If no active dispatch was found (or if it's NOTA_SALIDA), create a new one
      if (!dispatchId!) {
        const dispatchNumber = `DESP-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`

        const { data: insertData, error: insertError } = await supabase
          .from('dispatches')
          .insert([{
            dispatch_number: dispatchNumber,
            driver_name: newDispatch.document_type === 'NOTA_SALIDA' ? 'CLIENTE' : newDispatch.driver_name,
            vehicle_plate: newDispatch.document_type === 'NOTA_SALIDA' ? 'EXTERNO' : newDispatch.vehicle_plate,
            scheduled_departure: newDispatch.scheduled_departure,
            status: 'PROGRAMADO',
            estimated_distance_km: newDispatch.estimated_distance_km || 0
          }])
          .select()
          .single()

        if (insertError) throw insertError
        dispatchId = insertData.id
      }

      // 2. Insertar los dispatch_requests con su GR
      const reqToInsert = newDispatch.selected_requests.map(req => ({
        dispatch_id: dispatchId,
        transport_request_id: req.id,
        status: 'PROGRAMADO',
        document_type: newDispatch.document_type,
        document_number: req.document_number
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
      fetchData()
    } catch (error: any) {
      toast.error('Error al programar el despacho: ' + error.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const startRoute = async (dispatchId: string, dispatchRequests: DispatchRequest[]) => {
    try {
      // Pasar despacho a EN_CURSO
      await supabase.from('dispatches').update({ status: 'EN_CURSO' }).eq('id', dispatchId)
      
      if (dispatchRequests && dispatchRequests.length > 0) {
        const reqIds = dispatchRequests.map(r => r.transport_request_id)
        
        // Pasar las solicitudes a EN TRANSITO
        await supabase.from('transport_requests').update({ status: 'EN TRANSITO' }).in('id', reqIds)
        await supabase.from('dispatch_requests').update({ status: 'EN_CURSO' }).eq('dispatch_id', dispatchId)
      }
      
      toast.success('El transporte ha iniciado su ruta')
      fetchData()
    } catch (error: any) {
      toast.error('Error al iniciar ruta: ' + error.message)
    }
  }

  const handleAuthorizeReturn = async (dispatchId: string) => {
    try {
      await supabase.from('dispatches').update({ status: 'RETORNO' }).eq('id', dispatchId)
      toast.success('Retorno autorizado. El conductor ha sido notificado.')
      fetchData()
    } catch (err: any) {
      toast.error('Error al autorizar: ' + err.message)
    }
  }

  const handleCloseRoute = async (dispatchId: string) => {
    try {
      // 1. Obtener todas las solicitudes atadas a este despacho
      const { data: drData, error: drError } = await supabase
        .from('dispatch_requests')
        .select('transport_request_id')
        .eq('dispatch_id', dispatchId)

      if (drError) throw drError

      // 1.5 Obtener datos del despacho para el kilometraje
      const { data: dispatchData } = await supabase
        .from('dispatches')
        .select('vehicle_plate, estimated_distance_km')
        .eq('id', dispatchId)
        .single()

      // 2. Cerrar ruta a nivel de cabecera
      await supabase.from('dispatches').update({ status: 'LIQUIDADO' }).eq('id', dispatchId)

      // 2.5 Actualizar kilometraje del vehículo si aplica
      if (dispatchData && dispatchData.vehicle_plate && dispatchData.vehicle_plate !== 'EXTERNO') {
        // Ejecutamos RPC o leemos y sumamos. Para simplificar, leemos y sumamos:
        const { data: vData } = await supabase.from('vehicles').select('id, current_mileage').eq('plate', dispatchData.vehicle_plate).single()
        if (vData) {
          const newMileage = (vData.current_mileage || 0) + (dispatchData.estimated_distance_km || 0)
          await supabase.from('vehicles').update({ current_mileage: Math.round(newMileage) }).eq('id', vData.id)
          // Registramos en el historial
          await supabase.from('vehicle_maintenance_history').insert([{
            vehicle_id: vData.id,
            action_type: 'KM_ACTUALIZADO',
            description: `Ruta ${dispatchId.substring(0,8)} completada (+${dispatchData.estimated_distance_km} KM)`,
            mileage_at_time: Math.round(newMileage)
          }])
        }
      }
      if (drData && drData.length > 0) {
        const reqIds = drData.map(dr => dr.transport_request_id)
        
        // 3. Marcar solicitudes como ENTREGADA
        await supabase.from('transport_requests').update({ status: 'ENTREGADA' }).in('id', reqIds)
        // 4. Marcar detalle como ENTREGADO
        await supabase.from('dispatch_requests').update({ status: 'ENTREGADO' }).eq('dispatch_id', dispatchId)
      }

      toast.success('Ruta cerrada exitosamente y solicitudes entregadas.')
      fetchData()
    } catch (err: any) {
      toast.error('Error al cerrar ruta: ' + err.message)
    }
  }

  const toggleRequestSelection = async (reqId: string, pickup: string, delivery: string) => {
    const isSelected = newDispatch.selected_requests.some(r => r.id === reqId)
    let nextRequests: { id: string, document_number: string }[]
    
    if (isSelected) {
      nextRequests = newDispatch.selected_requests.filter(r => r.id !== reqId)
      setNewDispatch(prev => ({ ...prev, selected_requests: nextRequests }))

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
      setNewDispatch(prev => ({ ...prev, selected_requests: nextRequests }))
      
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
    lookupFreightRate(newDispatch.vehicle_plate, updatedIds)
  }

  return (
    <div className="space-y-6 w-full mx-auto">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Programación de Despachos y Ruteo</h1>
          <p className="text-sm text-slate-500">Asignación de unidades de transporte a Solicitudes</p>
        </div>
        <button 
          onClick={() => setIsModalOpen(true)}
          className="flex items-center gap-2 bg-[#002855] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#001d3d] transition-colors shadow-sm"
        >
          <Plus className="w-4 h-4" />
          Armar Ruta
        </button>
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
                        {req.status === 'REPROGRAMADA' && (
                          <span className="text-[10px] bg-orange-100 text-orange-800 px-1.5 py-0.5 rounded font-bold flex items-center gap-1 border border-orange-200">
                            ⚠️ Nueva Fecha: {req.required_date ? new Date(req.required_date).toLocaleDateString() : 'N/A'}
                          </span>
                        )}
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded font-bold border ${typeColor} whitespace-nowrap h-fit`}>
                        {typeLabel}
                      </span>
                    </div>
                    <p className="text-sm font-semibold text-slate-800 mb-1 truncate" title={req.requester_name}>{req.requester_name}</p>
                    <div className="text-xs text-slate-500 flex flex-col gap-1 mt-2">
                      <div className="flex items-start gap-1">
                        <MapPin className="w-3 h-3 mt-0.5 flex-shrink-0 text-blue-500" />
                        <span className="truncate" title={req.pickup_address}>{req.pickup_address}</span>
                      </div>
                      <div className="flex items-start gap-1">
                        <MapPin className="w-3 h-3 mt-0.5 flex-shrink-0 text-red-400" />
                        <span className="truncate" title={req.delivery_address}>{req.delivery_address}</span>
                      </div>
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

          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead className="bg-slate-50 text-slate-500 text-xs text-left border-b border-slate-100 uppercase tracking-wider">
                  <tr>
                    <th className="p-4 font-semibold whitespace-nowrap">Despacho</th>
                    <th className="p-4 font-semibold whitespace-nowrap">Unidad / Chofer</th>
                    <th className="p-4 font-semibold whitespace-nowrap">Dist. (KM)</th>
                    <th className="p-4 font-semibold">Solicitudes (Ruta)</th>
                    <th className="p-4 font-semibold whitespace-nowrap">Salida Programada</th>
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
                  ) : dispatches.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="p-8 text-center text-slate-500">
                        No hay despachos registrados.
                      </td>
                    </tr>
                  ) : (
                    dispatches.map(dispatch => (
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
                            <span className="font-bold text-[#002855] text-sm uppercase">{dispatch.vehicle_plate}</span>
                            <span className="text-xs text-slate-500">{dispatch.driver_name}</span>
                          </div>
                        </td>
                        <td className="p-4 text-sm font-semibold text-slate-700">
                          {dispatch.estimated_distance_km ? `${dispatch.estimated_distance_km} KM` : '-'}
                        </td>
                        <td className="p-4 text-xs text-slate-600">
                          {dispatch.dispatch_requests && dispatch.dispatch_requests.length > 0 ? (
                            (() => {
                              const reqs = dispatch.dispatch_requests;
                              const recojos = reqs.filter(r => r.transport_requests.request_type === 'RECOJO').length;
                              const traslados = reqs.filter(r => r.transport_requests.request_type === 'TRASLADO').length;
                              const despachos = reqs.filter(r => !r.transport_requests.request_type || r.transport_requests.request_type === 'DESPACHO').length;
                              
                              const tooltipText = reqs.map(r => r.transport_requests.request_number).join(', ');

                              return (
                                <div className="flex flex-col gap-1.5" title={`OTs: ${tooltipText}`}>
                                  <div className="font-bold text-slate-700">{reqs.length} Punto{reqs.length !== 1 ? 's' : ''} de Ruta</div>
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
                            {new Date(dispatch.scheduled_departure).toLocaleString()}
                          </div>
                        </td>
                        <td className="p-4">
                          <span className={`px-2 py-1 text-xs font-semibold rounded-md whitespace-nowrap ${
                            dispatch.status === 'PROGRAMADO' ? 'bg-yellow-100 text-yellow-700' :
                            (dispatch.status === 'EN_CURSO' || dispatch.status === 'EN RUTA') ? 'bg-blue-100 text-blue-700' :
                            dispatch.status === 'ESPERANDO_AUTORIZACION' ? 'bg-orange-100 text-orange-700' :
                            dispatch.status === 'RETORNO' ? 'bg-indigo-100 text-indigo-700' :
                            dispatch.status === 'ENTREGADO' ? 'bg-green-100 text-green-700' :
                            'bg-red-100 text-red-700'
                          }`}>
                            {dispatch.status}
                          </span>
                        </td>
                        <td className="p-4 text-right">
                          {dispatch.status === 'PROGRAMADO' && (
                            <button 
                              onClick={() => startRoute(dispatch.id, dispatch.dispatch_requests || [])}
                              className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-50 text-blue-700 hover:bg-blue-100 hover:text-blue-800 transition-colors rounded-lg text-xs font-medium border border-blue-200 whitespace-nowrap"
                            >
                              <PlayCircle className="w-3 h-3" />
                              Iniciar
                            </button>
                          )}
                          {dispatch.status === 'ESPERANDO_AUTORIZACION' && (
                            <button 
                              onClick={() => handleAuthorizeReturn(dispatch.id)}
                              className="inline-flex items-center gap-1 px-3 py-1.5 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 hover:text-indigo-800 transition-colors rounded-lg text-xs font-medium border border-indigo-200 whitespace-nowrap"
                            >
                              <CheckCircle2 className="w-3 h-3" />
                              Autorizar Retorno
                            </button>
                          )}
                          {dispatch.status === 'RETORNO' && (
                            <button 
                              onClick={() => handleCloseRoute(dispatch.id)}
                              className="inline-flex items-center gap-1 px-3 py-1.5 bg-green-50 text-green-700 hover:bg-green-100 hover:text-green-800 transition-colors rounded-lg text-xs font-medium border border-green-200 whitespace-nowrap"
                            >
                              <CheckCircle2 className="w-3 h-3" />
                              Cerrar Ruta
                            </button>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
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
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Tipo de Despacho (Global)</label>
                  <select 
                    className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none text-sm font-medium"
                    value={newDispatch.document_type}
                    onChange={(e) => setNewDispatch({...newDispatch, document_type: e.target.value as 'GR' | 'NOTA_SALIDA'})}
                  >
                    <option value="GR">Transporte JRM (Se emitirán Guías de Remisión)</option>
                    <option value="NOTA_SALIDA">Recojo por Cliente (Se emitirán Notas de Salida)</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 shadow-sm">
              <h4 className="font-semibold text-[#002855] flex items-center gap-2 mb-4">
                <Truck className="w-4 h-4" />
                Datos del Vehículo
              </h4>
              
              <div className="space-y-3">
                {newDispatch.document_type === 'GR' ? (
                  <>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Placa del Vehículo</label>
                      <select 
                        required
                        className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none text-sm font-medium"
                        value={newDispatch.vehicle_plate}
                        onChange={(e) => {
                          const plate = e.target.value
                          setNewDispatch({...newDispatch, vehicle_plate: plate})
                          lookupFreightRate(plate, newDispatch.selected_requests.map(r => r.id))
                        }}
                      >
                        <option value="">Seleccione vehículo...</option>
                        {vehicles.map((v, i) => (
                          <option key={i} value={v.plate}>
                            {v.plate} - {v.brand} {v.model} ({v.carriers?.business_name})
                          </option>
                        ))}
                      </select>
                      {/* Tarifa detectada */}
                      {loadingRate && (
                        <p className="text-xs text-slate-400 flex items-center gap-1 mt-1"><Loader2 className="w-3 h-3 animate-spin" /> Buscando tarifa...</p>
                      )}
                      {!loadingRate && detectedFreightRate && (
                        <div className="mt-2 p-2 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center gap-2">
                          <Tag className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                          <div>
                            <p className="text-xs font-bold text-emerald-800">Tarifa Fija: <span className="text-base">S/ {detectedFreightRate.rate.toLocaleString('es-PE')}</span></p>
                            <p className="text-[10px] text-emerald-600">{detectedFreightRate.district} • {detectedFreightRate.zone}</p>
                          </div>
                        </div>
                      )}
                      {!loadingRate && !detectedFreightRate && newDispatch.vehicle_plate && newDispatch.selected_requests.length > 0 && (
                        <p className="text-xs text-slate-400 mt-1">Sin tarifa fija registrada para esta ruta.</p>
                      )}
                    </div>
                    
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Conductor</label>
                      <select 
                        required
                        className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none text-sm"
                        value={newDispatch.driver_name}
                        onChange={(e) => setNewDispatch({...newDispatch, driver_name: e.target.value})}
                      >
                        <option value="">Seleccione conductor...</option>
                        {drivers.map((d, i) => (
                          <option key={i} value={`${d.first_name} ${d.last_name}`}>
                            {d.first_name} {d.last_name} - {d.document_number} ({d.carriers?.business_name})
                          </option>
                        ))}
                      </select>
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
                    required
                    className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none text-sm"
                    value={newDispatch.scheduled_departure}
                    onChange={(e) => setNewDispatch({...newDispatch, scheduled_departure: e.target.value})}
                  />
                </div>
                
                <div>
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
                </div>
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
                            <div className="flex items-center gap-2 mb-1">
                              <span className="font-bold text-[#002855] text-sm">{req.request_number}</span>
                              <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold border ${typeColor}`}>
                                {typeLabel}
                              </span>
                            </div>
                          
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
                        {newDispatch.selected_requests.some(r => r.id === req.id) && (
                          <div className="ml-9 mb-2 animate-in fade-in slide-in-from-top-2">
                            <label className="block text-xs font-semibold text-slate-700 mb-1">
                              {newDispatch.document_type === 'GR' ? 'Guía de Remisión' : 'Nota de Salida'} para esta solicitud
                            </label>
                            <input 
                              type="text" 
                              required
                              placeholder={newDispatch.document_type === 'GR' ? "Ej. T001-00045" : "Ej. NS-001"}
                              className="w-full px-3 py-1.5 bg-white text-slate-900 border border-blue-200 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none text-sm shadow-sm"
                              value={newDispatch.selected_requests.find(r => r.id === req.id)?.document_number || ''}
                              onChange={(e) => {
                                setNewDispatch(prev => ({
                                  ...prev,
                                  selected_requests: prev.selected_requests.map(r => 
                                    r.id === req.id ? { ...r, document_number: e.target.value } : r
                                  )
                                }))
                              }}
                            />
                          </div>
                        )}
                      </div>
                    )
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
