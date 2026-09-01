"use client"
import { useState, useEffect } from 'react'
import { Camera, MapPin, Clock, CheckCircle2, Navigation2, FileText, Loader2, AlertCircle, Navigation, UserCircle, KeyRound, LogOut } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function RutaActivaPage() {
  const router = useRouter()
  const [driver, setDriver] = useState<any>(null)
  const [dispatch, setDispatch] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [activeStep, setActiveStep] = useState(0)
  const [kmInput, setKmInput] = useState('')
  const [stopPhoto, setStopPhoto] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)
  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [passwords, setPasswords] = useState({ current: '', new: '', confirm: '' })

  const supabase = createClient()

  useEffect(() => {
    const driverData = localStorage.getItem('jrm_driver')
    if (!driverData) {
      router.push('/conductor/login')
      return
    }
    const parsedDriver = JSON.parse(driverData)
    setDriver(parsedDriver)
    fetchActiveDispatch(parsedDriver)
  }, [router])

  const fetchActiveDispatch = async (driverData: any) => {
    try {
      const driverName = `${driverData.first_name} ${driverData.last_name}`.trim()
      
      const { data, error } = await supabase
        .from('dispatches')
        .select(`
          *,
          dispatch_requests(
            transport_request_id,
            status,
            document_number,
            document_type,
            sequence_order,
            transport_requests(
              request_number,
              request_type,
              pickup_address,
              delivery_address
            )
          )
        `)
        .eq('driver_name', driverName)
        .in('status', ['PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (error) throw error

      if (data) {
        // Ordenar requests
        const sortedRequests = (data.dispatch_requests || []).sort((a: any, b: any) => {
           return (a.sequence_order || 999) - (b.sequence_order || 999)
        })
        data.dispatch_requests = sortedRequests

        // Buscar el primer paso pendiente
        const firstPendingIdx = sortedRequests.findIndex((r: any) => r.status !== 'ENTREGADO')
        if (firstPendingIdx !== -1) {
          setActiveStep(firstPendingIdx)
        } else {
          setActiveStep(sortedRequests.length)
        }
      }
      setDispatch(data)
    } catch (err: any) {
      toast.error('Error al cargar la ruta: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleIniciarRuta = async () => {
    setProcessing(true)
    try {
      const { error } = await supabase
        .from('dispatches')
        .update({ status: 'EN RUTA' })
        .eq('id', dispatch.id)
      
      if (error) throw error
      
      toast.success('Ruta iniciada con éxito. Conduzca con cuidado.')
      setDispatch({ ...dispatch, status: 'EN RUTA' })
    } catch (err: any) {
      toast.error('Error al iniciar: ' + err.message)
    } finally {
      setProcessing(false)
    }
  }

  const handleRegisterKM = async (req: any) => {
    if (!kmInput || isNaN(Number(kmInput))) {
      toast.error('Ingresa un kilometraje válido')
      return
    }
    
    if (!stopPhoto) {
      toast.error('Debes tomar una foto de evidencia en el punto')
      return
    }
    
    setProcessing(true)
    try {
      // 1. Actualizar estado en dispatch_requests
      const { error: reqError } = await supabase
        .from('dispatch_requests')
        .update({ status: 'ENTREGADO' })
        .eq('dispatch_id', dispatch.id)
        .eq('transport_request_id', req.transport_request_id)
        
      if (reqError) throw reqError

      // 2. Actualizar estado en transport_requests
      const { error: otError } = await supabase
        .from('transport_requests')
        .update({ status: 'COMPLETADO' }) // Estado final en la tabla madre
        .eq('id', req.transport_request_id)

      if (otError) throw otError

      toast.success(`Punto entregado correctamente`)
      
      // Actualizar estado local
      const updatedRequests = [...dispatch.dispatch_requests]
      updatedRequests[activeStep].status = 'ENTREGADO'
      setDispatch({ ...dispatch, dispatch_requests: updatedRequests })
      
      setActiveStep(activeStep + 1)
      setKmInput('')
      setStopPhoto(null)
    } catch (err: any) {
      toast.error('Error al registrar: ' + err.message)
    } finally {
      setProcessing(false)
    }
  }

  const handleRequestReturn = async () => {
    setProcessing(true)
    try {
      const { error } = await supabase
        .from('dispatches')
        .update({ status: 'ESPERANDO_AUTORIZACION' })
        .eq('id', dispatch.id)
      
      if (error) throw error
      
      toast.success('Solicitud enviada al Supervisor.')
      setDispatch({ ...dispatch, status: 'ESPERANDO_AUTORIZACION' })
    } catch (err: any) {
      toast.error('Error al solicitar retorno: ' + err.message)
    } finally {
      setProcessing(false)
    }
  }

  const handlePhotoCapture = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setStopPhoto(URL.createObjectURL(file))
    }
  }

  const handleLogout = () => {
    localStorage.removeItem('jrm_driver')
    window.location.href = '/conductor/login'
  }

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (passwords.new !== passwords.confirm) {
      toast.error('Las contraseñas nuevas no coinciden')
      return
    }
    
    setProcessing(true)
    try {
      // Verificar contraseña actual
      const { data: currentDriver, error: currentError } = await supabase
        .from('drivers')
        .select('pin')
        .eq('id', driver.id)
        .single()
        
      if (currentError) throw currentError
      
      if (currentDriver.pin !== passwords.current) {
        toast.error('La contraseña actual es incorrecta')
        setProcessing(false)
        return
      }
      
      // Actualizar contraseña
      const { error: updateError } = await supabase
        .from('drivers')
        .update({ pin: passwords.new })
        .eq('id', driver.id)
        
      if (updateError) throw updateError
      
      toast.success('Contraseña actualizada con éxito')
      setShowPasswordModal(false)
      setPasswords({ current: '', new: '', confirm: '' })
    } catch (err: any) {
      toast.error('Error al cambiar contraseña: ' + err.message)
    } finally {
      setProcessing(false)
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
    const debugDriverName = driver ? `${driver.first_name} ${driver.last_name}`.trim() : 'Ninguno';
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] p-6 text-center">
        <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mb-4">
          <AlertCircle className="w-10 h-10 text-slate-400" />
        </div>
        <h2 className="text-xl font-bold text-slate-800 mb-2">No hay rutas activas</h2>
        <p className="text-slate-500 mb-6 max-w-xs mx-auto">
          No tienes ningún despacho programado ni en curso en este momento.
        </p>
        
        {/* INFO DEBUG */}
        <div className="bg-red-50 text-red-800 p-3 rounded-lg text-xs w-full max-w-sm mb-6 text-left font-mono">
          <strong>Debug:</strong><br/>
          Buscando para: "{debugDriverName}"<br/>
          Estado de Dispatch: {dispatch ? 'Encontrado' : 'No encontrado'}<br/>
          Items de Dispatch: {dispatch?.dispatch_requests?.length || 0}
        </div>

        <button 
          onClick={() => { setLoading(true); fetchActiveDispatch(driver); }}
          className="bg-[#002855] text-white px-6 py-3 rounded-xl font-bold hover:bg-[#001d3d] transition-colors shadow-md"
        >
          Actualizar
        </button>
      </div>
    )
  }

  return (
    <div className="p-4 max-w-md mx-auto pb-24 relative">
      {/* Navbar Minimalista del Conductor */}
      <div className="flex justify-between items-center mb-6 px-2">
        <h1 className="text-xl font-black text-[#002855] tracking-tight">Ruta Activa</h1>
        <div className="relative">
          <button 
            onClick={() => setShowProfileMenu(!showProfileMenu)}
            className="w-10 h-10 bg-slate-200 rounded-full flex items-center justify-center text-[#002855] hover:bg-slate-300 transition-colors"
          >
            <UserCircle className="w-6 h-6" />
          </button>
          
          {showProfileMenu && (
            <div className="absolute right-0 mt-2 w-48 bg-white rounded-xl shadow-xl border border-slate-100 z-50 overflow-hidden">
              <div className="p-3 border-b border-slate-100 bg-slate-50">
                <p className="text-xs font-bold text-slate-800 line-clamp-1">{driver?.first_name} {driver?.last_name}</p>
                <p className="text-[10px] text-slate-500">{driver?.document_number}</p>
              </div>
              <button 
                onClick={() => { setShowPasswordModal(true); setShowProfileMenu(false); }}
                className="w-full text-left px-4 py-3 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2 transition-colors"
              >
                <KeyRound className="w-4 h-4 text-slate-400" />
                Cambiar Contraseña
              </button>
              <button 
                onClick={handleLogout}
                className="w-full text-left px-4 py-3 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2 transition-colors border-t border-slate-50"
              >
                <LogOut className="w-4 h-4 text-red-400" />
                Cerrar Sesión
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Header Info */}
      <div className="bg-[#002855] text-white p-4 rounded-xl shadow-lg mb-6 flex justify-between items-center">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold">{dispatch.dispatch_number}</h2>
          </div>
          <p className="text-blue-200 text-sm mt-1">{dispatch.vehicle_plate} • {dispatch.dispatch_requests?.length || 0} Paradas</p>
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

      {dispatch.status === 'PROGRAMADO' ? (
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
                    {isPast && <span className="text-xs font-bold text-green-600">Completado</span>}
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
                      <label className="block text-xs font-bold text-slate-700 mb-2">1. Evidencia Fotográfica</label>
                      {stopPhoto ? (
                        <div className="relative mb-4 rounded-lg overflow-hidden border border-slate-200">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={stopPhoto} alt="Evidencia" className="w-full h-32 object-cover" />
                          <button 
                            onClick={() => setStopPhoto(null)}
                            className="absolute top-2 right-2 bg-black/50 text-white text-xs px-2 py-1 rounded"
                          >
                            Cambiar
                          </button>
                        </div>
                      ) : (
                        <label className="border-2 border-dashed border-slate-300 rounded-lg h-24 mb-4 flex flex-col items-center justify-center cursor-pointer hover:bg-slate-50 transition-colors">
                          <Camera className="w-6 h-6 text-slate-400 mb-1" />
                          <span className="text-xs font-semibold text-[#002855]">Tomar Foto (Obligatorio)</span>
                          <input 
                            type="file" 
                            accept="image/*" 
                            capture="environment" 
                            className="hidden" 
                            onChange={handlePhotoCapture}
                          />
                        </label>
                      )}

                      <label className="block text-xs font-bold text-slate-700 mb-2">2. Registrar Llegada (Odómetro)</label>
                      <div className="flex gap-2">
                        <input 
                          type="number"
                          placeholder="Ej: 145020"
                          className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-[#002855] focus:border-[#002855]"
                          value={kmInput}
                          onChange={(e) => setKmInput(e.target.value)}
                        />
                        <button 
                          onClick={() => handleRegisterKM(req)}
                          disabled={processing}
                          className="bg-[#002855] text-white px-4 py-2 rounded-lg text-sm font-bold shadow hover:bg-[#001f44] disabled:opacity-50"
                        >
                          Llegué
                        </button>
                      </div>
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
            onClick={() => fetchActiveDispatch(driver)}
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
          <a href="/conductor/liquidacion" className="inline-flex items-center gap-2 bg-blue-600 text-white px-6 py-3 rounded-xl font-bold shadow hover:bg-blue-700">
            <FileText className="w-5 h-5" />
            Ir a Liquidar Gastos
          </a>
        </div>
      )}

      {/* Modal Cambio de Contraseña */}
      {showPasswordModal && (
        <div className="fixed inset-0 bg-black/60 z-[100] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl">
            <div className="p-5 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
              <h3 className="font-bold text-slate-800 flex items-center gap-2">
                <KeyRound className="w-5 h-5 text-blue-600" />
                Cambiar Contraseña
              </h3>
              <button onClick={() => setShowPasswordModal(false)} className="text-slate-400 hover:text-slate-600">×</button>
            </div>
            <form onSubmit={handleChangePassword} className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Contraseña Actual (DNI)</label>
                <input 
                  type="password" 
                  required
                  value={passwords.current}
                  onChange={e => setPasswords({...passwords, current: e.target.value})}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-[#002855] focus:border-[#002855]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Nueva Contraseña (PIN)</label>
                <input 
                  type="password" 
                  required
                  value={passwords.new}
                  onChange={e => setPasswords({...passwords, new: e.target.value})}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-[#002855] focus:border-[#002855]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Confirmar Nueva Contraseña</label>
                <input 
                  type="password" 
                  required
                  value={passwords.confirm}
                  onChange={e => setPasswords({...passwords, confirm: e.target.value})}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-[#002855] focus:border-[#002855]"
                />
              </div>
              <div className="pt-2 flex gap-3">
                <button type="button" onClick={() => setShowPasswordModal(false)} className="flex-1 px-4 py-2 bg-slate-100 text-slate-700 rounded-lg font-bold text-sm">Cancelar</button>
                <button type="submit" disabled={processing} className="flex-1 px-4 py-2 bg-[#002855] text-white rounded-lg font-bold text-sm flex justify-center items-center">
                  {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : "Guardar"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
