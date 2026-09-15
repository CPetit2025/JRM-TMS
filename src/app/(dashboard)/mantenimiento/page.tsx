"use client"
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Activity, Wrench, ShieldAlert, DollarSign, Truck, AlertTriangle, FileText, CalendarClock, TrendingDown } from 'lucide-react'
import Link from 'next/link'

export default function MantenimientoDashboardPage() {
  const supabase = createClient()
  const [stats, setStats] = useState({
    totalVehicles: 0,
    disponibles: 0,
    disponibilidadPct: 0,
    costoMtd: 0,
    fallasAbiertas: 0,
    otsEnProceso: 0,
    documentosAlerta: 0,
    mttrDias: 0
  })
  
  const [alertVehicles, setAlertVehicles] = useState<any[]>([])
  const [recentFailures, setRecentFailures] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchDashboardData()
  }, [])

  const fetchDashboardData = async () => {
    setLoading(true)
    try {
      // 1. Stats de Vehículos
      const { data: vData } = await supabase.from('vehicles').select('plate, status, soat_expiration, technical_review_expiration')
      
      let disp = 0
      let alertasDocs: any[] = []
      
      const today = new Date()
      
      if (vData) {
        vData.forEach(v => {
          if (v.status === 'DISPONIBLE') disp++
          
          // Alertas Documentarias (SOAT o Rev Técnica a menos de 15 días o vencido)
          let flagDoc = false
          let type = ''
          let days = 999
          
          if (v.soat_expiration) {
            const soatDiff = Math.ceil((new Date(v.soat_expiration).getTime() - today.getTime()) / (1000 * 3600 * 24))
            if (soatDiff <= 15) { flagDoc = true; type = 'SOAT'; days = soatDiff }
          }
          if (v.technical_review_expiration) {
            const revDiff = Math.ceil((new Date(v.technical_review_expiration).getTime() - today.getTime()) / (1000 * 3600 * 24))
            if (revDiff <= 15 && revDiff < days) { flagDoc = true; type = 'Revisión Técnica'; days = revDiff }
          }
          
          if (flagDoc) {
            alertasDocs.push({ plate: v.plate, type, days })
          }
        })
      }

      // 2. Costos de OT de este mes (MTD)
      const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1).toISOString()
      const { data: costData } = await supabase
        .from('work_order_costs')
        .select('amount, created_at')
        .gte('created_at', firstDayOfMonth)
        
      const costoMes = costData?.reduce((sum, row) => sum + Number(row.amount), 0) || 0

      // 3. MTTR (Tiempo Medio para Reparar) en OTs finalizadas
      const { data: otData } = await supabase
        .from('maintenance_work_orders')
        .select('id, start_date, actual_end_date, status')
        
      let totalDaysRepair = 0
      let totalFinished = 0
      let otProc = 0
      
      if (otData) {
        otData.forEach(ot => {
          if (ot.status === 'EN_PROCESO' || ot.status === 'PENDIENTE') {
            otProc++
          }
          if (ot.status === 'FINALIZADA' && ot.start_date && ot.actual_end_date) {
            const sDate = new Date(ot.start_date)
            const eDate = new Date(ot.actual_end_date)
            const diff = Math.ceil((eDate.getTime() - sDate.getTime()) / (1000 * 3600 * 24))
            totalDaysRepair += (diff === 0 ? 1 : diff) // Minimo 1 dia
            totalFinished++
          }
        })
      }
      
      const mttr = totalFinished > 0 ? (totalDaysRepair / totalFinished).toFixed(1) : 0

      // 4. Fallas
      const { data: fData } = await supabase.from('vehicle_failures').select('id').in('status', ['ABIERTO', 'EN_REVISION'])
      const { data: fRecent } = await supabase
        .from('vehicle_failures')
        .select('*')
        .in('status', ['ABIERTO', 'EN_REVISION'])
        .order('created_at', { ascending: false })
        .limit(5)

      setStats({
        totalVehicles: (vData || []).length,
        disponibles: disp,
        disponibilidadPct: (vData && vData.length > 0) ? Math.round((disp / vData.length) * 100) : 0,
        costoMtd: costoMes,
        fallasAbiertas: (fData || []).length,
        otsEnProceso: otProc,
        documentosAlerta: alertasDocs.length,
        mttrDias: Number(mttr)
      })
      
      setAlertVehicles(alertasDocs.sort((a,b) => a.days - b.days))
      setRecentFailures(fRecent || [])

    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-6 w-full max-w-7xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-black text-[#002855] tracking-tight">Dashboard Ejecutivo CMMS</h1>
          <p className="text-sm text-slate-500 font-medium mt-1">Visión integral de confiabilidad, costos y operación</p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64 text-slate-500">
          <Activity className="w-8 h-8 animate-spin text-blue-500" />
        </div>
      ) : (
        <div className="space-y-6">
          
          {/* TOP KPI ROW */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-24 h-24 bg-blue-50 rounded-bl-full -mr-4 -mt-4 transition-transform group-hover:scale-110"></div>
              <div className="relative z-10">
                <p className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">Disponibilidad</p>
                <div className="flex items-end gap-2">
                  <h3 className={`text-4xl font-black ${stats.disponibilidadPct >= 85 ? 'text-emerald-600' : stats.disponibilidadPct >= 70 ? 'text-amber-500' : 'text-red-600'}`}>
                    {stats.disponibilidadPct}%
                  </h3>
                </div>
                <p className="text-xs text-slate-500 mt-2 font-medium">{stats.disponibles} de {stats.totalVehicles} unidades operativas</p>
              </div>
            </div>

            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-50 rounded-bl-full -mr-4 -mt-4 transition-transform group-hover:scale-110"></div>
              <div className="relative z-10">
                <p className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">Costo (Mes Actual)</p>
                <div className="flex items-end gap-2">
                  <h3 className="text-4xl font-black text-slate-800">
                    S/ {stats.costoMtd.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                  </h3>
                </div>
                <p className="text-xs text-slate-500 mt-2 font-medium">Gasto acumulado MTD en OTs</p>
              </div>
            </div>

            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-24 h-24 bg-purple-50 rounded-bl-full -mr-4 -mt-4 transition-transform group-hover:scale-110"></div>
              <div className="relative z-10">
                <p className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">MTTR (Promedio)</p>
                <div className="flex items-end gap-2">
                  <h3 className="text-4xl font-black text-slate-800">
                    {stats.mttrDias} <span className="text-lg font-bold text-slate-400">días</span>
                  </h3>
                </div>
                <p className="text-xs text-slate-500 mt-2 font-medium">Tiempo Medio para Reparar</p>
              </div>
            </div>

            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-24 h-24 bg-red-50 rounded-bl-full -mr-4 -mt-4 transition-transform group-hover:scale-110"></div>
              <div className="relative z-10">
                <p className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">Fallas Abiertas</p>
                <div className="flex items-end gap-2">
                  <h3 className="text-4xl font-black text-red-600">
                    {stats.fallasAbiertas}
                  </h3>
                </div>
                <p className="text-xs text-slate-500 mt-2 font-medium">Reportes pendientes de atención</p>
              </div>
            </div>
          </div>

          {/* TWO COLUMNS */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            
            {/* ALERTAS DOCUMENTARIAS */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col">
              <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-amber-50/50 rounded-t-xl">
                <h3 className="font-bold text-slate-900 flex items-center gap-2">
                  <FileText className="w-5 h-5 text-amber-500" />
                  Alertas Documentarias ({stats.documentosAlerta})
                </h3>
                <Link href="/mantenimiento/flota" className="text-xs font-bold text-blue-600 hover:underline">Ir a Flota</Link>
              </div>
              <div className="p-0 flex-1 overflow-y-auto max-h-[300px]">
                {alertVehicles.length === 0 ? (
                  <div className="flex flex-col items-center justify-center p-8 text-slate-400">
                    <ShieldAlert className="w-10 h-10 mb-2 opacity-20" />
                    <p className="text-sm font-medium">Todos los documentos están vigentes.</p>
                  </div>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {alertVehicles.map((v, i) => (
                      <li key={i} className="p-4 hover:bg-slate-50 flex items-center justify-between">
                        <div>
                          <p className="font-black text-[#002855] text-lg leading-tight">{v.plate}</p>
                          <p className="text-xs font-bold text-slate-500 uppercase mt-1">{v.type}</p>
                        </div>
                        <div className="text-right">
                          <span className={`px-3 py-1 rounded-full text-xs font-bold ${v.days < 0 ? 'bg-red-100 text-red-700' : v.days === 0 ? 'bg-orange-100 text-orange-700' : 'bg-amber-100 text-amber-700'}`}>
                            {v.days < 0 ? `Vencido hace ${Math.abs(v.days)} días` : v.days === 0 ? 'Vence HOY' : `Vence en ${v.days} días`}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* FALLAS RECIENTES */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col">
              <div className="p-4 border-b border-slate-200 flex justify-between items-center rounded-t-xl">
                <h3 className="font-bold text-slate-900 flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5 text-red-500" />
                  Últimos Reportes de Falla
                </h3>
                <Link href="/mantenimiento/fallas" className="text-xs font-bold text-blue-600 hover:underline">Ver Gestor</Link>
              </div>
              <div className="p-0 flex-1 overflow-y-auto max-h-[300px]">
                {recentFailures.length === 0 ? (
                  <div className="flex flex-col items-center justify-center p-8 text-slate-400">
                    <Activity className="w-10 h-10 mb-2 opacity-20" />
                    <p className="text-sm font-medium">No hay reportes de falla activos.</p>
                  </div>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {recentFailures.map(f => (
                      <li key={f.id} className="p-4 hover:bg-slate-50">
                        <div className="flex justify-between mb-1">
                          <Link href={`/mantenimiento/flota/${f.vehicle_plate}`} className="font-black text-[#002855] hover:text-blue-600 transition-colors">
                            {f.vehicle_plate}
                          </Link>
                          <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${f.criticality === 'CRITICA' ? 'bg-red-600 text-white animate-pulse' : 'bg-orange-100 text-orange-700'}`}>
                            {f.criticality}
                          </span>
                        </div>
                        <p className="text-sm font-medium text-slate-700 mt-1 line-clamp-2">{f.description}</p>
                        <p className="text-xs text-slate-400 mt-2 flex items-center gap-1">
                          <CalendarClock className="w-3 h-3" />
                          {new Date(f.report_date).toLocaleString()}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            
          </div>
        </div>
      )}
    </div>
  )
}
