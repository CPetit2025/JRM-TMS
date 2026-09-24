"use client"
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { 
  DollarSign, ArrowUpRight, ArrowDownRight, Activity, 
  Wallet, FileText, CheckCircle2, AlertTriangle, Clock, RefreshCw
} from 'lucide-react'
import Link from 'next/link'
import { toast } from 'sonner'

export default function CajaDashboardPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [metrics, setMetrics] = useState({
    totalEntregado: 0,
    totalLiquidado: 0,
    pendienteLiquidacion: 0,
    fondosActivos: 0,
    gastosSinComprobante: 0,
    gastosObservados: 0
  })
  
  const [analyticsCat, setAnalyticsCat] = useState<any[]>([])
  const [analyticsVeh, setAnalyticsVeh] = useState<any[]>([])

  useEffect(() => {
    fetchMetrics()
  }, [])

  const fetchMetrics = async () => {
    setLoading(true)
    try {
      // Demo metrics for MVP (In a real scenario, this would come from an RPC or aggregations)
      const { data: dispatches, error: dispatchesError } = await supabase.from('dispatches').select('liquidation_data, status').not('liquidation_data', 'is', null)
      const { data: expenses, error: expensesError } = await supabase.from('dispatch_expenses').select('amount, status, description')
      
      let totalE = 0
      let totalL = 0
      let activos = 0
      if (dispatches) {
        dispatches.forEach(d => {
          const totalExpenses = d.liquidation_data?.total_expenses || 0
          totalE += Number(totalExpenses)
          if (d.status === 'LIQUIDADO' || d.status === 'CERRADO') {
            totalL += Number(totalExpenses) // Simplified
          } else if (d.status !== 'ANULADO') {
            activos++
          }
        })
      }

      let sinComprobante = 0
      let observados = 0
      if (expenses) {
        expenses.forEach(e => {
          if (!e.description?.includes('Comprobante: FACTURA') && !e.description?.includes('Comprobante: BOLETA')) sinComprobante++
          if (e.status === 'OBSERVADO') observados++
        })
      }

      setMetrics({
        totalEntregado: totalE,
        totalLiquidado: totalL,
        pendienteLiquidacion: totalE - totalL,
        fondosActivos: activos,
        gastosSinComprobante: sinComprobante,
        gastosObservados: observados
      })

      // Fetch analytics
      const { data: catData } = await supabase.from('view_expense_analytics_category').select('*').order('total_sum', { ascending: false })
      const { data: vehData } = await supabase.from('view_expense_analytics_vehicle').select('*').order('total_sum', { ascending: false })
      
      setAnalyticsCat(catData || [])
      setAnalyticsVeh(vehData || [])

    } catch (error) {
      console.error('Error fetching metrics', error)
      toast.error('Error al cargar métricas financieras')
    } finally {
      setLoading(false)
    }
  }

  const formatMoney = (amount: number) => {
    return new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' }).format(amount)
  }

  return (
    <div className="space-y-6 w-full mx-auto">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-black text-[#002855] tracking-tight">Dashboard Financiero</h1>
          <p className="text-sm text-slate-500 font-medium mt-1">Control de caja chica, anticipos y liquidaciones operativas</p>
        </div>
        <div className="flex gap-3">
          <Link href="/caja/gastos" className="bg-white border border-slate-200 text-slate-700 px-4 py-2 rounded-lg font-medium hover:bg-slate-50 transition-colors flex items-center gap-2">
            <FileText className="w-4 h-4" /> Registrar Gasto
          </Link>
          <Link href="/caja/fondos" className="bg-[#002855] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#003566] transition-colors flex items-center gap-2">
            <Wallet className="w-4 h-4" /> Entregar Fondos
          </Link>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Activity className="w-8 h-8 animate-spin text-blue-500" />
        </div>
      ) : (
        <>
          {/* Top Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <ArrowUpRight className="w-16 h-16 text-blue-600" />
              </div>
              <div className="flex justify-between items-start mb-4 relative z-10">
                <div className="p-2 bg-blue-50 rounded-lg"><DollarSign className="w-5 h-5 text-blue-600" /></div>
                <span className="text-xs font-bold text-slate-400 bg-slate-100 px-2 py-1 rounded-full">YTD</span>
              </div>
              <div className="relative z-10">
                <h3 className="text-2xl font-black text-slate-800">{formatMoney(metrics.totalEntregado)}</h3>
                <p className="text-sm font-medium text-slate-500 mt-1">Total Fondos Entregados</p>
              </div>
            </div>

            <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <CheckCircle2 className="w-16 h-16 text-emerald-600" />
              </div>
              <div className="flex justify-between items-start mb-4 relative z-10">
                <div className="p-2 bg-emerald-50 rounded-lg"><CheckCircle2 className="w-5 h-5 text-emerald-600" /></div>
                <span className="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded-full">OK</span>
              </div>
              <div className="relative z-10">
                <h3 className="text-2xl font-black text-slate-800">{formatMoney(metrics.totalLiquidado)}</h3>
                <p className="text-sm font-medium text-slate-500 mt-1">Total Rendido / Liquidado</p>
              </div>
            </div>

            <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <Clock className="w-16 h-16 text-amber-600" />
              </div>
              <div className="flex justify-between items-start mb-4 relative z-10">
                <div className="p-2 bg-amber-50 rounded-lg"><RefreshCw className="w-5 h-5 text-amber-600" /></div>
                <span className="text-xs font-bold text-amber-600 bg-amber-50 px-2 py-1 rounded-full">{metrics.fondosActivos} Activos</span>
              </div>
              <div className="relative z-10">
                <h3 className="text-2xl font-black text-slate-800">{formatMoney(metrics.pendienteLiquidacion)}</h3>
                <p className="text-sm font-medium text-slate-500 mt-1">Pendiente de Liquidación</p>
              </div>
            </div>

            <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <AlertTriangle className="w-16 h-16 text-red-600" />
              </div>
              <div className="flex justify-between items-start mb-4 relative z-10">
                <div className="p-2 bg-red-50 rounded-lg"><AlertTriangle className="w-5 h-5 text-red-600" /></div>
                <span className="text-xs font-bold text-red-600 bg-red-50 px-2 py-1 rounded-full">Atención</span>
              </div>
              <div className="relative z-10">
                <div className="flex gap-4">
                  <div>
                    <h3 className="text-xl font-black text-slate-800">{metrics.gastosObservados}</h3>
                    <p className="text-xs font-medium text-slate-500 mt-1">Observados</p>
                  </div>
                  <div className="w-px h-10 bg-slate-200"></div>
                  <div>
                    <h3 className="text-xl font-black text-slate-800">{metrics.gastosSinComprobante}</h3>
                    <p className="text-xs font-medium text-slate-500 mt-1">Sin Comprobante</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
            {/* Gastos por Categoría */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
              <h3 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
                <FileText className="w-5 h-5 text-blue-500" />
                Gastos por Categoría
              </h3>
              
              {analyticsCat.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-sm">No hay datos suficientes</div>
              ) : (
                <div className="space-y-4">
                  {analyticsCat.map((cat, idx) => {
                    const max = Math.max(...analyticsCat.map(c => Number(c.total_sum)))
                    const percentage = Math.round((Number(cat.total_sum) / max) * 100)
                    return (
                      <div key={idx}>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="font-bold text-slate-700">{cat.category}</span>
                          <span className="font-bold text-slate-900">{formatMoney(cat.total_sum)}</span>
                        </div>
                        <div className="w-full bg-slate-100 rounded-full h-2.5">
                          <div className="bg-blue-600 h-2.5 rounded-full" style={{ width: `${percentage}%` }}></div>
                        </div>
                        <p className="text-[10px] text-slate-400 mt-0.5 text-right">{cat.expense_count} comprobante(s)</p>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Gastos por Unidad */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
              <h3 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
                <Activity className="w-5 h-5 text-emerald-500" />
                Top Costos por Vehículo
              </h3>
              
              {analyticsVeh.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-sm">No hay datos suficientes o gastos vinculados a placas</div>
              ) : (
                <div className="space-y-4">
                  {analyticsVeh.slice(0, 5).map((veh, idx) => {
                    const max = Math.max(...analyticsVeh.map(v => Number(v.total_sum)))
                    const percentage = Math.round((Number(veh.total_sum) / max) * 100)
                    return (
                      <div key={idx}>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="font-bold text-slate-700">Placa: {veh.vehicle_plate}</span>
                          <span className="font-bold text-slate-900">{formatMoney(veh.total_sum)}</span>
                        </div>
                        <div className="w-full bg-slate-100 rounded-full h-2.5">
                          <div className="bg-emerald-500 h-2.5 rounded-full" style={{ width: `${percentage}%` }}></div>
                        </div>
                        <p className="text-[10px] text-slate-400 mt-0.5 text-right">{veh.expense_count} comprobante(s)</p>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
