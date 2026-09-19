"use client"

import { useState, useEffect, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, 
  PieChart, Pie, Cell, Legend
} from 'recharts'
import { 
  Truck, Calendar, AlertTriangle, CheckCircle2, Route, 
  Activity, TrendingUp, Filter, Loader2, ChevronRight
} from 'lucide-react'

const COLORS = ['#002855', '#10b981', '#f59e0b', '#ef4444', '#6366f1', '#8b5cf6'];
const STATUS_COLORS: Record<string, string> = {
  'PROGRAMADO': '#94a3b8',
  'EN RUTA': '#3b82f6',
  'EN_CURSO': '#3b82f6',
  'ESPERANDO_AUTORIZACION': '#f59e0b',
  'RETORNO': '#6366f1',
  'LIQUIDADO': '#10b981',
  'ENTREGADO': '#10b981'
}

export default function DashboardEjecutivo() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [dateRange, setDateRange] = useState('7days') // 7days, 30days, all
  
  const [dispatches, setDispatches] = useState<any[]>([])

  useEffect(() => {
    fetchData()
  }, [dateRange])

  const fetchData = async () => {
    try {
      setLoading(true)
      
      let query = supabase
        .from('dispatches')
        .select(`
          id, dispatch_number, driver_name, vehicle_plate, status, scheduled_departure, created_at,
          dispatch_requests (
            transport_request_id,
            status,
            transport_requests (
              requester_name
            )
          ),
          dispatch_events (
            event_type,
            created_at
          )
        `)
        .order('scheduled_departure', { ascending: false })

      // Apply date filter
      if (dateRange !== 'all') {
        const days = dateRange === '7days' ? 7 : 30
        const dateLimit = new Date()
        dateLimit.setDate(dateLimit.getDate() - days)
        query = query.gte('scheduled_departure', dateLimit.toISOString())
      }

      const { data, error } = await query
      if (error) throw error
      setDispatches(data || [])
    } catch (err) {
      console.error("Error fetching dashboard data:", err)
    } finally {
      setLoading(false)
    }
  }

  const { kpis, statusData, timelineData, clientData, recentDispatches } = useMemo(() => {
    let kpiProgramados = 0
    let kpiEnCurso = 0
    let kpiCompletados = 0
    let kpiAlertas = 0
    let totalOts = 0

    const statusCounts: Record<string, number> = {}
    const timelineCounts: Record<string, number> = {}
    const clientCounts: Record<string, number> = {}

    dispatches.forEach(d => {
      // KPIs
      if (d.status === 'PROGRAMADO') kpiProgramados++
      if (d.status === 'EN_CURSO' || d.status === 'EN RUTA' || d.status === 'RETORNO') kpiEnCurso++
      if (d.status === 'ENTREGADO' || d.status === 'LIQUIDADO') kpiCompletados++

      // Alertas
      const hasAlert = d.dispatch_events?.some((e: any) => e.event_type === 'INCIDENCIA' || e.event_type === 'RETRASO' || e.event_type === 'DESVIO')
      if (hasAlert && d.status !== 'LIQUIDADO' && d.status !== 'ENTREGADO') {
        kpiAlertas++
      }

      // Status Chart
      const statusLabel = d.status.replace('_', ' ')
      statusCounts[statusLabel] = (statusCounts[statusLabel] || 0) + 1

      // Timeline Chart (Group by day)
      const day = new Date(d.scheduled_departure).toLocaleDateString('es-PE', { day: '2-digit', month: 'short' })
      timelineCounts[day] = (timelineCounts[day] || 0) + 1

      // Client Chart (OTs volume)
      if (d.dispatch_requests) {
        totalOts += d.dispatch_requests.length
        d.dispatch_requests.forEach((req: any) => {
          const clientName = req.transport_requests?.requester_name || 'Sin Asignar'
          clientCounts[clientName] = (clientCounts[clientName] || 0) + 1
        })
      }
    })

    const statusChartData = Object.keys(statusCounts).map(key => ({
      name: key,
      value: statusCounts[key],
      color: STATUS_COLORS[key.replace(' ', '_')] || '#94a3b8'
    }))

    const timelineChartData = Object.keys(timelineCounts).reverse().map(key => ({
      date: key,
      viajes: timelineCounts[key]
    }))

    const clientChartData = Object.keys(clientCounts)
      .map(key => ({ name: key, ots: clientCounts[key] }))
      .sort((a, b) => b.ots - a.ots)
      .slice(0, 5) // Top 5

    return {
      kpis: { total: dispatches.length, kpiEnCurso, kpiCompletados, kpiAlertas, totalOts },
      statusData: statusChartData,
      timelineData: timelineChartData,
      clientData: clientChartData,
      recentDispatches: dispatches.slice(0, 5)
    }
  }, [dispatches])

  const getStatusBadge = (status: string) => {
    return (
      <span className="px-2 py-1 bg-slate-100 text-slate-700 rounded-md text-[10px] font-bold uppercase tracking-wide border border-slate-200">
        {status.replace('_', ' ')}
      </span>
    )
  }

  return (
    <div className="space-y-6 pb-10">
      {/* Dashboard Header & Filters */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Resumen Ejecutivo</h1>
          <p className="text-sm text-slate-500">Métricas en tiempo real de operaciones logísticas</p>
        </div>
        
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-slate-50 px-3 py-2 rounded-lg border border-slate-200">
            <Filter className="w-4 h-4 text-slate-400" />
            <select
              value={dateRange}
              onChange={(e) => setDateRange(e.target.value)}
              className="bg-transparent text-sm font-semibold text-slate-700 outline-none cursor-pointer"
            >
              <option value="7days">Últimos 7 días</option>
              <option value="30days">Últimos 30 días</option>
              <option value="all">Histórico Completo</option>
            </select>
          </div>
          
          <button 
            onClick={fetchData}
            className="p-2 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors text-slate-600 shadow-sm"
            title="Actualizar datos"
          >
            <Activity className={`w-4 h-4 ${loading ? 'animate-spin text-[#002855]' : ''}`} />
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-200 flex flex-col justify-between relative overflow-hidden group">
          <div className="absolute -right-4 -top-4 w-16 h-16 bg-[#002855]/5 rounded-full transition-transform group-hover:scale-150"></div>
          <div>
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Total Despachos</p>
            <div className="flex items-end gap-2 mt-1">
              <p className="text-3xl font-black text-slate-800">{loading ? '-' : kpis.total}</p>
            </div>
            <p className="text-[10px] text-slate-400 font-medium mt-1">En el periodo seleccionado</p>
          </div>
        </div>

        <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-200 flex flex-col justify-between relative overflow-hidden group">
          <div className="absolute -right-4 -top-4 w-16 h-16 bg-blue-50 rounded-full transition-transform group-hover:scale-150"></div>
          <div>
            <p className="text-xs font-bold text-blue-600 uppercase tracking-wider">Unidades en Ruta</p>
            <div className="flex items-end gap-2 mt-1">
              <p className="text-3xl font-black text-blue-700">{loading ? '-' : kpis.kpiEnCurso}</p>
            </div>
            <p className="text-[10px] text-slate-400 font-medium mt-1">Operando actualmente</p>
          </div>
        </div>

        <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-200 flex flex-col justify-between relative overflow-hidden group">
          <div className="absolute -right-4 -top-4 w-16 h-16 bg-emerald-50 rounded-full transition-transform group-hover:scale-150"></div>
          <div>
            <p className="text-xs font-bold text-emerald-600 uppercase tracking-wider">Volumen OTs (Total)</p>
            <div className="flex items-end gap-2 mt-1">
              <p className="text-3xl font-black text-emerald-700">{loading ? '-' : kpis.totalOts}</p>
            </div>
            <p className="text-[10px] text-slate-400 font-medium mt-1">Órdenes procesadas</p>
          </div>
        </div>

        <div className={`p-5 rounded-xl shadow-sm border flex flex-col justify-between relative overflow-hidden group transition-colors ${kpis.kpiAlertas > 0 ? 'bg-red-50/50 border-red-200' : 'bg-white border-slate-200'}`}>
          <div className={`absolute -right-4 -top-4 w-16 h-16 rounded-full transition-transform group-hover:scale-150 ${kpis.kpiAlertas > 0 ? 'bg-red-100/50' : 'bg-slate-50'}`}></div>
          <div>
            <p className={`text-xs font-bold uppercase tracking-wider ${kpis.kpiAlertas > 0 ? 'text-red-600' : 'text-slate-500'}`}>Incidencias Activas</p>
            <div className="flex items-end gap-2 mt-1">
              <p className={`text-3xl font-black ${kpis.kpiAlertas > 0 ? 'text-red-700' : 'text-slate-800'}`}>{loading ? '-' : kpis.kpiAlertas}</p>
            </div>
            <p className={`text-[10px] font-medium mt-1 ${kpis.kpiAlertas > 0 ? 'text-red-500' : 'text-slate-400'}`}>Requieren atención</p>
          </div>
        </div>
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Line/Bar Chart: Evolución */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 lg:col-span-2">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-[#002855]" />
              Evolución de Viajes (Despachos por Día)
            </h3>
          </div>
          <div className="h-[250px] w-full">
            {loading ? (
              <div className="w-full h-full flex items-center justify-center text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
            ) : timelineData.length === 0 ? (
              <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">No hay datos en este periodo</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={timelineData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                  <XAxis dataKey="date" tick={{fontSize: 10, fill: '#64748b'}} axisLine={false} tickLine={false} />
                  <YAxis tick={{fontSize: 10, fill: '#64748b'}} axisLine={false} tickLine={false} />
                  <Tooltip 
                    cursor={{fill: '#f8fafc'}}
                    contentStyle={{borderRadius: '8px', border: '1px solid #e2e8f0', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)', fontSize: '12px'}}
                  />
                  <Bar dataKey="viajes" fill="#002855" radius={[4, 4, 0, 0]} maxBarSize={40} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Donut Chart: Status */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
              <Activity className="w-4 h-4 text-[#002855]" />
              Distribución de Estados
            </h3>
          </div>
          <div className="h-[250px] w-full relative">
            {loading ? (
              <div className="w-full h-full flex items-center justify-center text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
            ) : statusData.length === 0 ? (
              <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">No hay datos</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={statusData}
                    cx="50%"
                    cy="45%"
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {statusData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip 
                    contentStyle={{borderRadius: '8px', border: '1px solid #e2e8f0', fontSize: '12px'}}
                    itemStyle={{fontWeight: 'bold'}}
                  />
                  <Legend 
                    verticalAlign="bottom" 
                    height={36} 
                    iconType="circle"
                    wrapperStyle={{fontSize: '10px'}}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Top Clients Chart */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 lg:col-span-1">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
              <Route className="w-4 h-4 text-[#002855]" />
              Top Clientes (Por Volumen OTs)
            </h3>
          </div>
          <div className="h-[250px] w-full">
            {loading ? (
              <div className="w-full h-full flex items-center justify-center text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
            ) : clientData.length === 0 ? (
              <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">No hay datos</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={clientData} layout="vertical" margin={{ top: 0, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
                  <XAxis type="number" tick={{fontSize: 10, fill: '#64748b'}} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{fontSize: 9, fill: '#64748b'}} width={80} axisLine={false} tickLine={false} />
                  <Tooltip 
                    cursor={{fill: '#f8fafc'}}
                    contentStyle={{borderRadius: '8px', border: '1px solid #e2e8f0', fontSize: '11px'}}
                  />
                  <Bar dataKey="ots" fill="#10b981" radius={[0, 4, 4, 0]} maxBarSize={20} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Recent Dispatches Table */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 lg:col-span-2 flex flex-col">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-sm font-bold text-slate-800">Despachos Recientes</h3>
            <a href="/torre-control" className="text-xs font-semibold text-blue-600 hover:text-blue-800 flex items-center">
              Ver todos <ChevronRight className="w-3 h-3 ml-0.5" />
            </a>
          </div>
          
          <div className="overflow-x-auto flex-1">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-500">
                  <th className="pb-3 font-bold">Despacho</th>
                  <th className="pb-3 font-bold">Salida</th>
                  <th className="pb-3 font-bold">Recurso</th>
                  <th className="pb-3 font-bold">Estado</th>
                </tr>
              </thead>
              <tbody className="text-sm text-slate-700 divide-y divide-slate-100">
                {loading ? (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-slate-400 text-xs">Cargando datos...</td>
                  </tr>
                ) : recentDispatches.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-slate-400 text-xs">No hay despachos recientes</td>
                  </tr>
                ) : (
                  recentDispatches.map(dispatch => (
                    <tr key={dispatch.id} className="hover:bg-slate-50 transition-colors">
                      <td className="py-3 pr-4">
                        <span className="font-bold text-slate-800 text-xs block">{dispatch.dispatch_number}</span>
                        <span className="text-[10px] text-slate-500">{dispatch.dispatch_requests?.length || 0} OTs</span>
                      </td>
                      <td className="py-3 pr-4 text-xs font-medium text-slate-600">
                        {new Date(dispatch.scheduled_departure).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', hour: '2-digit', minute:'2-digit' })}
                      </td>
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-2">
                          <Truck className="w-3 h-3 text-slate-400" />
                          <span className="text-xs font-bold text-[#002855]">{dispatch.vehicle_plate}</span>
                        </div>
                      </td>
                      <td className="py-3">
                        {getStatusBadge(dispatch.status)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
