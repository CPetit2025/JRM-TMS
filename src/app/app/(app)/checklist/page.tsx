"use client"
import { useState, useEffect, useMemo } from 'react'
import { Camera, CheckCircle, MapPin, AlertTriangle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'

import { createClient } from '@/lib/supabase/client'
import { useActiveTrip } from '@/contexts/ActiveTripContext'

export default function ChecklistPage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { driver, trip, loading: contextLoading, refresh } = useActiveTrip()
  const [checkingLocation, setCheckingLocation] = useState(true)
  const [locationValid, setLocationValid] = useState(false)
  const [hasDispatch, setHasDispatch] = useState(false)
  const [dispatchId, setDispatchId] = useState<string | null>(null)
  const [driverId, setDriverId] = useState<string | null>(null)
  const [vehiclePlate, setVehiclePlate] = useState<string | null>(null)
  const [gps, setGps] = useState<{lat: number; lon: number} | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [currentDistanceInfo, setCurrentDistanceInfo] = useState<string | null>(null)
  const [missingReason, setMissingReason] = useState('No existe una ruta asignada.')
  
  const [checklist, setChecklist] = useState<Record<string, 'OK' | 'MAL' | null | string>>({
    llantas: null,
    aceite: null,
    luces: null,
    frenos: null,
    combustible: null,
    observaciones: '',
    odometro: ''
  })
  
  const [photo, setPhoto] = useState<string | null>(null)
  const [photoFile, setPhotoFile] = useState<File | null>(null)

  useEffect(() => {
    // Restaurar estado guardado
    const saved = localStorage.getItem('jrm_checklist_state')
    let restoreTimer: number | undefined
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as { checklist?: Record<string, 'OK' | 'MAL' | null | string> }
        if (parsed.checklist) restoreTimer = window.setTimeout(() => setChecklist(parsed.checklist!), 0)
      } catch (e) {
        console.error(e)
      }
    }
    
    // FunciÃ³n para verificar ubicaciÃ³n contra BD y estado de despacho
    const verifyPrerequisites = async () => {
      try {
        if (contextLoading) return
        if (!driver) {
          setMissingReason('No existe un conductor activo asociado a tu usuario.')
          setCheckingLocation(false)
          return
        }
        setDriverId(driver.id)
        if (!trip) {
          setMissingReason('No existe una ruta asignada.')
          setHasDispatch(false); setCheckingLocation(false); return
        }
        if (!trip.vehicle_plate) {
          setMissingReason('La ruta no tiene una unidad o placa asignada.')
          setHasDispatch(false); setCheckingLocation(false); return
        }
        if (!['PROGRAMADO', 'EN_CURSO'].includes(trip.status)) {
          setMissingReason(`El checklist no corresponde al estado actual: ${trip.status}.`)
          setHasDispatch(false); setCheckingLocation(false); return
        }
        setHasDispatch(true); setDispatchId(trip.id); setVehiclePlate(trip.vehicle_plate)

        if ("geolocation" in navigator) {
          navigator.geolocation.getCurrentPosition(
            async (position) => {
              const { latitude, longitude } = position.coords
              setGps({ lat: latitude, lon: longitude })
              const { data: validation, error: validationError } = await supabase.rpc(
                'validate_operational_geofence', { p_lat: latitude, p_lon: longitude })
              const result = validation as { valid?: boolean; zone_name?: string; reason?: string } | null
              if (!validationError && result?.valid) {
                setLocationValid(true)
                setCurrentDistanceInfo(`Zona autorizada: ${result.zone_name || 'Base operativa'}`)
              } else {
                setLocationValid(false)
                const reason = result?.reason || validationError?.message || 'Fuera de geocerca autorizada.'
                setCurrentDistanceInfo(reason)
                toast.error(`${reason} No puedes completar el checklist.`, { duration: 5000 })
              }
              setCheckingLocation(false)
            },
            (error) => {
              console.error("Error GPS:", error.message || "Error desconocido")
              toast.error("No se pudo obtener la ubicaciÃ³n para validar geocerca.")
              setCheckingLocation(false)
            },
            { enableHighAccuracy: true, timeout: 30000, maximumAge: 60000 }
          )
        } else {
          toast.error("Tu dispositivo no soporta GPS.")
          setCheckingLocation(false)
        }
      } catch (err) {
        console.error(err)
        setCheckingLocation(false)
      }
    }

    void verifyPrerequisites()
    return () => { if (restoreTimer) window.clearTimeout(restoreTimer) }
  }, [contextLoading, driver, trip, supabase])

  const handlePhotoCapture = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      const imageUrl = URL.createObjectURL(file)
      setPhoto(imageUrl)
      setPhotoFile(file)
    }
  }

  const updateChecklist = (key: string, value: 'OK' | 'MAL' | null | string) => {
    const newChecklist = { ...checklist, [key]: value }
    setChecklist(newChecklist)
    localStorage.setItem('jrm_checklist_state', JSON.stringify({ checklist: newChecklist }))
  }

  const handleSubmit = async () => {
    const allChecked = Object.entries(checklist).filter(([k]) => k !== 'observaciones' && k !== 'odometro').every(([, value]) => value !== null)
    if (!allChecked) {
      toast.error('Debes validar todos los puntos de seguridad')
      return
    }
    if (!checklist.odometro || isNaN(Number(checklist.odometro))) {
      toast.error('Debes ingresar un kilometraje válido (odómetro)')
      return
    }
    if (!photoFile) {
      toast.error('Es obligatorio subir una foto de evidencia del vehÃ­culo')
      return
    }

    if (!dispatchId || !driverId || !gps || !locationValid) {
      toast.error('Falta una ruta asignada o una ubicaciÃ³n validada.')
      return
    }
    setSubmitting(true)
    try {
      const { data: userData } = await supabase.auth.getUser()
      if (!userData.user) throw new Error('SesióÃ³n expirada')
      const filePath = `${userData.user.id}/${dispatchId}/checklist/${crypto.randomUUID()}-${photoFile.name}`
      const { error: uploadError } = await supabase.storage.from('driver_evidence')
        .upload(filePath, photoFile, { upsert: false, contentType: photoFile.type })
      if (uploadError) throw uploadError
      const { error: saveError } = await supabase.from('driver_checklists').insert({
        dispatch_id: dispatchId, driver_id: driverId, vehicle_plate: vehiclePlate,
        checklist_data: checklist, photo_url: filePath,
        location_lat: gps.lat, location_lon: gps.lon,
        is_approved: Object.entries(checklist).filter(([key]) => key !== 'observaciones' && key !== 'odometro').every(([, value]) => value === 'OK')
      })
      if (saveError) {
        await supabase.storage.from('driver_evidence').remove([filePath])
        throw saveError
      }

      const { error: odoError } = await supabase.rpc('record_odometer_reading', {
        p_vehicle_plate: vehiclePlate,
        p_odometer_value: Number(checklist.odometro),
        p_photo_url: filePath,
        p_source_event: 'INICIO_RUTA',
        p_dispatch_id: dispatchId
      })
      if (odoError) console.warn('Error odometro:', odoError)
      localStorage.removeItem('jrm_checklist_state')
      toast.success('Checklist y fotografÃ­a guardados.')
      await refresh()
      router.push('/app/ruta')
    } catch (error) {
      toast.error('No se pudo guardar el checklist: ' + (error instanceof Error ? error.message : 'Error desconocido'))
    } finally { setSubmitting(false) }
  }

  return (
    <div className="min-h-full bg-slate-100 pb-6">
      {/* Page Header */}
      <div className="bg-white border-b border-slate-200 px-4 py-4 mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center">
            <CheckCircle className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h1 className="text-lg font-black text-[#002855]">Checklist Pre-Ruta</h1>
            <p className="text-xs text-slate-500">InspecciÃ³n obligatoria de la unidad</p>
          </div>
        </div>
      </div>

      <div className="px-4 max-w-md mx-auto space-y-4">
      {checkingLocation ? (
        <div className="bg-blue-50 border border-blue-200 rounded-2xl p-6 flex flex-col items-center justify-center text-center">
          <Loader2 className="w-8 h-8 text-blue-600 animate-spin mb-3" />
          <h3 className="font-bold text-blue-900">Verificando Datos...</h3>
          <p className="text-xs text-blue-700 mt-1">Verificando ubicaciÃ³n y rutas...</p>
        </div>
      ) : !hasDispatch ? (
        <div className="bg-orange-50 border border-orange-200 rounded-2xl p-6 flex flex-col items-center text-center mt-10">
          <div className="w-14 h-14 rounded-full bg-orange-100 flex items-center justify-center mb-3">
            <AlertTriangle className="w-7 h-7 text-orange-500" />
          </div>
          <h3 className="font-black text-orange-900 text-base">Requisito Pendiente</h3>
          <p className="text-sm text-orange-700 mt-2">
            {missingReason}
          </p>
          <button
            onClick={() => router.push('/app/ruta')}
            className="mt-6 px-6 py-3 bg-[#002855] text-white rounded-xl text-sm font-bold shadow-md hover:bg-[#001d3d] transition-colors"
          >
            Volver a Mi Ruta
          </button>
        </div>
      ) : !locationValid ? (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-6 flex flex-col items-center text-center">
          <div className="w-14 h-14 rounded-full bg-red-100 flex items-center justify-center mb-3">
            <AlertTriangle className="w-7 h-7 text-red-500" />
          </div>
          <h3 className="font-black text-red-900 text-base">Fuera de Base Autorizada</h3>
          <p className="text-sm text-red-700 mt-2">
            El sistema detecta que no estÃ¡s en una base o cochera autorizada.
            {currentDistanceInfo ? ` ${currentDistanceInfo}` : ' AcÃ©rcate a la base para desbloquear el checklist.'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="bg-green-50 border border-green-200 rounded-xl p-3 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center">
              <MapPin className="w-4 h-4 text-green-600" />
            </div>
            <span className="text-sm font-bold text-green-800">UbicaciÃ³n dentro de geocerca autorizada</span>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="bg-slate-50 px-4 py-3 border-b border-slate-100">
              <h3 className="font-bold text-slate-800 text-sm">Puntos de RevisiÃ³n Obligatorios</h3>
            </div>
            <div className="divide-y divide-slate-100">
              {[
                { id: 'llantas', label: 'Estado de Llantas y PresiÃ³n' },
                { id: 'aceite', label: 'Niveles de Aceite y Agua' },
                { id: 'luces', label: 'Luces, Direccionales y Focos' },
                { id: 'frenos', label: 'Sistema de Frenos (Aire/LÃ­quido)' },
                { id: 'combustible', label: 'Tanque de Combustible lleno' },
              ].map((item) => {
                const val = checklist[item.id]
                return (
                  <div key={item.id} className="flex flex-col gap-2 p-4 hover:bg-slate-50 transition-colors">
                    <span className="text-sm font-semibold text-slate-800">{item.label}</span>
                    <div className="flex gap-2">
                      <button
                        onClick={() => updateChecklist(item.id, 'OK')}
                        className={`flex-1 py-2.5 rounded-xl font-bold text-xs border-2 transition-all ${val === 'OK' ? 'bg-green-500 border-green-500 text-white shadow-sm' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                      >
                        âœ” OK
                      </button>
                      <button
                        onClick={() => updateChecklist(item.id, 'MAL')}
                        className={`flex-1 py-2.5 rounded-xl font-bold text-xs border-2 transition-all ${val === 'MAL' ? 'bg-red-500 border-red-500 text-white shadow-sm' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                      >
                        âœ– MALO
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-100">
              <label className="block text-xs font-bold text-slate-600 mb-2 uppercase tracking-wide">Odómetro Actual (km)</label>
              <input
                type="number"
                min="0"
                step="1"
                className="w-full px-3 py-2.5 rounded-xl border-2 border-slate-200 focus:border-[#002855] outline-none text-sm text-slate-900 bg-white transition-colors mb-4"
                placeholder="Ej. 125500"
                value={checklist.odometro as string}
                onChange={(e) => updateChecklist('odometro', e.target.value)}
              />

              <label className="block text-xs font-bold text-slate-600 mb-2 uppercase tracking-wide">Observaciones Generales</label>
              <textarea
                className="w-full px-3 py-2.5 rounded-xl border-2 border-slate-200 focus:border-[#002855] outline-none text-sm text-slate-900 bg-white resize-none transition-colors"
                rows={2}
                placeholder="Ej. Parachoque con ligero quiÃ±e..."
                value={checklist.observaciones as string}
                onChange={(e) => updateChecklist('observaciones', e.target.value)}
              />
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
              <h3 className="font-bold text-slate-800 text-sm">Evidencia FotogrÃ¡fica Frontal</h3>
            </div>
            <div className="p-4">
              {photo ? (
                <div className="relative rounded-xl overflow-hidden border-2 border-slate-200">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photo} alt="Evidencia" className="w-full h-48 object-cover" />
                  <button
                    onClick={() => { setPhoto(null); setPhotoFile(null) }}
                    className="absolute top-2 right-2 bg-black/60 text-white text-xs px-3 py-1 rounded-full font-bold"
                  >
                    Cambiar
                  </button>
                </div>
              ) : (
                <label className="border-2 border-dashed border-slate-300 rounded-xl h-32 flex flex-col items-center justify-center cursor-pointer hover:bg-slate-50 hover:border-[#002855] transition-all group">
                  <Camera className="w-8 h-8 text-slate-400 group-hover:text-[#002855] mb-2 transition-colors" />
                  <span className="text-sm font-bold text-slate-500 group-hover:text-[#002855] transition-colors">Tomar Foto del VehÃ­culo</span>
                  <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePhotoCapture} />
                </label>
              )}
            </div>
          </div>

          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="w-full bg-[#002855] text-white py-4 rounded-2xl font-black text-base shadow-lg hover:bg-[#001f44] active:scale-95 flex justify-center items-center gap-2 transition-all"
          >
            {submitting ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle className="w-5 h-5" />}
            Guardar y Habilitar Ruta
          </button>
        </div>
      )}
      </div>
    </div>
  )
}
