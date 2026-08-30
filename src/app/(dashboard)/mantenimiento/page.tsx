"use client"
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Activity, Wrench, ShieldAlert, DollarSign, Truck, AlertTriangle, Map as MapIcon } from 'lucide-react'
import Link from 'next/link'

export default function MantenimientoDashboardPage() {
  const supabase = createClient()
  const [stats, setStats] = useState({
    totalVehicles: 0,
    disponibles: 0,
    mantenimiento: 0,
    fueraServicio: 0,
    fallasAbiertas: 0,
    otsEnProceso: 0,
    costoTotal: 0
  })
  const [recentFailures, setRecentFailures] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchDashboardData()
  }, [])

  const fetchDashboardData = async () => {
    setLoading(true)
    try {
      // 1. Stats de Vehículos
      const { data: vData } = await supabase.from('vehicles').select('status, accumulated_cost')
      
      let disp = 0, mant = 0, fuera = 0, costo = 0
      if (vData) {
        vData.forEach(v => {
          if (v.status === 'DISPONIBLE') disp++
          else if (v.status === 'MANTENIMIENTO') mant++
          else if (v.status === 'FUERA_DE_SERVICIO' || v.status === 'BLOQUEADA') fuera++
          
          costo += Number(v.accumulated_cost || 0)
        })
      }

      // 2. Fallas
      const { data: fData } = await supabase.from('vehicle_failures').select('id').in('status', ['ABIERTO', 'EN_REVISION'])
      const { data: fRecent } = await supabase
        .from('vehicle_failures')
        .select('*, vehicles(plate)')
        .in('status', ['ABIERTO', 'EN_REVISION'])
        .order('created_at', { ascending: false })
        .limit(5)

      // 3. OTs
      const { data: otData } = await supabase.from('maintenance_work_orders').select('id').in('status', ['PENDIENTE', 'EN_PROCESO'])

      setStats({
        totalVehicles: (vData || []).length,
        disponibles: disp,
        mantenimiento: mant,
        fueraServicio: fuera,
        fallasAbiertas: (fData || []).length,
        otsEnProceso: (otData || []).length,
        costoTotal: costo
      })
      setRecentFailures(fRecent || [])

    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Dashboard de Mantenimiento</h1>
          <p className="text-sm text-slate-500">Indicadores clave de la flota y estado operativo</p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64 text-slate-500">
          <Activity className="w-8 h-8 animate-spin text-blue-500" />
        </div>
      ) : (
        <div className="space-y-6">
          {/* KPI Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex items-start justify-between">
              <div>
                <p className="text-sm font-medium text-slate-500 mb-1">Disponibilidad de Flota</p>
                <div className="flex items-end gap-2">
                  <h3 className="text-3xl font-bold text-slate-900">{stats.disponibles}</h3>
                  <span className="text-sm text-slate-500 mb-1">/ {stats.totalVehicles} unid.</span>
                </div>
              </div>
              <div className="p-3 bg-blue-50 text-blue-600 rounded-lg">
                <Truck className="w-6 h-6" />
              </div>
            </div>

            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex items-start justify-between">
              <div>
                <p className="text-sm font-medium text-slate-500 mb-1">Unidades en Taller</p>
                <div className="flex items-end gap-2">
                  <h3 className="text-3xl font-bold text-orange-600">{stats.mantenimiento}</h3>
                  <span className="text-sm text-slate-500 mb-1">mantenimiento</span>
                </div>
              </div>
              <div className="p-3 bg-orange-50 text-orange-600 rounded-lg">
                <Wrench className="w-6 h-6" />
              </div>
            </div>

            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex items-start justify-between">
              <div>
                <p className="text-sm font-medium text-slate-500 mb-1">Fallas Abiertas</p>
                <div className="flex items-end gap-2">
                  <h3 className="text-3xl font-bold text-red-600">{stats.fallasAbiertas}</h3>
                  <span className="text-sm text-slate-500 mb-1">reportes</span>
                </div>
              </div>
              <div className="p-3 bg-red-50 text-red-600 rounded-lg">
                <ShieldAlert className="w-6 h-6" />
              </div>
            </div>

            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex items-start justify-between">
              <div>
                <p className="text-sm font-medium text-slate-500 mb-1">Costo Acumulado</p>
                <div className="flex items-end gap-2">
                  <h3 className="text-3xl font-bold text-slate-900">S/ {stats.costoTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</h3>
                </div>
              </div>
              <div className="p-3 bg-emerald-50 text-emerald-600 rounded-lg">
                <DollarSign className="w-6 h-6" />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Recent Failures */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col">
              <div className="p-4 border-b border-slate-200 flex justify-between items-center">
                <h3 className="font-semibold text-slate-900 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-red-500" />
                  Atención Inmediata (Fallas)
                </h3>
                <Link href="/mantenimiento/fallas" className="text-sm text-blue-600 hover:underline">Ver todas</Link>
              </div>
              <div className="p-0 flex-1 overflow-y-auto">
                {recentFailures.length === 0 ? (
                  <div className="p-8 text-center text-slate-500 text-sm">No hay fallas pendientes.</div>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {recentFailures.map(f => (
                      <li key={f.id} className="p-4 hover:bg-slate-50">
                        <div className="flex justify-between mb-1">
                          <span className="font-semibold text-slate-900">{f.vehicles?.plate}</span>
                          <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${f.criticality === 'CRITICA' ? 'bg-red-600 text-white animate-pulse' : 'bg-orange-100 text-orange-700'}`}>
                            {f.criticality}
                          </span>
                        </div>
                        <p className="text-sm text-slate-600 truncate">{f.description}</p>
                        <p className="text-xs text-slate-400 mt-2">{new Date(f.report_date).toLocaleString()}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* Quick Actions / Info */}
            <div className="bg-gradient-to-br from-[#070b14] to-[#0a1122] rounded-xl shadow-lg border border-slate-800 p-6 flex flex-col justify-center text-white relative overflow-hidden">
              <div className="absolute top-0 right-0 p-8 opacity-10">
                <Wrench className="w-32 h-32" />
              </div>
              <h3 className="text-xl font-bold mb-2">Centro de Control</h3>
              <p className="text-slate-400 mb-6 max-w-sm text-sm">Gestiona el mantenimiento preventivo y correctivo de las unidades para evitar paradas operativas.</p>
              
              <div className="grid grid-cols-2 gap-3 z-10">
                <Link href="/mantenimiento/ot" className="bg-white/10 hover:bg-white/20 border border-white/10 rounded-lg p-3 transition-colors">
                  <Wrench className="w-5 h-5 mb-2 text-blue-400" />
                  <span className="font-semibold text-sm">Gestionar OTs ({stats.otsEnProceso})</span>
                </Link>
                <Link href="/mantenimiento/flota" className="bg-white/10 hover:bg-white/20 border border-white/10 rounded-lg p-3 transition-colors">
                  <MapIcon className="w-5 h-5 mb-2 text-blue-400" />
                  <span className="font-semibold text-sm">Ver Flota Completa</span>
                </Link>
                <Link href="/mantenimiento/planes" className="bg-white/10 hover:bg-white/20 border border-white/10 rounded-lg p-3 transition-colors col-span-2">
                  <Activity className="w-5 h-5 mb-2 text-blue-400" />
                  <span className="font-semibold text-sm">Configurar Planes Preventivos</span>
                </Link>
              </div>
            </div>

          </div>
        </div>
      )}
    </div>
  )
}
