"use client"

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Loader2, Users, Activity, Coffee, Clock, AlertTriangle, ShieldAlert } from 'lucide-react'

// Tipos basados en nuestro esquema de BD
type TurnoLive = {
  id: string
  start_time: string
  status: string
  profiles: {
    first_name: string
    last_name: string
    document_number: string
  }
  operaciones_actividades: {
    id: string
    tipo_actividad: string
    start_time: string
    status: string
  }[]
}

export default function DashboardLiveTareo() {
  const [turnos, setTurnos] = useState<TurnoLive[]>([])
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(Date.now())
  const supabase = createClient()

  // Sincronizar el reloj cada segundo para que los timers se actualicen en vivo
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [])

  const fetchLiveStatus = async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('operaciones_turnos')
        .select(`
          id, start_time, status,
          profiles(first_name, last_name, document_number),
          operaciones_actividades(id, tipo_actividad, start_time, status)
        `)
        .eq('status', 'ACTIVO')
        .order('start_time', { ascending: false })

      if (error) throw error

      setTurnos(data as unknown as TurnoLive[])
    } catch (err) {
      console.error('Error fetching live status:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchLiveStatus()
    // Polling cada 30 segundos (en un escenario real usaríamos Realtime de Supabase)
    const interval = setInterval(fetchLiveStatus, 30000)
    return () => clearInterval(interval)
  }, [])

  // Utilidades para mostrar tiempos
  const getElapsed = (startIso: string) => {
    const diffMins = Math.floor((now - new Date(startIso).getTime()) / 60000)
    if (diffMins < 60) return `${diffMins}m`
    return `${Math.floor(diffMins / 60)}h ${diffMins % 60}m`
  }
  
  const getElapsedMins = (startIso: string) => {
    return Math.floor((now - new Date(startIso).getTime()) / 60000)
  }

  const getBadgeColor = (tipo: string, mins: number) => {
    if (tipo === 'BREAK') return 'bg-slate-500'
    if (tipo === 'RECEPCION') return 'bg-blue-500'
    if (tipo === 'ALMACENAJE') return 'bg-indigo-500'
    if (tipo === 'PREPARACION') return 'bg-emerald-500'
    if (mins > 120) return 'bg-red-500 animate-pulse' // Alerta si lleva > 2h en una sola actividad sin break
    return 'bg-amber-500'
  }

  // KPIs
  const totalActivos = turnos.length
  const enBreak = turnos.filter(t => 
    t.operaciones_actividades.find(a => a.status === 'EN_CURSO' && a.tipo_actividad === 'BREAK')
  ).length
  const trabajando = totalActivos - enBreak

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-black text-slate-800 tracking-tight">Tareo en Vivo</h1>
          <p className="text-slate-500 mt-1">Torre de Control de Productividad (Centro de Distribución)</p>
        </div>
        <button 
          onClick={fetchLiveStatus}
          className="bg-white border border-slate-200 text-slate-600 px-4 py-2 rounded-lg text-sm font-bold shadow-sm hover:bg-slate-50 flex items-center gap-2"
        >
          <Activity className="w-4 h-4 text-blue-500" />
          Refrescar Ahora
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200 flex items-center gap-4">
          <div className="bg-blue-100 p-4 rounded-xl text-blue-600">
            <Users className="w-8 h-8" />
          </div>
          <div>
            <p className="text-sm font-bold text-slate-500 uppercase">Jornadas Activas</p>
            <p className="text-3xl font-black text-slate-800">{totalActivos}</p>
          </div>
        </div>
        
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200 flex items-center gap-4">
          <div className="bg-emerald-100 p-4 rounded-xl text-emerald-600">
            <Activity className="w-8 h-8" />
          </div>
          <div>
            <p className="text-sm font-bold text-slate-500 uppercase">En Operación</p>
            <p className="text-3xl font-black text-slate-800">{trabajando}</p>
          </div>
        </div>
        
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200 flex items-center gap-4">
          <div className="bg-slate-100 p-4 rounded-xl text-slate-600">
            <Coffee className="w-8 h-8" />
          </div>
          <div>
            <p className="text-sm font-bold text-slate-500 uppercase">En Break / Pausa</p>
            <p className="text-3xl font-black text-slate-800">{enBreak}</p>
          </div>
        </div>
      </div>

      {/* Live Table */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-5 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
          <h2 className="font-bold text-slate-800">Operarios en Línea</h2>
          <div className="flex items-center gap-2 text-xs font-semibold text-emerald-600">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
            </span>
            Conectados
          </div>
        </div>

        {loading && turnos.length === 0 ? (
          <div className="p-20 flex justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-slate-300" />
          </div>
        ) : turnos.length === 0 ? (
          <div className="p-20 text-center text-slate-500">
            <Users className="w-12 h-12 text-slate-200 mx-auto mb-4" />
            <p>No hay operarios con turnos activos en este momento.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-6 py-4 font-bold uppercase tracking-wider text-xs">Operario</th>
                  <th className="px-6 py-4 font-bold uppercase tracking-wider text-xs">DNI</th>
                  <th className="px-6 py-4 font-bold uppercase tracking-wider text-xs">Actividad Actual</th>
                  <th className="px-6 py-4 font-bold uppercase tracking-wider text-xs">Tiempo en Actividad</th>
                  <th className="px-6 py-4 font-bold uppercase tracking-wider text-xs">Jornada Total</th>
                  <th className="px-6 py-4 font-bold uppercase tracking-wider text-xs text-right">Alerta</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {turnos.map(turno => {
                  const currAct = turno.operaciones_actividades.find(a => a.status === 'EN_CURSO')
                  const actMins = currAct ? getElapsedMins(currAct.start_time) : 0
                  const isLongActivity = actMins > 120 && currAct?.tipo_actividad !== 'BREAK'

                  return (
                    <tr key={turno.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4 font-bold text-slate-800">
                        {turno.profiles?.first_name} {turno.profiles?.last_name}
                      </td>
                      <td className="px-6 py-4 text-slate-500 font-medium">
                        {turno.profiles?.document_number}
                      </td>
                      <td className="px-6 py-4">
                        {currAct ? (
                          <span className={`px-3 py-1 text-xs font-bold text-white rounded-full ${getBadgeColor(currAct.tipo_actividad, actMins)}`}>
                            {currAct.tipo_actividad}
                          </span>
                        ) : (
                          <span className="text-slate-400 italic">Sin actividad</span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        {currAct ? (
                          <div className={`font-mono font-bold flex items-center gap-1.5 ${isLongActivity ? 'text-red-500' : 'text-slate-600'}`}>
                            <Clock className="w-4 h-4 opacity-50" />
                            {getElapsed(currAct.start_time)}
                          </div>
                        ) : '--'}
                      </td>
                      <td className="px-6 py-4 font-mono font-medium text-slate-500">
                        {getElapsed(turno.start_time)}
                      </td>
                      <td className="px-6 py-4 text-right">
                        {isLongActivity && (
                          <span title="Más de 2h en la misma actividad" className="inline-flex items-center justify-center bg-red-50 text-red-600 px-3 py-1 rounded-lg text-xs font-bold border border-red-100">
                            <ShieldAlert className="w-4 h-4 mr-1" />
                            Revisar
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
