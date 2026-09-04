"use client"

import { useState, useEffect } from 'react'
import { Play, Square, Clock, Settings2, Loader2, CheckCircle2, ClipboardList, X } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'

// Tipos de actividad alineados con FR-DT.005
const TIPOS_ACTIVIDAD = [
  { id: 'Descarga de materiales', label: 'Descarga de materiales', color: 'bg-blue-600' },
  { id: 'Embalaje', label: 'Embalaje (Packing)', color: 'bg-amber-500' },
  { id: 'Carguio de Despacho', label: 'Carguío de Despacho', color: 'bg-orange-500' },
  { id: 'Transporte', label: 'Transporte', color: 'bg-cyan-600' },
  { id: 'Descarguio de despacho', label: 'Descarguío de despacho', color: 'bg-blue-400' },
  { id: 'Conduccion de Montacargas', label: 'Conducción Montacargas', color: 'bg-emerald-500' },
  { id: 'Conduccion de Camion o camioneta', label: 'Conducción Vehículo', color: 'bg-teal-500' },
  { id: 'Otros', label: 'Otros', color: 'bg-indigo-500' },
  { id: 'BREAK', label: 'Break / Descanso', color: 'bg-slate-400' },
]

export default function TareoPage() {
  const [loading, setLoading] = useState(true)
  const [turnoActivo, setTurnoActivo] = useState<any>(null)
  const [actividadActiva, setActividadActiva] = useState<any>(null)
  const [elapsedTime, setElapsedTime] = useState(0) // en segundos
  const [activityElapsedTime, setActivityElapsedTime] = useState(0)
  const [isChangingActivity, setIsChangingActivity] = useState(false)
  
  // Nuevos estados para Contexto OT
  const [activeOT, setActiveOT] = useState<string | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [tempOT, setTempOT] = useState('')
  const [tempTipoHora, setTempTipoHora] = useState<'NORMAL' | 'EXTRA'>('NORMAL')
  const [tempObservaciones, setTempObservaciones] = useState('')
  const [pendingActivity, setPendingActivity] = useState<string | null>(null)

  const supabase = createClient()

  // Formateador de tiempo (segundos a HH:MM:SS)
  const formatTime = (totalSeconds: number) => {
    const h = Math.floor(totalSeconds / 3600)
    const m = Math.floor((totalSeconds % 3600) / 60)
    const s = totalSeconds % 60
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  }

  // Cargar estado inicial
  const loadState = async () => {
    try {
      setLoading(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      // Buscar turno activo
      const { data: turno } = await supabase
        .from('operaciones_turnos')
        .select('*')
        .eq('profile_id', session.user.id)
        .eq('status', 'ACTIVO')
        .single()

      if (turno) {
        setTurnoActivo(turno)
        
        // Calcular tiempo transcurrido del turno
        const start = new Date(turno.start_time).getTime()
        setElapsedTime(Math.floor((Date.now() - start) / 1000))

        // Buscar actividad activa
        const { data: actividad } = await supabase
          .from('operaciones_actividades')
          .select('*')
          .eq('turno_id', turno.id)
          .eq('status', 'EN_CURSO')
          .single()

        if (actividad) {
          setActividadActiva(actividad)
          setActiveOT(actividad.referencia_ot || null)
          const actStart = new Date(actividad.start_time).getTime()
          setActivityElapsedTime(Math.floor((Date.now() - actStart) / 1000))
        }
      } else {
        setTurnoActivo(null)
        setActividadActiva(null)
      }
    } catch (error) {
      console.error('Error cargando tareo:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadState()
  }, [])

  // Timer effect
  useEffect(() => {
    let interval: NodeJS.Timeout
    if (turnoActivo) {
      interval = setInterval(() => {
        setElapsedTime(prev => prev + 1)
        if (actividadActiva) {
          setActivityElapsedTime(prev => prev + 1)
        }
      }, 1000)
    }
    return () => clearInterval(interval)
  }, [turnoActivo, actividadActiva])

  const handleIniciarTurno = async () => {
    try {
      setLoading(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      // Crear Turno
      const { data: turno, error: errorTurno } = await supabase
        .from('operaciones_turnos')
        .insert({ profile_id: session.user.id })
        .select()
        .single()

      if (errorTurno) throw errorTurno
      
      setTurnoActivo(turno)
      setElapsedTime(0)
      
      toast.success('Turno iniciado. Selecciona tu actividad para empezar.')

    } catch (error) {
      console.error(error)
      toast.error('Error al iniciar el turno')
    } finally {
      setLoading(false)
    }
  }

  const executeCambioActividad = async (tipo: string, otValue: string | null, tipoHora: string = 'NORMAL', obs: string = '') => {
    setIsChangingActivity(true)

    try {
      // Finalizar actividad actual si existe
      if (actividadActiva) {
        await supabase
          .from('operaciones_actividades')
          .update({
            end_time: new Date().toISOString(),
            status: 'COMPLETADA'
          })
          .eq('id', actividadActiva.id)
      }

      // Iniciar nueva actividad
      const { data: nuevaActividad, error } = await supabase
        .from('operaciones_actividades')
        .insert({
          turno_id: turnoActivo.id,
          tipo_actividad: tipo,
          referencia_ot: otValue,
          tipo_hora: tipoHora,
          observaciones: obs
        })
        .select()
        .single()

      if (error) throw error

      setActividadActiva(nuevaActividad)
      setActiveOT(otValue)
      setActivityElapsedTime(0)
      toast.success(`Actividad iniciada: ${tipo}`)
    } catch (error) {
      toast.error('Error al iniciar actividad')
    } finally {
      setIsChangingActivity(false)
    }
  }

  const handleCambiarActividad = (tipo: string) => {
    if (!turnoActivo || tipo === actividadActiva?.tipo_actividad) return
    
    // Si la actividad NO es break, pedimos OT, Tipo de Hora y Obs.
    if (tipo !== 'BREAK') {
      setPendingActivity(tipo)
      setTempOT(activeOT || '')
      setTempTipoHora('NORMAL')
      setTempObservaciones('')
      setIsModalOpen(true)
      return
    }

    // Si es BREAK, no pasamos OT
    if (tipo === 'BREAK') {
      executeCambioActividad(tipo, null)
      return
    }
  }

  const saveOTFromModal = () => {
    if (!tempOT.trim()) {
      toast.error('La OT no puede estar vacía')
      return
    }
    
    setIsModalOpen(false)
    
    if (pendingActivity) {
      // Iniciar nueva actividad
      executeCambioActividad(pendingActivity, tempOT.trim(), tempTipoHora, tempObservaciones.trim())
      setPendingActivity(null)
    }
  }

  const handleFinalizarTurno = async () => {
    if (!confirm('¿Estás seguro de finalizar tu jornada actual?')) return

    try {
      setLoading(true)
      const endTime = new Date().toISOString()
      
      // Cerrar actividad actual
      if (actividadActiva) {
        await supabase
          .from('operaciones_actividades')
          .update({ end_time: endTime, status: 'COMPLETADA' })
          .eq('id', actividadActiva.id)
      }

      // Cerrar turno y marcar como FINALIZADO para que pase a Revisión
      await supabase
        .from('operaciones_turnos')
        .update({ end_time: endTime, status: 'FINALIZADO' })
        .eq('id', turnoActivo.id)

      toast.success('Turno finalizado y enviado a revisión')
      setTurnoActivo(null)
      setActividadActiva(null)
      setActiveOT(null)
    } catch (error) {
      toast.error('Error al finalizar el turno')
    } finally {
      setLoading(false)
    }
  }

  if (loading && !turnoActivo) {
    return (
      <div className="flex flex-col items-center justify-center h-full pt-20">
        <Loader2 className="w-10 h-10 animate-spin text-[#002855]" />
        <p className="mt-4 text-sm text-slate-500 font-medium">Cargando tu jornada...</p>
      </div>
    )
  }

  return (
    <div className="p-4 flex flex-col h-full bg-slate-50 relative pb-20">
      <div className="mb-6">
        <h1 className="text-2xl font-black text-[#002855]">Tareo Móvil</h1>
        <p className="text-sm text-slate-500">Formato FR-DT.005 Digital</p>
      </div>

      {!turnoActivo ? (
        // ESTADO: INACTIVO
        <div className="flex-1 flex flex-col items-center justify-center -mt-10">
          <div className="bg-white p-8 rounded-3xl shadow-xl w-full max-w-sm text-center">
            <div className="bg-slate-100 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6">
              <Clock className="w-10 h-10 text-slate-400" />
            </div>
            <h2 className="text-xl font-bold text-slate-800 mb-2">Jornada no iniciada</h2>
            <p className="text-sm text-slate-500 mb-8">
              Para registrar tus actividades, necesitas iniciar tu turno.
            </p>
            
            <button 
              onClick={handleIniciarTurno}
              disabled={loading}
              className="w-full relative group overflow-hidden rounded-2xl bg-emerald-500 px-6 py-5 shadow-lg shadow-emerald-500/30 transition-all hover:scale-[1.02] active:scale-95"
            >
              <div className="relative flex items-center justify-center gap-3">
                {loading ? (
                  <Loader2 className="w-6 h-6 text-white animate-spin" />
                ) : (
                  <>
                    <Play className="w-6 h-6 text-white fill-white" />
                    <span className="text-xl font-black text-white uppercase tracking-wider">
                      Iniciar Turno
                    </span>
                  </>
                )}
              </div>
            </button>
          </div>
        </div>
      ) : (
        // ESTADO: ACTIVO
        <div className="flex flex-col gap-4">
          
          {/* Tarjeta del Cronómetro General */}
          <div className="bg-[#002855] rounded-3xl p-6 text-white text-center shadow-xl relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4 opacity-10">
              <Clock className="w-24 h-24" />
            </div>
            <p className="text-blue-200 text-sm font-bold uppercase tracking-widest mb-2 relative z-10">
              Tiempo Total de Turno
            </p>
            <div className="text-5xl font-mono font-black tracking-tighter relative z-10 mb-4">
              {formatTime(elapsedTime)}
            </div>
            
            <button 
              onClick={handleFinalizarTurno}
              className="bg-red-500 hover:bg-red-600 text-white font-bold py-2.5 px-6 rounded-xl text-sm transition-colors shadow-lg active:scale-95 flex items-center gap-2 mx-auto"
            >
              <Square className="w-4 h-4 fill-white" />
              Finalizar Jornada
            </button>
          </div>

          {/* Tarjeta de Actividad Actual */}
          <div className="bg-white rounded-3xl p-5 shadow-sm border border-slate-200">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-slate-800 flex items-center gap-2">
                <Settings2 className="w-5 h-5 text-blue-500" />
                Actividad Actual
              </h3>
              <div className="bg-slate-100 text-slate-600 px-3 py-1 rounded-lg font-mono text-sm font-bold">
                {formatTime(activityElapsedTime)}
              </div>
            </div>
            
            <p className="text-lg font-black text-[#002855] bg-blue-50/50 p-4 rounded-xl border border-blue-100 text-center mb-4">
              {actividadActiva?.tipo_actividad || 'Ninguna (Seleccione abajo)'}
            </p>

            {actividadActiva?.tipo_actividad && actividadActiva?.tipo_actividad !== 'BREAK' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-slate-50 p-3 rounded-xl border border-slate-200">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">OT / Contrato</p>
                  <p className="font-black text-sm text-slate-700 truncate">{actividadActiva?.referencia_ot || '-'}</p>
                </div>
                <div className="bg-slate-50 p-3 rounded-xl border border-slate-200">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Tipo de Hora</p>
                  <p className="font-black text-sm text-slate-700">{actividadActiva?.tipo_hora === 'EXTRA' ? 'Extra (E)' : 'Normal (N)'}</p>
                </div>
              </div>
            )}
          </div>

          {/* Grid de Selector de Actividades */}
          <div>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 ml-1 mt-2">
              Iniciar nueva actividad
            </p>
            <div className="grid grid-cols-2 gap-3">
              {TIPOS_ACTIVIDAD.map(act => (
                <button
                  key={act.id}
                  disabled={isChangingActivity}
                  onClick={() => handleCambiarActividad(act.id)}
                  className={`
                    relative p-4 rounded-2xl text-left transition-all border
                    ${actividadActiva?.tipo_actividad === act.id 
                      ? `${act.color} text-white border-transparent shadow-md scale-100 ring-2 ring-offset-2 ring-${act.color.replace('bg-', '')}` 
                      : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300 shadow-sm opacity-80'
                    }
                  `}
                >
                  {actividadActiva?.tipo_actividad === act.id && (
                    <CheckCircle2 className="absolute top-3 right-3 w-4 h-4 text-white opacity-80" />
                  )}
                  <span className="block text-sm font-black leading-tight">
                    {act.label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Modal de Detalle de Actividad */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-3xl w-full max-w-sm overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200 flex flex-col max-h-[90vh]">
            <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-indigo-50/50 shrink-0">
              <div>
                <h3 className="font-black text-indigo-900">Iniciar Actividad</h3>
                <p className="text-xs text-indigo-600 font-medium">{pendingActivity}</p>
              </div>
              <button 
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 bg-white rounded-full p-2"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-5 overflow-y-auto">
              {/* Campo OT */}
              <div className="mb-5">
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">
                  Orden de Contrato (OT) *
                </label>
                <input 
                  type="text" 
                  autoFocus
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500"
                  placeholder="Ej. OT-1042"
                  value={tempOT}
                  onChange={(e) => setTempOT(e.target.value)}
                />
              </div>

              {/* Campo Tipo de Hora */}
              <div className="mb-5">
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">
                  Tipo de Hora *
                </label>
                <div className="flex bg-slate-100 p-1 rounded-xl">
                  <button 
                    onClick={() => setTempTipoHora('NORMAL')}
                    className={`flex-1 py-2 text-sm font-bold rounded-lg transition-colors ${tempTipoHora === 'NORMAL' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}
                  >
                    Normal (N)
                  </button>
                  <button 
                    onClick={() => setTempTipoHora('EXTRA')}
                    className={`flex-1 py-2 text-sm font-bold rounded-lg transition-colors ${tempTipoHora === 'EXTRA' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-500'}`}
                  >
                    Extra (E)
                  </button>
                </div>
              </div>

              {/* Campo Observaciones */}
              <div className="mb-2">
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">
                  Detalle u Observaciones
                </label>
                <textarea 
                  rows={2}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 resize-none"
                  placeholder="Opcional..."
                  value={tempObservaciones}
                  onChange={(e) => setTempObservaciones(e.target.value)}
                />
              </div>
            </div>

            <div className="p-5 border-t border-slate-100 shrink-0">
              <button 
                onClick={saveOTFromModal}
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3.5 rounded-xl transition-colors shadow-lg shadow-indigo-500/30"
              >
                Iniciar Actividad
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
