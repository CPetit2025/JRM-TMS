"use client"

import { useState, useEffect, ReactNode } from 'react'
import { MapPinOff, Loader2, Navigation } from 'lucide-react'

interface GPSGuardProps {
  children: ReactNode
}

export default function GPSGuard({ children }: GPSGuardProps) {
  const [permissionGranted, setPermissionGranted] = useState<boolean | null>(null)
  const [location, setLocation] = useState<{ lat: number, lng: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isChecking, setIsChecking] = useState(true)

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setError('Geolocalización no soportada por este navegador.')
      setIsChecking(false)
      return
    }

    // Solicitar y observar la ubicación
    const watchId = navigator.geolocation.watchPosition(
      async (position) => {
        setPermissionGranted(true)
        setIsChecking(false)
        setError(null)
        
        const coords = {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        }
        setLocation(coords)
        
        // MVP: Guardamos en localStorage local
        localStorage.setItem('driver_current_location', JSON.stringify(coords))

        // REALTIME: Emitir a Supabase para que la Torre de Control lo vea en vivo
        const driverData = localStorage.getItem('jrm_driver')
        if (driverData) {
          try {
            const driver = JSON.parse(driverData)
            const supabase = (window as any).supabaseClient || await import('@/lib/supabase/client').then(m => m.createClient())
            ;(window as any).supabaseClient = supabase

            supabase.channel('gps_tracking').send({
              type: 'broadcast',
              event: 'location_update',
              payload: {
                driver_id: driver.id || driver.document_number,
                driver_name: `${driver.first_name} ${driver.last_name}`,
                lat: coords.lat,
                lng: coords.lng,
                timestamp: new Date().toISOString()
              }
            })
          } catch(e) { console.error('Error broadcasting GPS:', e) }
        }
      },
      (err) => {
        setIsChecking(false)
        setPermissionGranted(false)
        if (err.code === 1) {
          setError('Permiso de ubicación denegado.')
        } else if (err.code === 2) {
          setError('Señal GPS no disponible. Active su GPS.')
        } else {
          setError('Error obteniendo la ubicación.')
        }
      },
      {
        enableHighAccuracy: true,
        maximumAge: 10000,
        timeout: 5000
      }
    )

    return () => navigator.geolocation.clearWatch(watchId)
  }, [])

  const requestPermission = () => {
    setIsChecking(true)
    setError(null)
    navigator.geolocation.getCurrentPosition(
      () => {
        setPermissionGranted(true)
        setIsChecking(false)
      },
      (err) => {
        setIsChecking(false)
        setPermissionGranted(false)
        setError('Debes permitir el acceso al GPS en la configuración de tu navegador.')
      }
    )
  }

  if (isChecking) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-6 text-center">
        <Loader2 className="w-12 h-12 text-blue-500 animate-spin mb-4" />
        <h2 className="text-xl font-bold text-white mb-2">Verificando GPS...</h2>
        <p className="text-slate-400">Obteniendo coordenadas de seguridad.</p>
      </div>
    )
  }

  if (permissionGranted === false || error) {
    return (
      <div className="min-h-screen bg-red-950 flex flex-col items-center justify-center p-6 text-center">
        <div className="w-20 h-20 bg-red-900/50 rounded-full flex items-center justify-center mb-6 border border-red-500/30">
          <MapPinOff className="w-10 h-10 text-red-500" />
        </div>
        
        <h1 className="text-2xl font-bold text-white mb-3">Acceso Bloqueado</h1>
        <p className="text-red-200 mb-8 max-w-sm">
          Por políticas de seguridad y operación, es <strong>obligatorio</strong> mantener el GPS encendido y otorgar permisos de ubicación para utilizar el portal de conductor.
        </p>
        
        <div className="bg-red-900/40 p-4 rounded-xl border border-red-800 mb-8 max-w-sm w-full text-left">
          <p className="text-sm text-red-300 font-semibold mb-2">Estado: {error}</p>
          <ul className="text-xs text-red-400 space-y-1 list-disc pl-4">
            <li>Asegúrate de que el GPS (Ubicación) de tu celular esté encendido.</li>
            <li>Si denegaste el permiso, entra a la configuración del navegador (candado en la barra de URL) y permite el acceso a la ubicación.</li>
          </ul>
        </div>

        <button 
          onClick={requestPermission}
          className="bg-white text-red-900 px-6 py-3 rounded-xl font-bold shadow-lg hover:bg-red-50 transition-colors flex items-center gap-2"
        >
          <Navigation className="w-5 h-5" />
          Reintentar Conexión GPS
        </button>
      </div>
    )
  }

  return (
    <>
      {children}
      {/* Indicador persistente pequeño de GPS Activo */}
      <div className="fixed top-4 left-1/2 -translate-x-1/2 bg-green-500/90 text-white text-[10px] font-bold px-3 py-1 rounded-full shadow-md z-50 flex items-center gap-1.5 backdrop-blur-sm pointer-events-none">
        <div className="w-1.5 h-1.5 bg-white rounded-full animate-pulse"></div>
        GPS EN LÍNEA
      </div>
    </>
  )
}
