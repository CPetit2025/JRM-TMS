"use client"
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, Truck, Calendar, Settings, AlertTriangle, FileText, Wrench, BarChart2, CheckCircle2 } from 'lucide-react'
import Link from 'next/link'

export default function Flota360Page() {
  const params = useParams()
  const router = useRouter()
  const plate = params.plate as string
  const supabase = createClient()
  
  const [vehicle, setVehicle] = useState<any>(null)
  const [workOrders, setWorkOrders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchVehicleData()
  }, [plate])

  const fetchVehicleData = async () => {
    try {
      setLoading(true)
      // 1. Get Vehicle details
      const { data: vData, error: vError } = await supabase
        .from('vehicles')
        .select('*, carriers(business_name)')
        .eq('plate', plate)
        .single()
      
      if (vError) throw vError
      setVehicle(vData)

      // 2. Get Work Orders history
      const { data: otData, error: otError } = await supabase
        .from('maintenance_work_orders')
        .select('*')
        .eq('vehicle_plate', plate)
        .order('created_at', { ascending: false })
      
      if (otError) throw otError
      setWorkOrders(otData || [])

    } catch (err: any) {
      toast.error('Error al cargar datos del vehículo')
      router.push('/mantenimiento/flota')
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return <div className="p-8 text-center text-slate-500">Cargando ficha 360...</div>
  }

  if (!vehicle) {
    return <div className="p-8 text-center text-red-500">Vehículo no encontrado</div>
  }

  return (
    <div className="space-y-6 w-full mx-auto max-w-7xl p-6">
      
      {/* HEADER */}
      <div className="flex items-center gap-4 bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
        <Link href="/mantenimiento/flota" className="p-2 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors">
          <ArrowLeft className="w-5 h-5 text-slate-600" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-black text-[#002855] tracking-tight">{vehicle.plate}</h1>
            <span className={`px-3 py-1 text-xs font-bold rounded-full ${
              vehicle.status === 'DISPONIBLE' ? 'bg-emerald-100 text-emerald-700' :
              vehicle.status === 'EN_MANTENIMIENTO' ? 'bg-amber-100 text-amber-700' :
              'bg-slate-100 text-slate-700'
            }`}>
              {vehicle.status}
            </span>
          </div>
          <p className="text-sm text-slate-500 mt-1 font-medium">
            {vehicle.brand} {vehicle.model} • {vehicle.year} • {vehicle.type}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-slate-400 font-semibold uppercase">Transportista</p>
          <p className="font-bold text-slate-800">{vehicle.carriers?.business_name || 'Propio'}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* COLUMNA IZQUIERDA: Info Técnica y Documentos */}
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h2 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
              <Settings className="w-5 h-5 text-blue-500" /> Ficha Técnica
            </h2>
            <div className="space-y-3">
              <div className="flex justify-between py-2 border-b border-slate-100">
                <span className="text-sm text-slate-500">Cap. Carga (KG)</span>
                <span className="text-sm font-bold text-slate-800">{vehicle.weight_capacity} kg</span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-100">
                <span className="text-sm text-slate-500">Volumen (M³)</span>
                <span className="text-sm font-bold text-slate-800">{vehicle.volume_capacity} m³</span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-100">
                <span className="text-sm text-slate-500">Prom. KM Diario</span>
                <span className="text-sm font-bold text-slate-800">{vehicle.average_daily_km || 0} km/día</span>
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h2 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
              <FileText className="w-5 h-5 text-blue-500" /> Documentos y Alertas
            </h2>
            <div className="space-y-4">
              
              {/* SOAT */}
              <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-sm font-bold text-slate-700">SOAT</span>
                  {vehicle.soat_expiration ? (() => {
                    const diff = Math.ceil((new Date(vehicle.soat_expiration).getTime() - new Date().getTime()) / (1000 * 3600 * 24))
                    if (diff < 0) return <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded font-bold">Vencido</span>
                    if (diff <= 30) return <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded font-bold">En {diff} días</span>
                    return <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded font-bold">Vigente</span>
                  })() : <span className="text-xs bg-slate-200 text-slate-500 px-2 py-0.5 rounded font-bold">Sin reg.</span>}
                </div>
                <p className="text-xs text-slate-500">{vehicle.soat_expiration || 'No registrado'}</p>
              </div>

              {/* Revision Técnica */}
              <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-sm font-bold text-slate-700">Rev. Técnica</span>
                  {vehicle.technical_review_expiration ? (() => {
                    const diff = Math.ceil((new Date(vehicle.technical_review_expiration).getTime() - new Date().getTime()) / (1000 * 3600 * 24))
                    if (diff < 0) return <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded font-bold">Vencido</span>
                    if (diff <= 30) return <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded font-bold">En {diff} días</span>
                    return <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded font-bold">Vigente</span>
                  })() : <span className="text-xs bg-slate-200 text-slate-500 px-2 py-0.5 rounded font-bold">Sin reg.</span>}
                </div>
                <p className="text-xs text-slate-500">{vehicle.technical_review_expiration || 'No registrado'}</p>
              </div>

            </div>
          </div>
        </div>

        {/* COLUMNA DERECHA: Historial Mantenimiento */}
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm h-full">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                <Wrench className="w-5 h-5 text-blue-500" /> Historial de Mantenimientos (OTs)
              </h2>
              <Link href="/mantenimiento/gestor-ot" className="text-sm font-bold text-blue-600 hover:underline">
                Ver todas
              </Link>
            </div>

            {workOrders.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center bg-slate-50 rounded-lg border border-dashed border-slate-300">
                <Wrench className="w-12 h-12 text-slate-300 mb-3" />
                <p className="text-slate-500 font-medium">No hay mantenimientos registrados</p>
                <p className="text-xs text-slate-400 mt-1">Las órdenes de trabajo aparecerán aquí</p>
              </div>
            ) : (
              <div className="space-y-4">
                {workOrders.slice(0, 5).map(ot => (
                  <div key={ot.id} className="p-4 bg-white border border-slate-200 rounded-lg hover:border-blue-300 transition-colors cursor-pointer flex justify-between items-center group">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-xs font-bold text-slate-600 bg-slate-100 px-2 py-0.5 rounded">
                          {ot.type}
                        </span>
                        <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                          ot.status === 'COMPLETADA' ? 'bg-emerald-100 text-emerald-700' :
                          ot.status === 'EN_PROCESO' ? 'bg-blue-100 text-blue-700' :
                          ot.status === 'CANCELADA' ? 'bg-red-100 text-red-700' :
                          'bg-amber-100 text-amber-700'
                        }`}>
                          {ot.status}
                        </span>
                      </div>
                      <p className="text-sm font-bold text-slate-800">{ot.description}</p>
                      <p className="text-xs text-slate-500 mt-1">
                        Inició: {new Date(ot.start_date).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-slate-400 font-medium">Costo Total</p>
                      <p className="text-sm font-bold text-slate-800">S/ {ot.total_cost_pen?.toFixed(2) || '0.00'}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}