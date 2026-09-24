"use client"

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { 
  ArrowLeft, 
  User, 
  CreditCard, 
  Calendar, 
  Award,
  Truck,
  Fuel,
  CheckCircle2,
  Clock
} from 'lucide-react'
import { toast } from 'sonner'

export default function DriverProfile360() {
  const params = useParams()
  const router = useRouter()
  const supabase = createClient()
  const id = params.id as string

  const [loading, setLoading] = useState(true)
  const [profile, setProfile] = useState<any>(null)
  const [driver, setDriver] = useState<any>(null)
  const [performance, setPerformance] = useState<any>(null)
  const [dispatches, setDispatches] = useState<any[]>([])

  useEffect(() => {
    if (id) {
      fetchDriverData()
    }
  }, [id])

  const fetchDriverData = async () => {
    setLoading(true)
    try {
      // 1. Fetch Profile and Driver Data
      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', id)
        .single()

      if (profileError) {
        throw profileError
      }
      setProfile(profileData)

      // Try to fetch specific driver data if separate
      const { data: driverData } = await supabase
        .from('drivers')
        .select('*')
        .or(`id.eq.${id},profile_id.eq.${id}`)
        .maybeSingle()
        
      if (driverData) {
        setDriver(driverData)
      }

      const targetDriverId = driverData ? driverData.id : id;

      // 2. Fetch Performance Metrics
      const { data: perfData, error: perfError } = await supabase
        .from('driver_performance_analytics')
        .select('*')
        .eq('driver_id', targetDriverId)
        .maybeSingle()
      
      if (!perfError && perfData) {
        setPerformance(perfData)
      }

      // 3. Fetch Operational History (dispatches)
      const { data: dispatchesData, error: dispatchesError } = await supabase
        .from('dispatches')
        .select('*')
        .eq('driver_id', targetDriverId)
        .order('created_at', { ascending: false })
        .limit(5)

      if (!dispatchesError && dispatchesData) {
        setDispatches(dispatchesData)
      }

    } catch (error: any) {
      toast.error('Error al cargar el perfil del conductor: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    )
  }

  if (!profile) {
    return (
      <div className="p-6 text-center">
        <h2 className="text-xl font-semibold text-slate-800">Conductor no encontrado</h2>
        <button 
          onClick={() => router.push('/maestros/trabajadores')}
          className="mt-4 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 transition-colors text-white rounded-md"
        >
          Volver a Trabajadores
        </button>
      </div>
    )
  }

  // Combinar datos de licencia si vienen en drivers
  const licenseType = profile.license_type || driver?.license_category || 'No registrado'
  const licenseExp = profile.license_expiration || driver?.license_expiration 
    ? new Date(profile.license_expiration || driver?.license_expiration).toLocaleDateString()
    : 'No registrado'

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <button 
          onClick={() => router.push('/maestros/trabajadores')}
          className="p-2 hover:bg-slate-100 rounded-full transition-colors"
          title="Regresar a Trabajadores"
        >
          <ArrowLeft className="w-5 h-5 text-slate-600" />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Perfil 360 del Conductor</h1>
          <p className="text-slate-500">Vista integral de recursos humanos y desempeño</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Columna Izquierda: Datos Base */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 lg:col-span-1 space-y-6">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center text-2xl font-bold">
              {profile.first_name?.charAt(0) || ''}{profile.last_name?.charAt(0) || ''}
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-800">{profile.first_name} {profile.last_name}</h2>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800">
                {profile.employee_type || 'Conductor'}
              </span>
            </div>
          </div>
          
          <div className="space-y-4 pt-4 border-t border-slate-100">
            <div className="flex items-start gap-3">
              <User className="w-5 h-5 text-slate-400 mt-0.5" />
              <div>
                <p className="text-sm text-slate-500">Documento</p>
                <p className="font-medium text-slate-800">{profile.document_number || 'No registrado'}</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <CreditCard className="w-5 h-5 text-slate-400 mt-0.5" />
              <div>
                <p className="text-sm text-slate-500">Tipo de Licencia</p>
                <p className="font-medium text-slate-800">{licenseType}</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Calendar className="w-5 h-5 text-slate-400 mt-0.5" />
              <div>
                <p className="text-sm text-slate-500">Vencimiento de Licencia</p>
                <p className="font-medium text-slate-800">{licenseExp}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Columna Derecha: Métricas y Historial */}
        <div className="lg:col-span-2 space-y-6">
          
          {/* Métricas de Rendimiento (Cards) */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 bg-emerald-100 text-emerald-600 rounded-lg">
                  <CheckCircle2 className="w-5 h-5" />
                </div>
                <h3 className="text-sm font-medium text-slate-600">Viajes Completados</h3>
              </div>
              <p className="text-2xl font-bold text-slate-800">
                {performance?.total_completed_trips || '0'}
              </p>
            </div>
            
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 bg-blue-100 text-blue-600 rounded-lg">
                  <Fuel className="w-5 h-5" />
                </div>
                <h3 className="text-sm font-medium text-slate-600">Rendimiento Combustible</h3>
              </div>
              <p className="text-2xl font-bold text-slate-800">
                {performance?.avg_fuel_efficiency_km_gal ? `${performance.avg_fuel_efficiency_km_gal} km/gl` : 'N/D'}
              </p>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 bg-purple-100 text-purple-600 rounded-lg">
                  <Award className="w-5 h-5" />
                </div>
                <h3 className="text-sm font-medium text-slate-600">Incidentes Reportados</h3>
              </div>
              <p className="text-2xl font-bold text-slate-800">
                {performance?.total_incidents_reported || '0'}
              </p>
            </div>
          </div>

          {/* Historial Operativo */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="p-5 border-b border-slate-100">
              <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                <Truck className="w-5 h-5 text-indigo-600" />
                Últimos 5 Despachos
              </h3>
            </div>
            
            {dispatches.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-slate-500 uppercase text-xs font-semibold">
                    <tr>
                      <th className="px-5 py-3">Fecha</th>
                      <th className="px-5 py-3">Ruta</th>
                      <th className="px-5 py-3">Estado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {dispatches.map((dispatch) => (
                      <tr key={dispatch.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-5 py-3 text-slate-600">
                          {new Date(dispatch.created_at).toLocaleDateString()}
                        </td>
                        <td className="px-5 py-3 text-slate-800 font-medium">
                          {dispatch.route_name || dispatch.destination || dispatch.route_id || 'Ruta no especificada'}
                        </td>
                        <td className="px-5 py-3">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            dispatch.status === 'ENTREGADO' || dispatch.status === 'LIQUIDADO' ? 'bg-emerald-100 text-emerald-800' :
                            dispatch.status === 'EN_CURSO' || dispatch.status === 'EN RUTA' ? 'bg-blue-100 text-blue-800' :
                            'bg-slate-100 text-slate-800'
                          }`}>
                            {dispatch.status || 'Desconocido'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-8 text-center text-slate-500 flex flex-col items-center">
                <Clock className="w-8 h-8 text-slate-300 mb-2" />
                <p>No hay despachos recientes para este conductor.</p>
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  )
}
