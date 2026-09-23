"use client"
import { useState, useEffect, useMemo } from 'react'
import { Truck, MapPin, Camera, CheckCircle2, Clock, Navigation2, FileText, Upload, Loader2, AlertCircle, Navigation } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { nativeRouteTracker } from '@/lib/native-route-tracker'
import { readRouteQueue, routeQueueKey, syncRoutePoints, saveOfflineAction, syncOfflineActions } from '@/lib/route-point-sync'
import { useActiveTrip } from '@/contexts/ActiveTripContext'

export default function RutaActivaPage() {
  const router = useRouter()
  const [driver, setDriver] = useState<any>(null)
  const [dispatch, setDispatch] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [activeStep, setActiveStep] = useState(0)
  const [kmInput, setKmInput] = useState('')
  const [stopPhoto, setStopPhoto] = useState<string | null>(null)
  const [stopPhotoFile, setStopPhotoFile] = useState<File | null>(null)
  const [processing, setProcessing] = useState(false)

  const supabase = useMemo(() => createClient(), [])
  const { driver: contextDriver, trip, loading: contextLoading, refresh } = useActiveTrip()

  useEffect(() => {
    if (contextLoading) return
    if (!contextDriver) { router.replace('/app/login'); return }
    setDriver(contextDriver)
    const requests = (trip?.stops || []).map(stop => ({ ...stop,
      transport_requests: { request_number: stop.request_number, request_type: stop.request_type,
        pickup_address: stop.pickup_address, delivery_address: stop.delivery_address } }))
    const firstPending = requests.findIndex(stop => stop.status !== 'ENTREGADO')
    setActiveStep(firstPending >= 0 ? firstPending : requests.length)
    setDispatch(trip ? { ...trip, contract_id: trip.contract?.id, dispatch_requests: requests } : null)
    setLoading(false)
    void syncRoutePoints().catch(() => {})
    void syncOfflineActions().catch(() => {})
  }, [contextDriver, contextLoading, router, trip])

  const handleIniciarRuta = async () => {
    setProcessing(true)
    const loadingToast = toast.loading('Obteniendo ubicación e iniciando ruta...')

    try {
      let startLat = null
      let startLon = null
      let startPosition: GeolocationPosition | null = null

      try {
        if (navigator.geolocation) {
          const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 })
          })
          startLat = pos.coords.latitude
          startLon = pos.coords.longitude
          startPosition = pos
        }
      } catch (geoError) {
        throw new Error('No se pudo obtener GPS preciso para iniciar la ruta.')
      }
      if (startLat === null || startLon === null) throw new Error('GPS no disponible')

      const { data: checklist } = await supabase.from('driver_checklists')
        .select('id').eq('dispatch_id', dispatch.id).eq('driver_id', driver.id).eq('is_approved', true)
        .limit(1).maybeSingle()
      if (!checklist) throw new Error('Completa y guarda el checklist antes de iniciar.')

      const { error } = await supabase.rpc('start_dispatch_route', {
        p_dispatch_id: dispatch.id, p_lat: startLat, p_lon: startLon
      })

      if (error) throw error
      if (startPosition && startPosition.coords.accuracy <= 30) {
        const { error: firstPointError } = await supabase.from('route_track_points').insert({
          id: crypto.randomUUID(), dispatch_id: dispatch.id, driver_id: driver.id,
          recorded_at: new Date(startPosition.timestamp).toISOString(),
          latitude: startPosition.coords.latitude, longitude: startPosition.coords.longitude,
          accuracy_m: startPosition.coords.accuracy,
          speed_mps: startPosition.coords.speed
        })
        if (firstPointError) toast.warning('Punto GPS inicial pendiente. Revisa la conexión.')
      }

      toast.success('Ruta iniciada con éxito. Conduzca con cuidado.', { id: loadingToast })
      if (nativeRouteTracker) {
        try { await nativeRouteTracker.start({ dispatchId: dispatch.id, driverId: driver.id }) }
        catch { toast.warning('Seguimiento nativo no disponible; mantén abierta la app para registrar GPS.') }
      }
      setDispatch({ ...dispatch, status: 'EN RUTA', start_lat: startLat, start_lon: startLon })
      await refresh()
    } catch (err: any) {
      toast.error('Error al iniciar: ' + err.message, { id: loadingToast })
    } finally {
      setProcessing(false)
    }
  }

  const handleRegisterKM = async (req: any, photoFile: File | null = stopPhotoFile) => {
    if (!photoFile) {
      toast.error('Debes tomar una foto de evidencia en el punto')
      return
    }

    setProcessing(true)
    const loadingToast = toast.loading('Validando GPS y guardando la parada...')
    try {
      const stopPosition = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject,
          { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }))
      if (stopPosition.coords.accuracy > 30) throw new Error('Espera una señal GPS de 30 m o mejor')
      const pendingPoints = readRouteQueue()
      pendingPoints.push({
        id: crypto.randomUUID(), dispatch_id: dispatch.id, driver_id: driver.id,
        recorded_at: new Date(stopPosition.timestamp).toISOString(),
        latitude: stopPosition.coords.latitude, longitude: stopPosition.coords.longitude,
        accuracy_m: stopPosition.coords.accuracy, speed_mps: stopPosition.coords.speed
      })
      localStorage.setItem(routeQueueKey, JSON.stringify(pendingPoints))
      try {
        const pendingCount = await syncRoutePoints()
        if (pendingCount > 0) {
          toast.warning(`Hay ${pendingCount} puntos GPS locales pendientes de envío.`, { id: loadingToast })
        }
      } catch (syncErr) {
        console.warn('Error sincronizando GPS, se enviará luego:', syncErr)
        toast.warning('Modo Offline: Puntos GPS guardados localmente.', { id: loadingToast })
      }

      const { data: userData } = await supabase.auth.getUser()
      if (!userData.user) throw new Error('La sesión expiró')
      const filePath = `${userData.user.id}/${dispatch.id}/${req.transport_request_id}/${crypto.randomUUID()}-${photoFile.name}`
      const { error: uploadError } = await supabase.storage.from('driver_evidence')
        .upload(filePath, photoFile, { upsert: false, contentType: photoFile.type })
      if (uploadError) throw uploadError
      const { data: result, error: stopError } = await supabase.rpc('complete_dispatch_stop', {
        p_dispatch_id: dispatch.id,
        p_request_id: req.transport_request_id,
        p_photo_url: filePath
      })
      if (stopError) {
        await supabase.storage.from('driver_evidence').remove([filePath])
        throw stopError
      }
      const actualKm = Number(result.leg_actual_km)
      toast.success(`Punto entregado: ${actualKm.toFixed(3)} km GPS${result.leg_gps_complete ? '' : ' (cobertura parcial)'}`, { id: loadingToast })

      // Actualizar estado local
      const updatedRequests = [...dispatch.dispatch_requests]
      updatedRequests[activeStep] = {
        ...updatedRequests[activeStep],
        status: 'ENTREGADO',
        arrival_lat: result.arrival_lat,
        arrival_lon: result.arrival_lon,
        leg_actual_km: actualKm,
        leg_gps_complete: result.leg_gps_complete
      }
      setDispatch({ ...dispatch, dispatch_requests: updatedRequests })

      setActiveStep(activeStep + 1)
      setKmInput('')
      setStopPhoto(null)
      setStopPhotoFile(null)
      await refresh()
    } catch (err: any) {
      if (!navigator.onLine || err.message.includes('fetch')) {
        // Fallback offline real
        toast.warning('Modo Offline: Parada registrada localmente. Se sincronizará luego.', { id: loadingToast })

        // Convertir photo a base64
        const reader = new FileReader()
        reader.readAsDataURL(photoFile)
        reader.onload = async () => {
          const { data: userData } = await supabase.auth.getUser()
          if (!userData.user) return
          saveOfflineAction('complete_dispatch_stop', {
            p_dispatch_id: dispatch.id,
            p_request_id: req.transport_request_id,
            user_id: userData.user.id,
            photo_base64: reader.result
          })

          // Actualizar estado local optimistamente
          const updatedRequests = [...dispatch.dispatch_requests]
          updatedRequests[activeStep] = {
            ...updatedRequests[activeStep],
            status: 'ENTREGADO',
            leg_actual_km: 0,
            leg_gps_complete: false
          }
          setDispatch({ ...dispatch, dispatch_requests: updatedRequests })
          setActiveStep(activeStep + 1)
          setStopPhoto(null)
          setStopPhotoFile(null)
        }
      } else {
        toast.error('Error al registrar: ' + err.message, { id: loadingToast })
      }
    } finally {
      setProcessing(false)
    }
  }

  const handleRequestReturn = async () => {
    setProcessing(true)
    try {
      if (nativeRouteTracker) {
        await nativeRouteTracker.stop()
      }
      try {
        const pendingCount = await syncRoutePoints()
        if (pendingCount > 0) {
          toast('Hay puntos pendientes de envío.', { icon: '⚠️' })
        }
      } catch (err) {
        toast('Modo Offline: Sincronización pendiente.', { icon: '⚠️' })
      }
      const { error } = await supabase.rpc('request_dispatch_return', { p_dispatch_id: dispatch.id })
      if (error) throw error
      toast.success('Solicitud enviada al Supervisor.')
      setDispatch({ ...dispatch, status: 'ESPERANDO_AUTORIZACION' })
      await refresh()
    } catch (err: any) {
      if (!navigator.onLine || err.message.includes('fetch')) {
         toast.warning('Modo Offline: Solicitud de retorno guardada localmente.', { icon: '⚠️' })
         saveOfflineAction('request_dispatch_return', { p_dispatch_id: dispatch.id })
         setDispatch({ ...dispatch, status: 'ESPERANDO_AUTORIZACION' })
      } else {
         if (nativeRouteTracker) {
           void nativeRouteTracker.start({ dispatchId: dispatch.id, driverId: driver.id })
         }
         toast.error('Error al solicitar retorno: ' + err.message)
      }
    } finally {
      setProcessing(false)
    }
  }

  const handleCompleteReturn = async () => {
    setProcessing(true)
    try {
      if (nativeRouteTracker) await nativeRouteTracker.stop()
      const position = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject,
          { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }))
      if (position.coords.accuracy > 30) throw new Error('Espera una señal GPS de 30 m o mejor')
      const pendingPoints = readRouteQueue()
      pendingPoints.push({
        id: crypto.randomUUID(), dispatch_id: dispatch.id, driver_id: driver.id,
        recorded_at: new Date(position.timestamp).toISOString(),
        latitude: position.coords.latitude, longitude: position.coords.longitude,
        accuracy_m: position.coords.accuracy, speed_mps: position.coords.speed
      })
      localStorage.setItem(routeQueueKey, JSON.stringify(pendingPoints))
      try {
        const pendingCount = await syncRoutePoints()
        if (pendingCount > 0) {
          toast.warning(`Hay ${pendingCount} puntos GPS locales pendientes de envío.`)
        }
      } catch (syncErr) {
        console.warn('Error sincronizando GPS en retorno, se enviará luego:', syncErr)
        toast.warning('Modo Offline: GPS guardado localmente.')
      }
      const { data, error } = await supabase.rpc('complete_dispatch_return', { p_dispatch_id: dispatch.id })
      if (error) throw error
      toast.success(`Retorno registrado: ${Number(data.return_actual_km).toFixed(3)} km GPS`)
      setDispatch({ ...dispatch, status: 'RETORNO_COMPLETADO',
        return_actual_km: data.return_actual_km, actual_distance_km: data.actual_distance_km })
      await refresh()
    } catch (err: any) {
      if (!navigator.onLine || err.message.includes('fetch')) {
         toast.warning('Modo Offline: Llegada a base guardada localmente.', { icon: '⚠️' })
         saveOfflineAction('complete_dispatch_return', { p_dispatch_id: dispatch.id })
         setDispatch({ ...dispatch, status: 'RETORNO_COMPLETADO' })
      } else {
         if (nativeRouteTracker) void nativeRouteTracker.start({ dispatchId: dispatch.id, driverId: driver.id })
         toast.error('Error al confirmar llegada: ' + err.message)
      }
    } finally {
      setProcessing(false)
    }
  }

  const handlePhotoCapture = (e: React.ChangeEvent<HTMLInputElement>, req: any) => {
    const file = e.target.files?.[0]
    if (file) {
      setStopPhoto(URL.createObjectURL(file))
      setStopPhotoFile(file)
      // One-click UX: Automáticamente proceder a marcar llegada
      handleRegisterKM(req, file)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-[#002855]" />
        <p className="mt-4 text-slate-500 font-medium">Cargando ruta...</p>
      </div>
    )
  }

  if (!dispatch || !dispatch.dispatch_requests || dispatch.dispatch_requests.length === 0) {
    return (
      <div className="p-4 max-w-md mx-auto pb-24 relative">
        <h1 className="px-2 text-xl font-black text-[#002855]">Viajes</h1>

        <div className="flex flex-col items-center justify-center min-h-[40vh] p-6 text-center mt-10">
          <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <AlertCircle className="w-10 h-10 text-slate-400" />
          </div>
          <h2 className="text-xl font-bold text-slate-800 mb-2">No hay rutas activas</h2>
          <p className="text-slate-500 mb-6 max-w-xs mx-auto">
            No tienes ningún despacho programado ni en curso en este momento.
          </p>

          <button
            onClick={() => { setLoading(true); void refresh().finally(() => setLoading(false)) }}
            className="bg-[#002855] text-white px-6 py-3 rounded-xl font-bold hover:bg-[#001d3d] transition-colors shadow-md"
          >
            Actualizar
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 max-w-md mx-auto pb-24 relative">
      <div className="mb-4 px-2">
        <div>
          <h1 className="text-xl font-black text-[#002855] tracking-tight">Ruta Activa</h1>
          <p className="text-xs text-slate-500 font-medium mt-1">
            Placa Asignada: <span className="font-bold text-[#002855]">{dispatch?.vehicle_plate || 'Sin asignar'}</span>
          </p>
        </div>
      </div>

      {/* Header Info */}
      <div className="bg-[#002855] text-white p-4 rounded-xl shadow-lg mb-6 flex justify-between items-center">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold">{dispatch.dispatch_number}</h2>
          </div>
          <p className="text-blue-200 text-sm mt-1">{dispatch.dispatch_requests?.length || 0} Paradas asignadas</p>
        </div>
        <div className={`border px-3 py-1 rounded-full text-[10px] font-bold tracking-wide text-center
          ${dispatch.status === 'PROGRAMADO' ? 'bg-amber-500/20 text-amber-300 border-amber-400' :
            dispatch.status === 'EN RUTA' ? 'bg-green-500/20 text-green-300 border-green-400' :
            dispatch.status === 'ESPERANDO_AUTORIZACION' ? 'bg-orange-500/20 text-orange-300 border-orange-400' :
            'bg-blue-500/20 text-blue-300 border-blue-400'
          }`}
        >
          {dispatch.status.replace('_', ' ')}
        </div>
      </div>

      {['PROGRAMADO', 'EN_CURSO'].includes(dispatch.status) ? (
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm text-center">
          <div className="w-16 h-16 bg-blue-100 text-[#002855] rounded-full flex items-center justify-center mx-auto mb-4">
            <Navigation className="w-8 h-8" />
          </div>
          <h3 className="text-lg font-bold text-slate-800 mb-2">Ruta Programada</h3>
          <p className="text-slate-500 text-sm mb-6">Usted tiene {dispatch.dispatch_requests?.length || 0} paradas asignadas. Presione el botón para iniciar la ruta y permitir el registro de las entregas.</p>
          <button
            onClick={handleIniciarRuta}
            disabled={processing}
            className="w-full bg-[#002855] text-white py-3 rounded-xl font-bold shadow hover:bg-[#001d3d] flex justify-center items-center gap-2 disabled:opacity-70"
          >
            {processing ? <Loader2 className="w-5 h-5 animate-spin" /> : "INICIAR RUTA"}
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {dispatch.dispatch_requests?.map((req: any, index: number) => {
            const isActive = index === activeStep && dispatch.status === 'EN RUTA'
            const isPast = index < activeStep
            const ot = req.transport_requests
            const typeLabel = ot?.request_type || (ot?.pickup_address.includes('Lurin') ? 'RECOJO' : 'ENTREGA')

            return (
              <div key={req.transport_request_id} className={`relative flex gap-4 ${isPast ? 'opacity-60' : ''}`}>

                {/* Línea de conexión */}
                {index < dispatch.dispatch_requests.length - 1 && (
                  <div className={`absolute left-[19px] top-[40px] bottom-[-20px] w-0.5 ${isPast ? 'bg-[#002855]' : 'bg-slate-200'}`} />
                )}

                {/* Icono de estado */}
                <div className="mt-1 z-10">
                  {isPast ? (
                    <div className="w-10 h-10 rounded-full bg-[#002855] flex items-center justify-center">
                      <CheckCircle2 className="w-6 h-6 text-white" />
                    </div>
                  ) : isActive ? (
                    <div className="w-10 h-10 rounded-full bg-blue-100 border-2 border-blue-500 flex items-center justify-center shadow-[0_0_15px_rgba(59,130,246,0.5)]">
                      <Navigation2 className="w-5 h-5 text-blue-600" />
                    </div>
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-white border-2 border-slate-300 flex items-center justify-center">
                      <MapPin className="w-5 h-5 text-slate-400" />
                    </div>
                  )}
                </div>

                {/* Contenido de la parada */}
                <div className={`flex-1 bg-white p-4 rounded-xl border shadow-sm ${isActive ? 'border-blue-300 ring-2 ring-blue-50' : 'border-slate-200'}`}>
                  <div className="flex justify-between items-start mb-2">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${typeLabel === 'RECOJO' ? 'bg-orange-100 text-orange-700' : 'bg-purple-100 text-purple-700'}`}>
                      {typeLabel}
                    </span>
                    {isPast && <span className="text-xs font-bold text-green-600">{Number(req.leg_actual_km || 0).toFixed(3)} km GPS{req.leg_gps_complete === false ? ' · parcial' : ''}</span>}
                  </div>

                  {req.document_number && (
                    <div className="inline-block bg-blue-50 text-blue-800 text-[10px] font-bold px-2 py-1 rounded border border-blue-200 mb-2">
                      {req.document_type === 'GR' ? 'GR' : 'NS'}: {req.document_number}
                    </div>
                  )}

                  <h3 className={`font-bold ${isActive ? 'text-blue-900' : 'text-slate-700'}`}>{ot.request_number}</h3>
                  <p className="text-xs text-slate-500 mt-1 line-clamp-2">{ot.delivery_address || ot.pickup_address}</p>

                  {/* Acciones si es la parada activa */}
                  {isActive && (
                    <div className="mt-4 pt-4 border-t border-slate-100">
                      <label className="block text-xs font-bold text-slate-700 mb-2">Completar Parada</label>
                      {processing ? (
                        <div className="h-24 mb-4 flex flex-col items-center justify-center bg-slate-50 rounded-lg border border-slate-200">
                          <Loader2 className="w-8 h-8 animate-spin text-[#002855] mb-2" />
                          <span className="text-xs font-semibold text-slate-600">Procesando...</span>
                        </div>
                      ) : (
                        <label className="border-2 border-dashed border-blue-400 bg-blue-50/50 rounded-xl h-24 mb-4 flex flex-col items-center justify-center cursor-pointer hover:bg-blue-100/50 transition-colors shadow-sm">
                          <Camera className="w-8 h-8 text-blue-600 mb-1" />
                          <span className="text-sm font-bold text-[#002855]">Tomar Foto & Marcar Llegada</span>
                          <span className="text-[10px] font-semibold text-slate-500 mt-1">Se requiere evidencia GPS</span>
                          <input
                            type="file"
                            accept="image/*"
                            capture="environment"
                            className="hidden"
                            onChange={(e) => handlePhotoCapture(e, req)}
                          />
                        </label>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Fin de ruta - Esperando Autorización */}
      {dispatch.status === 'EN RUTA' && activeStep >= (dispatch.dispatch_requests?.length || 0) && (
        <div className="mt-8 bg-green-50 border border-green-200 p-6 rounded-xl text-center">
          <div className="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="w-10 h-10" />
          </div>
          <h2 className="text-xl font-bold text-green-900 mb-2">¡Ruta Culminada!</h2>
          <p className="text-sm text-green-700 mb-6">Todos los puntos de su hoja de ruta han sido marcados exitosamente. Solicite al supervisor instrucciones o autorización de retorno.</p>
          <button
            onClick={handleRequestReturn}
            disabled={processing}
            className="w-full bg-[#002855] text-white px-6 py-3 rounded-xl font-bold shadow hover:bg-[#001d3d] flex items-center justify-center gap-2"
          >
            {processing ? <Loader2 className="w-5 h-5 animate-spin" /> : "Solicitar Retorno a Supervisor"}
          </button>
        </div>
      )}

      {/* Estado: Esperando Autorización */}
      {dispatch.status === 'ESPERANDO_AUTORIZACION' && (
        <div className="mt-8 bg-orange-50 border border-orange-200 p-6 rounded-xl text-center">
          <div className="w-16 h-16 bg-orange-100 text-orange-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <Clock className="w-10 h-10 animate-pulse" />
          </div>
          <h2 className="text-xl font-bold text-orange-900 mb-2">Esperando Autorización</h2>
          <p className="text-sm text-orange-700 mb-6">Se ha notificado al Supervisor de Transporte que su ruta culminó. Manténgase a la espera por nuevas paradas o confirmación de retorno.</p>
          <button
            onClick={() => void refresh()}
            className="w-full bg-white text-orange-700 border border-orange-300 px-6 py-2 rounded-xl font-bold shadow-sm"
          >
            Actualizar Pantalla
          </button>
        </div>
      )}

      {/* Estado: Retorno */}
      {dispatch.status === 'RETORNO' && (
        <div className="mt-8 bg-blue-50 border border-blue-200 p-6 rounded-xl text-center">
          <div className="w-16 h-16 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <Navigation2 className="w-10 h-10 transform -rotate-45" />
          </div>
          <h2 className="text-xl font-bold text-blue-900 mb-2">Retorno Autorizado</h2>
          <p className="text-sm text-blue-700 mb-6">Puede retornar a Base. Conduzca con cuidado.</p>
          <button onClick={handleCompleteReturn} disabled={processing}
            className="w-full mb-3 bg-[#002855] text-white px-6 py-3 rounded-xl font-bold disabled:opacity-50">
            {processing ? 'Sincronizando GPS...' : 'Confirmar llegada a base'}
          </button>
          <a href="/app/liquidacion" className="inline-flex items-center gap-2 bg-blue-600 text-white px-6 py-3 rounded-xl font-bold shadow hover:bg-blue-700">
            <FileText className="w-5 h-5" />
            Ir a Liquidar Gastos
          </a>
        </div>
      )}

      {dispatch.status === 'RETORNO_COMPLETADO' && (
        <div className="mt-8 bg-green-50 border border-green-200 p-6 rounded-xl text-center">
          <CheckCircle2 className="w-12 h-12 mx-auto mb-3 text-green-600" />
          <h2 className="text-xl font-bold text-green-900">Llegada a base registrada</h2>
          <p className="text-sm text-green-700 mt-2">Retorno: {Number(dispatch.return_actual_km || 0).toFixed(3)} km · Total: {Number(dispatch.actual_distance_km || 0).toFixed(3)} km GPS. El supervisor puede cerrar la ruta.</p>
        </div>
      )}

    </div>
  )
}
