"use client"

import React, { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { 
  Loader2, CheckCircle, XCircle, Search, 
  CalendarDays, Clock, FileText, ChevronDown, ChevronUp, Edit2
} from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { toast } from 'sonner'

type TurnoFinalizado = {
  id: string
  start_time: string
  end_time: string
  status: string
  supervisor_status: string
  supervisor_comments: string | null
  profiles: {
    first_name: string
    last_name: string
    document_number: string
  }
  operaciones_actividades: {
    id: string
    tipo_actividad: string
    start_time: string
    end_time: string
    status: string
    referencia_ot?: string
  }[]
}

export default function RevisionTareosPage() {
  const [turnos, setTurnos] = useState<TurnoFinalizado[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  
  const [observarId, setObservarId] = useState<string | null>(null)
  const [comentario, setComentario] = useState('')
  const [actionLoading, setActionLoading] = useState(false)

  const [editingActivity, setEditingActivity] = useState<any>(null)
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)

  const supabase = createClient()

  const handleSaveActivity = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editingActivity) return
    setActionLoading(true)
    try {
      const { error } = await supabase
        .from('operaciones_actividades')
        .update({
          tipo_actividad: editingActivity.tipo_actividad,
          start_time: editingActivity.start_time,
          end_time: editingActivity.end_time || null,
          referencia_ot: editingActivity.referencia_ot || null
        })
        .eq('id', editingActivity.id)

      if (error) throw error
      setIsEditModalOpen(false)
      setEditingActivity(null)
      await fetchTurnos()
    } catch (err: any) {
      toast.error("Error al actualizar la actividad: " + err.message)
    } finally {
      setActionLoading(false)
    }
  }

  const fetchTurnos = async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('operaciones_turnos')
        .select(`
          id, start_time, end_time, status, supervisor_status, supervisor_comments,
          profiles(first_name, last_name, document_number),
          operaciones_actividades(id, tipo_actividad, start_time, end_time, status, referencia_ot)
        `)
        .eq('status', 'FINALIZADO')
        .order('end_time', { ascending: false })
        .limit(50)

      if (error) throw error

      setTurnos(data as unknown as TurnoFinalizado[])
    } catch (err) {
      console.error('Error fetching turnos:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchTurnos()
  }, [])

  const handleAprobar = async (id: string) => {
    try {
      setActionLoading(true)
      const { error } = await supabase
        .from('operaciones_turnos')
        .update({ supervisor_status: 'APROBADO', supervisor_comments: null })
        .eq('id', id)
      
      if (error) throw error
      await fetchTurnos()
    } catch (err) {
      console.error(err)
      alert("Error al aprobar")
    } finally {
      setActionLoading(false)
    }
  }

  const handleObservar = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!observarId || !comentario.trim()) return

    try {
      setActionLoading(true)
      const { error } = await supabase
        .from('operaciones_turnos')
        .update({ supervisor_status: 'OBSERVADO', supervisor_comments: comentario })
        .eq('id', observarId)
      
      if (error) throw error
      setObservarId(null)
      setComentario('')
      await fetchTurnos()
    } catch (err) {
      console.error(err)
      alert("Error al observar")
    } finally {
      setActionLoading(false)
    }
  }

  const calcularDuracion = (start: string, end: string) => {
    if (!start || !end) return '--'
    const s = new Date(start).getTime()
    const e = new Date(end).getTime()
    const diffMins = Math.floor((e - s) / 60000)
    
    if (diffMins < 60) return `${diffMins} min`
    return `${Math.floor(diffMins / 60)}h ${diffMins % 60}m`
  }

  const formatHora = (dateString: string) => {
    if (!dateString) return '--:--'
    return new Date(dateString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  const formatDate = (dateString: string) => {
    if (!dateString) return ''
    return new Date(dateString).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' })
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-black text-slate-800 tracking-tight">Revisión de Tareos</h1>
          <p className="text-slate-500 mt-1">Bandeja de aprobación de jornadas finalizadas.</p>
        </div>
        <button 
          onClick={fetchTurnos}
          className="bg-white border border-slate-200 text-slate-600 px-4 py-2 rounded-lg text-sm font-bold shadow-sm hover:bg-slate-50 flex items-center gap-2"
        >
          Actualizar
        </button>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-5 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input 
                type="text" 
                placeholder="Buscar por DNI o Nombre..." 
                className="pl-9 pr-4 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <span className="flex items-center gap-1.5 text-xs font-bold text-slate-500 bg-white px-3 py-1 rounded-full border border-slate-200">
              <div className="w-2 h-2 rounded-full bg-slate-300"></div> Pendientes
            </span>
            <span className="flex items-center gap-1.5 text-xs font-bold text-slate-500 bg-white px-3 py-1 rounded-full border border-slate-200">
              <div className="w-2 h-2 rounded-full bg-emerald-400"></div> Aprobados
            </span>
            <span className="flex items-center gap-1.5 text-xs font-bold text-slate-500 bg-white px-3 py-1 rounded-full border border-slate-200">
              <div className="w-2 h-2 rounded-full bg-red-400"></div> Observados
            </span>
          </div>
        </div>

        {loading ? (
          <div className="p-20 flex justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-slate-300" />
          </div>
        ) : turnos.length === 0 ? (
          <div className="p-20 text-center text-slate-500">
            <FileText className="w-12 h-12 text-slate-200 mx-auto mb-4" />
            <p>No hay tareos finalizados para revisar.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-6 py-4 font-bold uppercase tracking-wider text-xs">Operario</th>
                  <th className="px-6 py-4 font-bold uppercase tracking-wider text-xs">Fecha / Horario</th>
                  <th className="px-6 py-4 font-bold uppercase tracking-wider text-xs">Duración</th>
                  <th className="px-6 py-4 font-bold uppercase tracking-wider text-xs">Estado</th>
                  <th className="px-6 py-4 font-bold uppercase tracking-wider text-xs text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {turnos.map(turno => {
                  const isExpanded = expandedId === turno.id
                  const status = turno.supervisor_status || 'PENDIENTE'
                  
                  let statusColor = 'bg-slate-100 text-slate-600'
                  if (status === 'APROBADO') statusColor = 'bg-emerald-100 text-emerald-700'
                  if (status === 'OBSERVADO') statusColor = 'bg-red-100 text-red-700'

                  return (
                    <React.Fragment key={turno.id}>
                      <tr className={`hover:bg-slate-50 transition-colors ${isExpanded ? 'bg-blue-50/30' : ''}`}>
                        <td className="px-6 py-4">
                          <div className="font-bold text-slate-800">
                            {turno.profiles?.first_name} {turno.profiles?.last_name}
                          </div>
                          <div className="text-xs text-slate-500 font-medium mt-0.5">
                            DNI: {turno.profiles?.document_number}
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2 text-slate-700 font-medium mb-1">
                            <CalendarDays className="w-4 h-4 opacity-50" />
                            {formatDate(turno.start_time)}
                          </div>
                          <div className="flex items-center gap-2 text-xs text-slate-500 font-bold">
                            <Clock className="w-3.5 h-3.5 opacity-50" />
                            {formatHora(turno.start_time)} - {formatHora(turno.end_time)}
                          </div>
                        </td>
                        <td className="px-6 py-4 font-mono font-bold text-slate-600">
                          {calcularDuracion(turno.start_time, turno.end_time)}
                        </td>
                        <td className="px-6 py-4">
                          <span className={`px-3 py-1 rounded-full text-xs font-bold ${statusColor}`}>
                            {status}
                          </span>
                          {status === 'OBSERVADO' && (
                            <div className="text-[10px] text-red-500 mt-1 max-w-[150px] truncate" title={turno.supervisor_comments || ''}>
                              "{turno.supervisor_comments}"
                            </div>
                          )}
                        </td>
                        <td className="px-6 py-4 text-right space-x-2">
                          <button 
                            onClick={() => setExpandedId(isExpanded ? null : turno.id)}
                            className="inline-flex items-center justify-center p-2 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                            title="Ver Detalle"
                          >
                            {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                          </button>
                        </td>
                      </tr>
                      
                      {/* Fila Expandida: Desglose y Acciones */}
                      {isExpanded && (
                        <tr>
                          <td colSpan={5} className="bg-slate-50 border-b-2 border-slate-200 p-0">
                            <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-8">
                              
                              {/* Lado Izquierdo: Línea de tiempo */}
                              <div>
                                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Desglose de Actividades</h4>
                                <div className="space-y-3 relative before:absolute before:inset-0 before:ml-[11px] before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-slate-200 before:to-transparent">
                                  {turno.operaciones_actividades
                                    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
                                    .map((act, idx) => (
                                    <div key={act.id} className="relative flex items-center justify-between group">
                                      <div className="flex items-center gap-3">
                                        <div className="flex items-center justify-center w-6 h-6 rounded-full border-2 border-white bg-slate-400 shadow-sm z-10 text-white text-[10px] font-bold">
                                          {idx + 1}
                                        </div>
                                        <div>
                                          <p className="font-bold text-slate-700 text-sm">
                                            {act.tipo_actividad}
                                            {act.referencia_ot && (
                                              <span className="ml-2 px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full">
                                                OT: {act.referencia_ot}
                                              </span>
                                            )}
                                          </p>
                                          <p className="text-xs text-slate-500">
                                            {formatHora(act.start_time)} - {act.end_time ? formatHora(act.end_time) : '...'}
                                          </p>
                                        </div>
                                      </div>
                                      <div className="flex items-center gap-4">
                                        <span className="text-xs font-bold text-slate-400">
                                          {calcularDuracion(act.start_time, act.end_time)}
                                        </span>
                                        <button 
                                          onClick={() => {
                                            setEditingActivity({
                                              ...act,
                                              start_time: new Date(new Date(act.start_time).getTime() - (new Date().getTimezoneOffset() * 60000)).toISOString().slice(0, 16),
                                              end_time: act.end_time ? new Date(new Date(act.end_time).getTime() - (new Date().getTimezoneOffset() * 60000)).toISOString().slice(0, 16) : ''
                                            })
                                            setIsEditModalOpen(true)
                                          }}
                                          title="Editar Registro de Tiempo"
                                          className="p-1.5 text-blue-600 bg-blue-50 hover:bg-blue-100 transition-colors rounded border border-blue-200 opacity-0 group-hover:opacity-100"
                                        >
                                          <Edit2 className="w-3.5 h-3.5" />
                                        </button>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>

                              {/* Lado Derecho: Acciones */}
                              <div className="flex flex-col">
                                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Acción Requerida</h4>
                                
                                {observarId === turno.id ? (
                                  <form onSubmit={handleObservar} className="bg-white p-4 rounded-xl shadow-sm border border-slate-200">
                                    <label className="block text-sm font-bold text-slate-700 mb-2">Motivo de la Observación</label>
                                    <textarea 
                                      className="w-full border border-slate-200 rounded-lg p-2 text-sm focus:outline-none focus:border-red-400"
                                      rows={3}
                                      value={comentario}
                                      onChange={(e) => setComentario(e.target.value)}
                                      placeholder="Ej. El tiempo de recepción excede el estándar..."
                                      required
                                      disabled={actionLoading}
                                    />
                                    <div className="flex justify-end gap-2 mt-3">
                                      <button 
                                        type="button" 
                                        onClick={() => { setObservarId(null); setComentario(''); }}
                                        className="px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100 rounded-md font-medium"
                                        disabled={actionLoading}
                                      >
                                        Cancelar
                                      </button>
                                      <button 
                                        type="submit"
                                        className="px-3 py-1.5 text-sm bg-red-500 text-white hover:bg-red-600 rounded-md font-bold disabled:opacity-50 flex items-center gap-2"
                                        disabled={actionLoading}
                                      >
                                        {actionLoading && <Loader2 className="w-3 h-3 animate-spin" />}
                                        Guardar Observación
                                      </button>
                                    </div>
                                  </form>
                                ) : (
                                  <div className="flex flex-col gap-3">
                                    {status !== 'APROBADO' && (
                                      <button 
                                        onClick={() => handleAprobar(turno.id)}
                                        disabled={actionLoading}
                                        className="w-full flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-600 text-white py-3 rounded-xl font-bold transition-colors disabled:opacity-50 shadow-sm shadow-emerald-500/20"
                                      >
                                        <CheckCircle className="w-5 h-5" />
                                        Aprobar Tareo
                                      </button>
                                    )}
                                    {status !== 'OBSERVADO' && (
                                      <button 
                                        onClick={() => setObservarId(turno.id)}
                                        disabled={actionLoading}
                                        className="w-full flex items-center justify-center gap-2 bg-white border-2 border-slate-200 hover:border-red-200 hover:text-red-500 text-slate-600 py-2.5 rounded-xl font-bold transition-colors disabled:opacity-50"
                                      >
                                        <XCircle className="w-5 h-5" />
                                        Observar Tiempos
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>

                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal
        isOpen={isEditModalOpen}
        onClose={() => {
          setIsEditModalOpen(false)
          setEditingActivity(null)
        }}
        title="Editar Actividad de Tareo"
        maxWidth="max-w-lg"
      >
        <form onSubmit={handleSaveActivity} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Tipo de Actividad</label>
            <select
              className="w-full border-slate-300 rounded-lg shadow-sm focus:ring-[#002855] focus:border-[#002855]"
              value={editingActivity?.tipo_actividad || ''}
              onChange={(e) => setEditingActivity({ ...editingActivity, tipo_actividad: e.target.value })}
              required
            >
              <option value="REVISIÓN MECÁNICA">Revisión Mecánica</option>
              <option value="TRASLADO A CLIENTE">Traslado a Cliente</option>
              <option value="RECEPCIÓN CLIENTE">Recepción Cliente</option>
              <option value="DESCARGA">Descarga</option>
              <option value="ALMUERZO / REFRIGERIO">Almuerzo / Refrigerio</option>
              <option value="RETORNO A PLANTA">Retorno a Planta</option>
              <option value="PAUSA ACTIVA">Pausa Activa</option>
              <option value="OTROS">Otros</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">OT de Referencia (Opcional)</label>
            <input 
              type="text" 
              className="w-full border-slate-300 rounded-lg shadow-sm focus:ring-[#002855] focus:border-[#002855] uppercase"
              value={editingActivity?.referencia_ot || ''}
              onChange={(e) => setEditingActivity({ ...editingActivity, referencia_ot: e.target.value.toUpperCase() })}
              placeholder="Ej. S001"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Hora Inicio</label>
              <input 
                type="datetime-local" 
                className="w-full border-slate-300 rounded-lg shadow-sm focus:ring-[#002855] focus:border-[#002855]"
                value={editingActivity?.start_time || ''}
                onChange={(e) => setEditingActivity({ ...editingActivity, start_time: e.target.value })}
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Hora Fin</label>
              <input 
                type="datetime-local" 
                className="w-full border-slate-300 rounded-lg shadow-sm focus:ring-[#002855] focus:border-[#002855]"
                value={editingActivity?.end_time || ''}
                onChange={(e) => setEditingActivity({ ...editingActivity, end_time: e.target.value })}
              />
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-slate-100">
            <button
              type="button"
              onClick={() => { setIsEditModalOpen(false); setEditingActivity(null); }}
              className="px-4 py-2 text-slate-700 bg-slate-100 rounded-lg font-medium hover:bg-slate-200"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={actionLoading}
              className="px-4 py-2 bg-[#002855] text-white rounded-lg font-medium hover:bg-[#001d3d] disabled:opacity-50 flex items-center gap-2"
            >
              {actionLoading && <Loader2 className="w-4 h-4 animate-spin" />}
              Guardar Cambios
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
