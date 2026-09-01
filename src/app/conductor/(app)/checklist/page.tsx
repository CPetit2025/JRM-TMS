"use client"
import { useState, useEffect } from 'react'
import { Camera, CheckCircle, MapPin, AlertTriangle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'

const PLANTA_CHILCA = { lat: -12.5204, lon: -76.7371 }
const GEOFENCE_RADIUS_KM = 0.5 // 500 metros de tolerancia

// Fórmula de Haversine para distancia en KM
function getDistanceFromLatLonInKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371 // Radio de la tierra
  const dLat = (lat2 - lat1) * (Math.PI / 180)
  const dLon = (lon2 - lon1) * (Math.PI / 180)
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) 
  return R * c
}

export default function ChecklistPage() {
  const router = useRouter()
  const [checkingLocation, setCheckingLocation] = useState(true)
  const [locationValid, setLocationValid] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  
  const [checklist, setChecklist] = useState<Record<string, 'OK' | 'MAL' | null | string>>({
    llantas: null,
    aceite: null,
    luces: null,
    frenos: null,
    combustible: null,
    observaciones: ''
  })
  
  const [photo, setPhoto] = useState<string | null>(null)

  useEffect(() => {
    // Restaurar estado guardado
    const saved = localStorage.getItem('jrm_checklist_state')
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        if (parsed.checklist) setChecklist(parsed.checklist)
        if (parsed.photo) setPhoto(parsed.photo)
      } catch (e) {
        console.error(e)
      }
    }
    // Verificar Geocerca al cargar
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude } = position.coords
          const distance = getDistanceFromLatLonInKm(latitude, longitude, PLANTA_CHILCA.lat, PLANTA_CHILCA.lon)
          
          if (distance <= GEOFENCE_RADIUS_KM) {
            setLocationValid(true)
          } else {
            // Permitir bypass para efectos de demostración si estamos muy lejos
            setLocationValid(false) 
            toast.error(`Estás a ${distance.toFixed(1)} KM de la base. No puedes iniciar.`, { duration: 5000 })
          }
          setCheckingLocation(false)
        },
        (error) => {
          console.error("Error GPS:", error.message || "Error desconocido")
          toast.error("No se pudo obtener la ubicación para validar geocerca.")
          setCheckingLocation(false)
        },
        { enableHighAccuracy: true, timeout: 30000, maximumAge: 60000 }
      )
    } else {
      toast.error("Tu dispositivo no soporta GPS.")
      setCheckingLocation(false)
    }
  }, [])

  const handlePhotoCapture = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      const imageUrl = URL.createObjectURL(file)
      setPhoto(imageUrl)
      localStorage.setItem('jrm_checklist_state', JSON.stringify({ checklist, photo: imageUrl }))
    }
  }

  const updateChecklist = (key: string, value: any) => {
    const newChecklist = { ...checklist, [key]: value }
    setChecklist(newChecklist)
    localStorage.setItem('jrm_checklist_state', JSON.stringify({ checklist: newChecklist, photo }))
  }

  const handleSubmit = async () => {
    const allChecked = Object.entries(checklist).filter(([k]) => k !== 'observaciones').every(([_, v]) => v !== null)
    if (!allChecked) {
      toast.error('Debes validar todos los puntos de seguridad')
      return
    }
    if (!photo) {
      toast.error('Es obligatorio subir una foto de evidencia del vehículo')
      return
    }

    setSubmitting(true)
    // Simular guardado en BD
    await new Promise(r => setTimeout(r, 1500))
    toast.success('Checklist guardado con éxito')
    router.push('/conductor/ruta')
  }

  // Bypass para demos
  const enableBypass = () => {
    setLocationValid(true)
    toast.success("Bypass de GPS activado para la demostración")
  }

  return (
    <div className="p-4 max-w-md mx-auto">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-[#002855]">Checklist Pre-Ruta</h2>
        <p className="text-slate-500 text-sm">Inspección obligatoria de la unidad</p>
      </div>

      {checkingLocation ? (
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-6 flex flex-col items-center justify-center text-center mb-6">
          <Loader2 className="w-8 h-8 text-blue-600 animate-spin mb-3" />
          <h3 className="font-bold text-blue-900">Verificando Cerco de Seguridad</h3>
          <p className="text-xs text-blue-700 mt-1">Obteniendo coordenadas GPS...</p>
        </div>
      ) : !locationValid ? (
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 flex flex-col items-center text-center mb-6">
          <AlertTriangle className="w-10 h-10 text-red-500 mb-3" />
          <h3 className="font-bold text-red-900">Fuera de Base Autorizada</h3>
          <p className="text-sm text-red-700 mt-2">
            El sistema detecta que no estás en Planta Chilca o en una cochera autorizada. 
            Acércate a la base para desbloquear el checklist.
          </p>
          <button 
            onClick={enableBypass}
            className="mt-4 px-4 py-2 bg-red-100 text-red-800 rounded-lg text-xs font-bold uppercase tracking-wider"
          >
            Bypass Demo
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 flex items-center gap-3">
            <MapPin className="w-5 h-5 text-green-600" />
            <span className="text-sm font-semibold text-green-800">Ubicación Validada (Planta Chilca)</span>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="bg-slate-50 px-4 py-3 border-b border-slate-200">
              <h3 className="font-bold text-slate-800">Puntos de Revisión</h3>
            </div>
            <div className="divide-y divide-slate-100">
              {[
                { id: 'llantas', label: 'Estado de Llantas y Presión' },
                { id: 'aceite', label: 'Niveles de Aceite y Agua' },
                { id: 'luces', label: 'Luces, Direccionales y Focos' },
                { id: 'frenos', label: 'Sistema de Frenos (Aire/Líquido)' },
                { id: 'combustible', label: 'Tanque de Combustible lleno' },
              ].map((item) => {
                const val = checklist[item.id]
                return (
                  <div key={item.id} className="flex flex-col gap-2 p-4 border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors">
                    <span className="text-sm font-semibold text-slate-800">{item.label}</span>
                    <div className="flex gap-2">
                      <button 
                        onClick={() => updateChecklist(item.id, 'OK')}
                        className={`flex-1 py-2 rounded-lg font-bold text-xs border ${val === 'OK' ? 'bg-green-100 border-green-300 text-green-800 shadow-sm' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                      >
                        ✔ OK
                      </button>
                      <button 
                        onClick={() => updateChecklist(item.id, 'MAL')}
                        className={`flex-1 py-2 rounded-lg font-bold text-xs border ${val === 'MAL' ? 'bg-red-100 border-red-300 text-red-800 shadow-sm' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                      >
                        ✖ MALO
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
            
            <div className="p-4 bg-slate-50 border-t border-slate-200">
              <label className="block text-xs font-semibold text-slate-700 mb-2">Observaciones Generales</label>
              <textarea 
                className="w-full rounded-lg border-slate-300 text-sm focus:ring-[#002855] focus:border-[#002855]"
                rows={2}
                placeholder="Ej. Parachoque con ligero quiñe..."
                value={checklist.observaciones as string}
                onChange={(e) => updateChecklist('observaciones', e.target.value)}
              />
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 text-center">
            <h3 className="font-bold text-slate-800 text-sm mb-3">Evidencia Fotográfica Frontal</h3>
            
            {photo ? (
              <div className="relative rounded-lg overflow-hidden border border-slate-200">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photo} alt="Evidencia" className="w-full h-48 object-cover" />
                <button 
                  onClick={() => setPhoto(null)}
                  className="absolute top-2 right-2 bg-black/50 text-white text-xs px-2 py-1 rounded"
                >
                  Cambiar
                </button>
              </div>
            ) : (
              <label className="border-2 border-dashed border-slate-300 rounded-lg h-32 flex flex-col items-center justify-center cursor-pointer hover:bg-slate-50 hover:border-[#002855] transition-colors">
                <Camera className="w-8 h-8 text-slate-400 mb-2" />
                <span className="text-sm font-semibold text-[#002855]">Tomar Foto (Cámara)</span>
                {/* Atributo capture="environment" abre la cámara trasera en celulares */}
                <input 
                  type="file" 
                  accept="image/*" 
                  capture="environment" 
                  className="hidden" 
                  onChange={handlePhotoCapture}
                />
              </label>
            )}
          </div>

          <button 
            onClick={handleSubmit}
            disabled={submitting}
            className="w-full bg-[#002855] text-white py-4 rounded-xl font-bold text-lg shadow-lg hover:bg-[#001f44] flex justify-center items-center gap-2"
          >
            {submitting ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle className="w-5 h-5" />}
            Guardar y Habilitar Ruta
          </button>
        </div>
      )}
    </div>
  )
}
