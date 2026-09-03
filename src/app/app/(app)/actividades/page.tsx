"use client"

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Loader2, CalendarClock, History, Clock } from 'lucide-react'

export default function ActividadesPage() {
  const [turnos, setTurnos] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    const fetchHistorial = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) return

        // Traer turnos recientes del usuario
        const { data: turnosData, error: turnosError } = await supabase
          .from('operaciones_turnos')
          .select(`
            *,
            actividades:operaciones_actividades(*)
          `)
          .eq('profile_id', session.user.id)
          .order('created_at', { ascending: false })
          .limit(10)

        if (turnosError) throw turnosError

        setTurnos(turnosData || [])
      } catch (error) {
        console.error('Error fetching historial:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchHistorial()
  }, [])

  const formatHora = (dateString: string) => {
    if (!dateString) return '--:--'
    const d = new Date(dateString)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  
  const formatDate = (dateString: string) => {
    if (!dateString) return ''
    const d = new Date(dateString)
    return d.toLocaleDateString([], { day: '2-digit', month: 'short' })
  }

  const calcularDuracion = (start: string, end: string | null) => {
    const s = new Date(start).getTime()
    const e = end ? new Date(end).getTime() : Date.now()
    const diffMins = Math.floor((e - s) / 60000)
    
    if (diffMins < 60) return `${diffMins} min`
    const h = Math.floor(diffMins / 60)
    const m = diffMins % 60
    return `${h}h ${m}m`
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center h-full pt-20">
        <Loader2 className="w-8 h-8 animate-spin text-[#002855]" />
      </div>
    )
  }

  return (
    <div className="p-4 bg-slate-50 min-h-full">
      <div className="mb-6">
        <h1 className="text-2xl font-black text-[#002855] flex items-center gap-2">
          <CalendarClock className="w-7 h-7" />
          Mi Jornada
        </h1>
        <p className="text-sm text-slate-500">Historial de turnos y actividades</p>
      </div>

      {turnos.length === 0 ? (
        <div className="bg-white p-8 rounded-3xl shadow-sm border border-slate-200 text-center mt-10">
          <History className="w-12 h-12 text-slate-300 mx-auto mb-4" />
          <h3 className="text-lg font-bold text-slate-700">Sin registros</h3>
          <p className="text-slate-500 text-sm mt-2">Aún no has registrado ningún turno operativo.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {turnos.map((turno) => (
            <div key={turno.id} className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
              <div className={`p-4 border-b ${turno.status === 'ACTIVO' ? 'bg-emerald-50 border-emerald-100' : 'bg-slate-50 border-slate-100'}`}>
                <div className="flex justify-between items-center mb-1">
                  <span className="font-bold text-slate-800">
                    {formatDate(turno.created_at)}
                  </span>
                  <span className={`text-xs font-bold px-2 py-1 rounded-full ${turno.status === 'ACTIVO' ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-600'}`}>
                    {turno.status}
                  </span>
                </div>
                <div className="flex items-center text-sm text-slate-600 font-medium">
                  <Clock className="w-4 h-4 mr-1.5 opacity-70" />
                  {formatHora(turno.start_time)} - {turno.end_time ? formatHora(turno.end_time) : 'Ahora'}
                  <span className="ml-auto text-xs opacity-70 font-bold bg-white px-2 py-0.5 rounded-md border border-slate-200">
                    {calcularDuracion(turno.start_time, turno.end_time)}
                  </span>
                </div>
              </div>

              {/* Lista de actividades del turno */}
              {turno.actividades && turno.actividades.length > 0 && (
                <div className="p-4 bg-white">
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Actividades</p>
                  <div className="space-y-3 relative before:absolute before:inset-0 before:ml-[11px] before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-slate-200 before:to-transparent">
                    {turno.actividades
                      .sort((a: any, b: any) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
                      .map((act: any, idx: number) => (
                      <div key={act.id} className="relative flex items-center justify-between group">
                        <div className="flex items-center gap-3">
                          <div className="flex items-center justify-center w-6 h-6 rounded-full border-2 border-white bg-blue-500 shadow-sm z-10 text-white text-[10px] font-bold">
                            {idx + 1}
                          </div>
                          <div>
                            <p className="font-bold text-slate-800 text-sm">{act.tipo_actividad}</p>
                            <p className="text-xs text-slate-500">
                              {formatHora(act.start_time)} - {act.end_time ? formatHora(act.end_time) : '...'}
                            </p>
                          </div>
                        </div>
                        <span className="text-xs font-bold text-slate-400">
                          {calcularDuracion(act.start_time, act.end_time)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
