"use client"

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { Truck, Search, AlertCircle, Navigation, MapPin, Activity, Radio, Layers, CheckCircle2, Clock, Plus, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'

const MapComponent = dynamic(() => import('@/components/map/MapComponent'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full bg-slate-100 flex flex-col items-center justify-center text-slate-400 rounded-xl border border-slate-200">
      <div className="w-10 h-10 border-4 border-[#002855] border-t-transparent rounded-full animate-spin mb-4"></div>
      <p className="font-medium">Cargando mapa en tiempo real...</p>
    </div>
  )
})

interface Dispatch {
  id: string
  dispatch_number: string
  vehicle_plate: string
  driver_name: string
  status: string
}

interface VehicleLocation {
  id: string // dispatch_id
  plate: string
  driver: string
  status: 'en_ruta' | 'detenido' | 'incidencia'
  speed: number
  lat: number
  lng: number
  lastUpdate: string
}

export default function MonitoreoPage() {
  const supabase = createClient()
  const [vehicles, setVehicles] = useState<VehicleLocation[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null)
  const [showGeofences, setShowGeofences] = useState(true)
  const [filterStatus, setFilterStatus] = useState<'all' | 'en_ruta' | 'detenido' | 'incidencia'>('all')
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())

  // Modal Novedad
  const [isEventModalOpen, setIsEventModalOpen] = useState(false)
  const [eventType, setEventType] = useState('CHECKPOINT')
  const [eventDescription, setEventDescription] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    fetchActiveDispatches()

    const channel = supabase.channel('monitoreo_dispatches')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dispatches' }, () => {
        fetchActiveDispatches()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  // Geocercas simuladas para coordenadas estáticas según despacho
  const mockCoordinates = [
    { lat: -12.0464, lng: -77.0428 }, // Lima Centro
    { lat: -12.0234, lng: -77.0123 }, // Rimac
    { lat: -12.0621, lng: -77.0368 }, // Lince
    { lat: -12.0834, lng: -77.0350 }, // San Isidro
    { lat: -12.1223, lng: -77.0310 }, // Miraflores
    { lat: -12.1465, lng: -77.0220 }, // Barranco
    { lat: -12.0931, lng: -77.0802 }, // San Miguel
    { lat: -12.0553, lng: -77.0850 }, // Callao
    { lat: -12.0205, lng: -76.9360 }, // Ate
    { lat: -11.9803, lng: -77.0019 }, // SJL
  ]

  const fetchActiveDispatches = async () => {
    try {
      const { data, error } = await supabase
        .from('dispatches')
        .select('id, dispatch_number, vehicle_plate, driver_name, status')
        .eq('status', 'EN_CURSO')

      if (error) throw error

      setLastRefresh(new Date())
      
      if (data) {
        // Mapear despachos reales a ubicaciones ficticias para visualización
        const mappedVehicles: VehicleLocation[] = data.map((d, index) => {
          const coord = mockCoordinates[index % mockCoordinates.length]
          return {
            id: d.id, // Usamos el ID del despacho como ID del vehículo en el mapa
            plate: d.vehicle_plate,
            driver: d.driver_name,
            status: 'en_ruta',
            speed: Math.floor(Math.random() * (60 - 20 + 1) + 20), // 20-60 km/h
            lat: coord.lat,
            lng: coord.lng,
            lastUpdate: new Date().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })
          }
        })
        setVehicles(mappedVehicles)
      }
    } catch (err) {
      console.error('Error fetching active dispatches:', err)
      toast.error('Error al cargar la flota activa.')
    }
  }

  const handleRegisterEvent = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedVehicleId) return

    setIsSubmitting(true)
    try {
      // 1. Registrar el evento
      const { error: eventError } = await supabase
        .from('dispatch_events')
        .insert([{
          dispatch_id: selectedVehicleId,
          event_type: eventType,
          description: eventDescription,
          created_by: 'Operador GPS'
        }])

      if (eventError) throw eventError

      // 2. Si es FIN_RUTA o ENTREGA_CONFIRMADA, actualizar estado del despacho
      if (eventType === 'FIN_RUTA' || eventType === 'ENTREGA_CONFIRMADA') {
        const { error: dispatchError } = await supabase
          .from('dispatches')
          .update({ status: 'ENTREGADO' })
          .eq('id', selectedVehicleId)

        if (dispatchError) throw dispatchError
        toast.success('Ruta finalizada correctamente.')
        setSelectedVehicleId(null)
      } else {
        toast.success('Novedad registrada exitosamente.')
      }

      setIsEventModalOpen(false)
      setEventDescription('')
      setEventType('CHECKPOINT')
      
      // No necesitamos llamar a fetchActiveDispatches manualmente si no es fin_ruta
      // pero por si acaso, refrescamos.
      fetchActiveDispatches()

    } catch (error: any) {
      toast.error('Error al registrar novedad: ' + error.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const activeCount = vehicles.filter(v => v.status === 'en_ruta').length
  const stoppedCount = vehicles.filter(v => v.status === 'detenido').length
  const issueCount = vehicles.filter(v => v.status === 'incidencia').length

  const filteredVehicles = vehicles.filter(v => {
    const matchSearch = v.plate.toLowerCase().includes(searchTerm.toLowerCase()) ||
      v.driver.toLowerCase().includes(searchTerm.toLowerCase())
    const matchFilter = filterStatus === 'all' || v.status === filterStatus
    return matchSearch && matchFilter
  })

  const selectedVehicle = vehicles.find(v => v.id === selectedVehicleId)

  return (
    <div className="h-[calc(100vh-2rem)] flex flex-col gap-3">
      
      {/* Header con KPIs */}
      <div className="flex items-center justify-between bg-white px-5 py-3 rounded-xl shadow-sm border border-slate-200 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-[#002855] rounded-lg flex items-center justify-center">
            <Navigation className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-black text-slate-800 leading-tight">Monitoreo GPS</h1>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
              <p className="text-xs text-slate-500">Seguimiento en tiempo real de despachos EN CURSO</p>
            </div>
          </div>
        </div>

        <div className="flex gap-3">
          {/* KPI: En Ruta */}
          <div className="bg-green-50 border border-green-200 px-4 py-2 rounded-xl flex items-center gap-3">
            <div className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" />
            <div>
              <p className="text-[10px] text-green-700 font-bold uppercase tracking-wide">En Ruta</p>
              <p className="text-2xl font-black text-green-800 leading-none">{activeCount}</p>
            </div>
          </div>

          {/* Última actualización */}
          <div className="bg-slate-50 border border-slate-200 px-4 py-2 rounded-xl flex items-center gap-2">
            <Clock className="w-4 h-4 text-slate-400" />
            <div>
              <p className="text-[10px] text-slate-500 font-medium">Última señal</p>
              <p className="text-xs font-bold text-slate-700">
                {lastRefresh.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex gap-3 min-h-0">

        {/* Panel Lateral — Lista de Flota */}
        <div className="w-72 bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col shrink-0 overflow-hidden">
          
          {/* Search + Filter */}
          <div className="p-3 border-b border-slate-100 bg-slate-50 space-y-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-400" />
              <input
                type="text"
                placeholder="Buscar placa o conductor..."
                className="w-full pl-8 pr-3 py-2 bg-white text-slate-900 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#002855]"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          </div>

          {/* Vehicle list */}
          <div className="flex-1 overflow-y-auto divide-y divide-slate-50">
            {filteredVehicles.length === 0 ? (
              <div className="p-8 text-center text-slate-400">
                <Radio className="w-8 h-8 mx-auto mb-3 opacity-30" />
                <p className="text-sm font-medium">Sin Despachos Activos</p>
                <p className="text-xs mt-1 opacity-70">
                  {vehicles.length === 0
                    ? 'No hay rutas en curso actualmente'
                    : 'No coincide con la búsqueda'}
                </p>
              </div>
            ) : (
              filteredVehicles.map(vehicle => (
                <div
                  key={vehicle.id}
                  onClick={() => setSelectedVehicleId(vehicle.id === selectedVehicleId ? null : vehicle.id)}
                  className={`p-3 cursor-pointer transition-all ${
                    selectedVehicleId === vehicle.id
                      ? 'bg-blue-50 border-l-4 border-l-[#002855]'
                      : 'hover:bg-slate-50 border-l-4 border-l-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center ${
                        vehicle.status === 'en_ruta' && vehicle.speed > 5 ? 'bg-green-100' :
                        vehicle.status === 'incidencia' ? 'bg-red-100' : 'bg-orange-100'
                      }`}>
                        <Truck className={`w-3.5 h-3.5 ${
                          vehicle.status === 'en_ruta' && vehicle.speed > 5 ? 'text-green-600' :
                          vehicle.status === 'incidencia' ? 'text-red-600' : 'text-orange-500'
                        }`} />
                      </div>
                      <div>
                        <p className="text-xs font-bold text-slate-800">{vehicle.plate}</p>
                        <p className="text-[10px] text-slate-500">{vehicle.driver}</p>
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-between text-[10px] text-slate-500 pl-9">
                    <span className="flex items-center gap-1">
                      <Activity className="w-3 h-3" />
                      {vehicle.speed} km/h
                    </span>
                    <span className="flex items-center gap-1">
                      <MapPin className="w-3 h-3" />
                      {vehicle.lastUpdate}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Map area */}
        <div className="flex-1 relative rounded-xl overflow-hidden border border-slate-200">
          <MapComponent
            vehicles={vehicles}
            selectedVehicleId={selectedVehicleId}
            onVehicleSelect={setSelectedVehicleId}
            showGeofences={showGeofences}
          />

          {/* Selected vehicle detail overlay */}
          {selectedVehicle && (
            <div className="absolute bottom-4 left-4 bg-white rounded-xl shadow-xl border border-slate-200 p-4 min-w-[280px] z-[500]">
              <div className="flex items-center justify-between mb-3 border-b border-slate-100 pb-2">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-green-500 animate-pulse" />
                  <span className="font-black text-[#002855] text-lg">{selectedVehicle.plate}</span>
                </div>
                <button
                  onClick={() => setSelectedVehicleId(null)}
                  className="text-slate-400 hover:text-slate-600 text-lg leading-none"
                >×</button>
              </div>
              
              <div className="space-y-3 mb-4">
                <p className="text-sm text-slate-600">
                  <span className="font-semibold block text-[10px] uppercase tracking-wide text-slate-400">Conductor</span>
                  {selectedVehicle.driver}
                </p>
              </div>
              
              <div className="grid grid-cols-2 gap-2 mb-4">
                <div className="bg-slate-50 rounded-lg p-2 text-center border border-slate-100">
                  <p className="text-[9px] text-slate-400 font-bold uppercase">Velocidad</p>
                  <p className="text-xl font-black text-slate-800">{selectedVehicle.speed}</p>
                  <p className="text-[9px] text-slate-400">km/h</p>
                </div>
                <div className="bg-slate-50 rounded-lg p-2 text-center border border-slate-100 flex flex-col justify-center">
                  <p className="text-[9px] text-slate-400 font-bold uppercase">Señal</p>
                  <p className="text-xs font-bold text-green-600 mt-1">{selectedVehicle.lastUpdate}</p>
                </div>
              </div>
              
              <div className="flex flex-col gap-2 border-t border-slate-100 pt-3">
                <button 
                  onClick={() => setIsEventModalOpen(true)}
                  className="w-full flex justify-center items-center gap-2 bg-[#002855] text-white py-2 rounded-lg text-xs font-semibold hover:bg-[#001f42] transition-colors"
                >
                  <Plus className="w-4 h-4" /> Registrar Novedad
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <Modal
        isOpen={isEventModalOpen}
        onClose={() => setIsEventModalOpen(false)}
        title={`Registrar Novedad - ${selectedVehicle?.plate}`}
        maxWidth="max-w-md"
      >
        <form onSubmit={handleRegisterEvent} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Tipo de Evento</label>
            <select
              required
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#002855]"
            >
              <option value="CHECKPOINT">Punto de Control (Checkpoint)</option>
              <option value="LLEGADA_CLIENTE">Llegada a Cliente</option>
              <option value="SALIDA_CLIENTE">Salida de Cliente</option>
              <option value="RETRASO">Retraso / Tráfico</option>
              <option value="INCIDENCIA">Incidencia (Avería/Siniestro)</option>
              <option value="FIN_RUTA" className="text-emerald-700 font-bold">▶ Finalizar Ruta (Entregado)</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Descripción / Observaciones</label>
            <textarea
              required
              rows={3}
              value={eventDescription}
              onChange={(e) => setEventDescription(e.target.value)}
              placeholder="Detalles del reporte..."
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#002855]"
            ></textarea>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
            <button
              type="button"
              onClick={() => setIsEventModalOpen(false)}
              className="px-4 py-2 text-sm font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex items-center gap-2 bg-[#002855] text-white px-6 py-2 rounded-lg font-medium hover:bg-[#001f42] transition-colors disabled:opacity-50"
            >
              {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Guardar Reporte
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
