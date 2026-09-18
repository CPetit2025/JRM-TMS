"use client"
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { BarChart3, PieChart, TrendingUp, DollarSign, Activity } from 'lucide-react'
import Link from 'next/link'

export default function AnaliticaCostosPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [costsByCategory, setCostsByCategory] = useState<any[]>([])
  const [costsByVehicle, setCostsByVehicle] = useState<any[]>([])
  const [totalCost, setTotalCost] = useState(0)

  useEffect(() => {
    fetchAnalytics()
  }, [])

  const fetchAnalytics = async () => {
    setLoading(true)
    try {
      // Obtenemos todos los costos asociados a las OTs finalizadas o en proceso
      const { data: costsData, error } = await supabase
        .from('work_order_costs')
        .select(`
          amount,
          cost_type,
          maintenance_work_orders(vehicle_plate, status)
        `)

      if (error) throw error

      let total = 0
      const byCat: Record<string, number> = {
        'REPUESTOS': 0,
        'MANO_DE_OBRA': 0,
        'SERVICIO_EXTERNO': 0,
        'OTROS': 0
      }
      const byVeh: Record<string, number> = {}

      if (costsData) {
        costsData.forEach(c => {
          const amt = Number(c.amount)
          total += amt
          
          if (byCat[c.cost_type] !== undefined) {
            byCat[c.cost_type] += amt
          } else {
            byCat['OTROS'] += amt
          }

          // @ts-ignore
          const plate = c.maintenance_work_orders?.vehicle_plate || 'Sin Placa'
          if (!byVeh[plate]) byVeh[plate] = 0
          byVeh[plate] += amt
        })
      }

      setTotalCost(total)

      // Transformar para el render
      setCostsByCategory(Object.entries(byCat).map(([name, value]) => ({ name, value })))
      
      const sortedVehicles = Object.entries(byVeh)
        .map(([plate, value]) => ({ plate, value }))
        .sort((a, b) => b.value - a.value)
        
      setCostsByVehicle(sortedVehicles)

    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return <div className="p-12 flex justify-center"><Activity className="w-8 h-8 animate-spin text-blue-500" /></div>
  }

  return (
    <div className="space-y-6 w-full mx-auto">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-black text-[#002855] tracking-tight">Analítica y Costos</h1>
          <p className="text-sm text-slate-500 font-medium mt-1">Análisis financiero del mantenimiento de flota (Histórico Total)</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* KPI: Gasto Total */}
        <div className="bg-gradient-to-br from-[#002855] to-[#001533] p-6 rounded-xl border border-slate-800 shadow-lg text-white">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-3 bg-white/10 rounded-lg">
              <DollarSign className="w-6 h-6 text-emerald-400" />
            </div>
            <h2 className="text-lg font-bold text-slate-200">Gasto Total Acumulado</h2>
          </div>
          <p className="text-4xl font-black mb-2">
            S/ {totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
          <p className="text-sm text-slate-400">En todas las órdenes de trabajo registradas</p>
        </div>

        {/* Distribucion por Categoria */}
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm md:col-span-2">
          <h3 className="font-bold text-slate-800 mb-4 flex items-center gap-2">
            <PieChart className="w-5 h-5 text-blue-500" /> Distribución por Tipo de Costo
          </h3>
          <div className="space-y-4">
            {costsByCategory.map((cat, idx) => (
              <div key={idx}>
                <div className="flex justify-between text-sm mb-1 font-medium">
                  <span className="text-slate-600">{cat.name.replace(/_/g, ' ')}</span>
                  <span className="text-slate-900 font-bold">
                    S/ {cat.value.toLocaleString(undefined, { minimumFractionDigits: 2 })} 
                    <span className="text-slate-400 font-normal ml-2">
                      ({totalCost > 0 ? Math.round((cat.value / totalCost) * 100) : 0}%)
                    </span>
                  </span>
                </div>
                <div className="w-full bg-slate-100 rounded-full h-2">
                  <div 
                    className={`h-2 rounded-full ${cat.name === 'REPUESTOS' ? 'bg-blue-500' : cat.name === 'MANO_DE_OBRA' ? 'bg-emerald-500' : cat.name === 'SERVICIO_EXTERNO' ? 'bg-purple-500' : 'bg-amber-500'}`} 
                    style={{ width: `${totalCost > 0 ? (cat.value / totalCost) * 100 : 0}%` }}
                  ></div>
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>

      {/* TOP Vehiculos por Costo */}
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
        <div className="flex justify-between items-center mb-6">
          <h3 className="font-bold text-slate-800 flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-red-500" /> Unidades con Mayor Gasto
          </h3>
        </div>
        
        {costsByVehicle.length === 0 ? (
          <p className="text-center text-slate-500 py-8">No hay datos de costos registrados.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {costsByVehicle.map((v, i) => (
              <div key={i} className="flex items-center justify-between p-4 border border-slate-100 rounded-lg bg-slate-50 hover:bg-white hover:border-blue-200 transition-colors">
                <div className="flex items-center gap-4">
                  <div className="w-8 h-8 rounded-full bg-slate-200 text-slate-600 font-bold flex items-center justify-center text-xs">
                    #{i + 1}
                  </div>
                  <div>
                    <Link href={`/mantenimiento/flota/${v.plate}`} className="font-black text-lg text-[#002855] hover:text-blue-600 hover:underline">
                      {v.plate}
                    </Link>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-bold text-slate-900 text-lg">
                    S/ {v.value.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </p>
                  <p className="text-xs font-semibold text-slate-500">
                    {totalCost > 0 ? Math.round((v.value / totalCost) * 100) : 0}% del total
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  )
}