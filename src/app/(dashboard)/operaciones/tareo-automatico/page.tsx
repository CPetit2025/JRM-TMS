"use client"

import { useState, useEffect } from 'react'
import { FileSpreadsheet, Loader2, Calendar, CheckSquare, Settings2, Play, Users } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'

export default function TareoAutomaticoPage() {
  const [loading, setLoading] = useState(false)
  const [fetching, setFetching] = useState(true)
  const [trabajadores, setTrabajadores] = useState<any[]>([])
  const [selectedWorkers, setSelectedWorkers] = useState<Set<string>>(new Set())
  const [dateTarget, setDateTarget] = useState<string>('') // YYYY-MM-DD
  const [rutasDelDia, setRutasDelDia] = useState<any[]>([])
  
  const supabase = createClient()

  useEffect(() => {
    const today = new Date().toISOString().split('T')[0]
    setDateTarget(today)
    fetchData(today)
  }, [])

  const fetchData = async (date: string) => {
    setFetching(true)
    try {
      // Traer personal de almacén sin celular
      const { data: perfiles } = await supabase
        .from('profiles')
        .select('*')
        .in('employee_type', ['Lider de Recepcion - APT', 'Montacarguista', 'Operador de Grua Estacional', 'Auxiliar de Despacho'])
        .eq('is_active', true)
        
      if (perfiles) setTrabajadores(perfiles)
      
      // Traer rutas/OTs del día
      const { data: rutas } = await supabase
        .from('dispatches')
        .select(`
          id, dispatch_number, scheduled_departure,
          dispatch_requests(transport_requests(request_number))
        `)
        .gte('scheduled_departure', `${date}T00:00:00.000Z`)
        .lt('scheduled_departure', `${date}T23:59:59.999Z`)

      if (rutas) setRutasDelDia(rutas)

    } catch (error) {
      console.error(error)
    } finally {
      setFetching(false)
    }
  }

  const handleDateChange = (newDate: string) => {
    setDateTarget(newDate)
    fetchData(newDate)
  }

  const toggleWorker = (id: string) => {
    const newSet = new Set(selectedWorkers)
    if (newSet.has(id)) newSet.delete(id)
    else newSet.add(id)
    setSelectedWorkers(newSet)
  }

  const toggleAll = () => {
    if (selectedWorkers.size === trabajadores.length) {
      setSelectedWorkers(new Set())
    } else {
      setSelectedWorkers(new Set(trabajadores.map(t => t.id)))
    }
  }

  // Extraer un arreglo plano de números de OT del día
  const getOTsDelDia = () => {
    const ots = new Set<string>()
    rutasDelDia.forEach(ruta => {
      ruta.dispatch_requests?.forEach((dr: any) => {
        if (dr.transport_requests?.request_number) {
          ots.add(dr.transport_requests.request_number)
        }
      })
    })
    return Array.from(ots)
  }

  const generarTareo = async () => {
    if (selectedWorkers.size === 0) {
      return toast.error('Selecciona al menos un trabajador')
    }
    
    const ots = getOTsDelDia()
    if (ots.length === 0) {
      return toast.error('No hay OTs (Rutas) programadas para este día')
    }

    if (!confirm(`Se generarán tareos para ${selectedWorkers.size} trabajadores, dividiendo 8 horas entre ${ots.length} OTs. ¿Continuar?`)) return

    setLoading(true)
    try {
      // Por cada trabajador seleccionado
      for (const workerId of Array.from(selectedWorkers)) {
        
        // 1. Crear Turno CERRADO (Para que ya aparezca en revisión y reportes)
        // Simulamos que empezó a las 08:00 AM y terminó a las 16:00 PM
        const startTurno = new Date(`${dateTarget}T08:00:00`).toISOString()
        const endTurno = new Date(`${dateTarget}T16:00:00`).toISOString()

        const { data: turno, error: errorTurno } = await supabase
          .from('operaciones_turnos')
          .insert({
            profile_id: workerId,
            start_time: startTurno,
            end_time: endTurno,
            status: 'FINALIZADO'
          })
          .select()
          .single()

        if (errorTurno) throw errorTurno

        // 2. Dividir 8 horas en las N OTs (8 horas = 480 minutos)
        const totalMinutes = 480
        const minutesPerOT = Math.floor(totalMinutes / ots.length)
        
        let currentTime = new Date(startTurno)

        const activitiesToInsert = ots.map((otNumber, index) => {
          const startTime = new Date(currentTime)
          
          // A la última OT le asignamos los minutos sobrantes para cuadrar exacto a las 16:00
          const duration = (index === ots.length - 1) 
            ? (totalMinutes - (minutesPerOT * (ots.length - 1)))
            : minutesPerOT

          currentTime.setMinutes(currentTime.getMinutes() + duration)
          const endTime = new Date(currentTime)

          // El tipo de actividad depende del puesto (Simplificamos a Despacho/Carguío por defecto)
          const trabajadorInfo = trabajadores.find(t => t.id === workerId)
          let tipoActividad = 'Carguío de Despacho'
          if (trabajadorInfo?.employee_type === 'Lider de Recepcion - APT') tipoActividad = 'Recepción'
          if (trabajadorInfo?.employee_type === 'Montacarguista') tipoActividad = 'Conducción Montacargas'

          return {
            turno_id: turno.id,
            tipo_actividad: tipoActividad,
            referencia_ot: otNumber,
            tipo_hora: 'NORMAL',
            observaciones: 'Generado Automáticamente por Sistema (Prorrateo Diario)',
            status: 'COMPLETADA',
            start_time: startTime.toISOString(),
            end_time: endTime.toISOString()
          }
        })

        // Insertar Actividades
        const { error: errorAct } = await supabase
          .from('operaciones_actividades')
          .insert(activitiesToInsert)

        if (errorAct) throw errorAct
      }

      toast.success('Tareo automático generado exitosamente')
      setSelectedWorkers(new Set())
    } catch (error: any) {
      toast.error('Error generando tareo: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  const totalOts = getOTsDelDia().length

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <Settings2 className="w-6 h-6 text-indigo-600" />
          Tareo Automático (Prorrateo de HH)
        </h1>
        <p className="text-slate-500 mt-1">
          Distribuye automáticamente las 8 horas de jornada del personal de almacén entre las OTs despachadas del día.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Panel de Configuración */}
        <div className="lg:col-span-1 space-y-6">
          <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-200">
            <h2 className="font-bold text-slate-800 flex items-center gap-2 mb-4">
              <Calendar className="w-5 h-5 text-indigo-500" />
              1. Fecha Operativa
            </h2>
            <input 
              type="date"
              value={dateTarget}
              onChange={(e) => handleDateChange(e.target.value)}
              className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 font-medium text-slate-700"
            />
          </div>

          <div className="bg-gradient-to-br from-indigo-600 to-indigo-800 p-6 rounded-xl shadow-lg text-white">
            <h2 className="font-bold text-indigo-100 flex items-center gap-2 mb-2">
              <FileSpreadsheet className="w-5 h-5" />
              Resumen del Reparto
            </h2>
            <div className="mt-4 flex items-end gap-3">
              <div className="text-5xl font-black">{totalOts}</div>
              <div className="text-indigo-200 mb-1 leading-tight font-medium">OTs detectadas<br/>para hoy</div>
            </div>
            
            <div className="mt-6 space-y-2">
              <div className="flex justify-between text-sm border-b border-indigo-500/30 pb-2">
                <span className="text-indigo-200">Personal seleccionado:</span>
                <span className="font-bold">{selectedWorkers.size} trabajadores</span>
              </div>
              <div className="flex justify-between text-sm border-b border-indigo-500/30 pb-2 pt-1">
                <span className="text-indigo-200">Horas a distribuir:</span>
                <span className="font-bold">8 Horas / Trabajador</span>
              </div>
              <div className="flex justify-between text-sm pt-1">
                <span className="text-indigo-200">Tiempo por OT:</span>
                <span className="font-bold">
                  {totalOts > 0 ? `${(8 / totalOts).toFixed(1)} horas c/u` : '0 horas'}
                </span>
              </div>
            </div>

            <button 
              onClick={generarTareo}
              disabled={loading || fetching || totalOts === 0 || selectedWorkers.size === 0}
              className="w-full mt-6 bg-white text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 disabled:cursor-not-allowed font-black py-3 rounded-xl transition-all flex items-center justify-center gap-2 shadow-lg"
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5 fill-indigo-700" />}
              {loading ? 'Generando...' : 'EJECUTAR REPARTO'}
            </button>
          </div>
        </div>

        {/* Lista de Trabajadores */}
        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col h-[calc(100vh-140px)]">
          <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
            <h2 className="font-bold text-slate-800 flex items-center gap-2">
              <Users className="w-5 h-5 text-indigo-500" />
              2. Seleccionar Asistentes
            </h2>
            <button 
              onClick={toggleAll}
              className="text-sm font-bold text-indigo-600 hover:text-indigo-700 bg-indigo-50 px-3 py-1.5 rounded-lg flex items-center gap-2 transition-colors"
            >
              <CheckSquare className="w-4 h-4" />
              Seleccionar Todos
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
            {fetching ? (
              <div className="flex justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-indigo-300" />
              </div>
            ) : trabajadores.length === 0 ? (
              <div className="text-center py-12 text-slate-500">
                No hay personal operativo registrado o activo.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {trabajadores.map(t => {
                  const isSelected = selectedWorkers.has(t.id)
                  return (
                    <div 
                      key={t.id}
                      onClick={() => toggleWorker(t.id)}
                      className={`
                        cursor-pointer border rounded-xl p-4 flex items-center gap-4 transition-all
                        ${isSelected 
                          ? 'border-indigo-500 bg-indigo-50/50 ring-1 ring-indigo-500 shadow-sm' 
                          : 'border-slate-200 bg-white hover:border-indigo-200 hover:bg-slate-50'
                        }
                      `}
                    >
                      <div className={`w-6 h-6 rounded border flex items-center justify-center shrink-0 transition-colors ${isSelected ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300 bg-white'}`}>
                        {isSelected && <CheckSquare className="w-4 h-4 text-white" />}
                      </div>
                      <div>
                        <p className={`font-bold ${isSelected ? 'text-indigo-900' : 'text-slate-700'}`}>
                          {t.last_name}, {t.first_name}
                        </p>
                        <p className={`text-xs font-medium ${isSelected ? 'text-indigo-600' : 'text-slate-500'}`}>
                          {t.employee_type}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  )
}
