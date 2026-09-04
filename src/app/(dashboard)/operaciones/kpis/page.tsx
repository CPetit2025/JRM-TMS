"use client"

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Loader2, TrendingUp, Clock, Target, CalendarDays, Activity } from 'lucide-react'
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell
} from 'recharts'

export default function DashboardKPIsPage() {
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState<any>(null)
  const supabase = createClient()

  useEffect(() => {
    const fetchKPIs = async () => {
      try {
        setLoading(true)
        
        // Obtenemos las actividades finalizadas del mes actual para el análisis
        const hoy = new Date()
        const primerDiaMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString()
        
        const { data: actividades, error } = await supabase
          .from('operaciones_actividades')
          .select('tipo_actividad, start_time, end_time, status')
          .eq('status', 'FINALIZADO')
          .gte('start_time', primerDiaMes)

        if (error) throw error

        // Procesamiento de datos para KPIs
        let totalMins = 0
        const minPorActividad: Record<string, number> = {
          'OT': 0,
          'DESPACHO': 0,
          'RECOJO': 0,
          'RECEPCION': 0,
          'ALMACENAJE': 0,
          'PICKING': 0,
          'PACKING': 0,
          'TRANSPORTE': 0,
          'BREAK': 0
        }

        actividades?.forEach(act => {
          if (act.start_time && act.end_time) {
            const m = Math.floor((new Date(act.end_time).getTime() - new Date(act.start_time).getTime()) / 60000)
            if (m > 0) {
              totalMins += m
              if (minPorActividad[act.tipo_actividad] !== undefined) {
                minPorActividad[act.tipo_actividad] += m
              }
            }
          }
        })

        const horasTotal = (totalMins / 60).toFixed(1)
        const productivas = ((minPorActividad['OT'] + minPorActividad['DESPACHO'] + minPorActividad['RECOJO'] + minPorActividad['RECEPCION'] + minPorActividad['ALMACENAJE'] + minPorActividad['PICKING'] + minPorActividad['PACKING'] + minPorActividad['TRANSPORTE']) / 60).toFixed(1)
        const muertas = (minPorActividad['BREAK'] / 60).toFixed(1)

        // Formato para Recharts
        const chartData = [
          { name: 'OT', horas: Number((minPorActividad['OT'] / 60).toFixed(1)) },
          { name: 'Despacho', horas: Number((minPorActividad['DESPACHO'] / 60).toFixed(1)) },
          { name: 'Recojo', horas: Number((minPorActividad['RECOJO'] / 60).toFixed(1)) },
          { name: 'Recepción', horas: Number((minPorActividad['RECEPCION'] / 60).toFixed(1)) },
          { name: 'Almacenaje', horas: Number((minPorActividad['ALMACENAJE'] / 60).toFixed(1)) },
          { name: 'Picking', horas: Number((minPorActividad['PICKING'] / 60).toFixed(1)) },
          { name: 'Packing', horas: Number((minPorActividad['PACKING'] / 60).toFixed(1)) },
          { name: 'Transporte', horas: Number((minPorActividad['TRANSPORTE'] / 60).toFixed(1)) },
          { name: 'Break', horas: Number((minPorActividad['BREAK'] / 60).toFixed(1)) },
        ]

        const pieData = [
          { name: 'Horas Productivas', value: Number(productivas) },
          { name: 'Horas Muertas (Break)', value: Number(muertas) }
        ]

        setStats({
          horasTotal,
          productivas,
          muertas,
          chartData,
          pieData,
          totalActividades: actividades?.length || 0
        })

      } catch (err) {
        console.error(err)
      } finally {
        setLoading(false)
      }
    }

    fetchKPIs()
  }, [])

  const COLORS = ['#10b981', '#f43f5e']

  if (loading) {
    return (
      <div className="flex justify-center items-center h-full pt-40">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    )
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-black text-slate-800 tracking-tight">Productividad (KPIs)</h1>
        <p className="text-slate-500 mt-1 flex items-center gap-2">
          <CalendarDays className="w-4 h-4" /> Acumulado del mes actual
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200">
          <div className="flex items-center gap-3 text-slate-500 mb-2 font-bold text-sm uppercase">
            <Clock className="w-5 h-5 text-blue-500" /> Total HH
          </div>
          <p className="text-4xl font-black text-slate-800">{stats?.horasTotal} <span className="text-lg text-slate-400 font-medium">hrs</span></p>
        </div>

        <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200">
          <div className="flex items-center gap-3 text-slate-500 mb-2 font-bold text-sm uppercase">
            <TrendingUp className="w-5 h-5 text-emerald-500" /> HH Productivas
          </div>
          <p className="text-4xl font-black text-emerald-600">{stats?.productivas} <span className="text-lg text-emerald-400/50 font-medium">hrs</span></p>
        </div>

        <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200">
          <div className="flex items-center gap-3 text-slate-500 mb-2 font-bold text-sm uppercase">
            <Activity className="w-5 h-5 text-red-400" /> HH Muertas
          </div>
          <p className="text-4xl font-black text-red-500">{stats?.muertas} <span className="text-lg text-red-300 font-medium">hrs</span></p>
        </div>

        <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200">
          <div className="flex items-center gap-3 text-slate-500 mb-2 font-bold text-sm uppercase">
            <Target className="w-5 h-5 text-indigo-500" /> Tareas Creadas
          </div>
          <p className="text-4xl font-black text-slate-800">{stats?.totalActividades} <span className="text-lg text-slate-400 font-medium">und</span></p>
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Gráfico de Barras */}
        <div className="lg:col-span-2 bg-white rounded-2xl p-6 shadow-sm border border-slate-200">
          <h3 className="text-lg font-bold text-slate-700 mb-6">Desglose de Horas por Actividad</h3>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats?.chartData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill: '#64748b', fontSize: 12, fontWeight: 600}} dy={10} />
                <YAxis axisLine={false} tickLine={false} tick={{fill: '#64748b', fontSize: 12}} />
                <Tooltip 
                  cursor={{fill: '#f1f5f9'}}
                  contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                />
                <Bar dataKey="horas" fill="#3b82f6" radius={[6, 6, 0, 0]} barSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Gráfico de Donut */}
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200 flex flex-col">
          <h3 className="text-lg font-bold text-slate-700 mb-2">Productividad</h3>
          <p className="text-xs text-slate-500 mb-6">Relación entre horas de operación directa y horas de pausa (break).</p>
          <div className="flex-1 min-h-[250px] w-full relative flex items-center justify-center">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={stats?.pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                  stroke="none"
                >
                  {stats?.pieData.map((entry: any, index: number) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip 
                  contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                />
                <Legend verticalAlign="bottom" height={36} iconType="circle" wrapperStyle={{ fontSize: '12px', fontWeight: 600, color: '#64748b' }}/>
              </PieChart>
            </ResponsiveContainer>
            
            {/* Porcentaje en el centro */}
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-2xl font-black text-slate-800">
                {stats?.horasTotal > 0 ? Math.round((Number(stats?.productivas) / Number(stats?.horasTotal)) * 100) : 0}%
              </span>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Efectividad</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
