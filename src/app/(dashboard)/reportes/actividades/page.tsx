"use client"

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { FileSpreadsheet, Loader2, Search, Printer, Calendar } from 'lucide-react'

export default function ReporteActividadesPage() {
  const [loading, setLoading] = useState(true)
  const [actividades, setActividades] = useState<any[]>([])
  const [profiles, setProfiles] = useState<any[]>([])
  const [selectedProfile, setSelectedProfile] = useState<string>('')
  const [dateFilter, setDateFilter] = useState<string>('') // YYYY-MM-DD
  const supabase = createClient()

  useEffect(() => {
    // Inicializar fecha de hoy por defecto
    const today = new Date().toISOString().split('T')[0]
    setDateFilter(today)
    loadProfiles()
  }, [])

  useEffect(() => {
    if (dateFilter) {
      loadReporte()
    }
  }, [dateFilter, selectedProfile])

  const loadProfiles = async () => {
    const { data } = await supabase
      .from('profiles')
      .select('id, first_name, last_name')
      .order('last_name')
    if (data) setProfiles(data)
  }

  const loadReporte = async () => {
    try {
      setLoading(true)
      
      let query = supabase
        .from('operaciones_actividades')
        .select(`
          id,
          tipo_actividad,
          referencia_ot,
          tipo_hora,
          observaciones,
          start_time,
          end_time,
          operaciones_turnos!inner (
            profile_id,
            profiles (
              first_name,
              last_name
            )
          )
        `)
        .gte('start_time', `${dateFilter}T00:00:00.000Z`)
        .lt('start_time', `${dateFilter}T23:59:59.999Z`)
        .order('start_time', { ascending: true })

      if (selectedProfile) {
        query = query.eq('operaciones_turnos.profile_id', selectedProfile)
      }

      const { data, error } = await query

      if (error) throw error
      
      // Filtrar BREAKS si el usuario no quiere verlos, pero por ahora los dejamos
      setActividades(data || [])
    } catch (error) {
      console.error('Error cargando reporte:', error)
    } finally {
      setLoading(false)
    }
  }

  const formatTime = (isoString: string) => {
    if (!isoString) return '-'
    const date = new Date(isoString)
    return date.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', hour12: false })
  }

  return (
    <div className="p-6">
      <div className="flex justify-between items-start mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <FileSpreadsheet className="w-6 h-6 text-indigo-600" />
            Control de Actividades (FR-DT.005)
          </h1>
          <p className="text-slate-500 mt-1">Reporte digital para el área de distribución</p>
        </div>
        <button 
          onClick={() => window.print()}
          className="bg-white border border-slate-200 text-slate-600 px-4 py-2 rounded-lg font-medium hover:bg-slate-50 flex items-center gap-2"
        >
          <Printer className="w-4 h-4" />
          Imprimir Formato
        </button>
      </div>

      {/* Filtros */}
      <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 mb-6 flex gap-4 items-end">
        <div className="flex-1">
          <label className="block text-xs font-bold text-slate-500 uppercase mb-1">
            Fecha de Operación
          </label>
          <div className="relative">
            <Calendar className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input 
              type="date"
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
        </div>

        <div className="flex-1">
          <label className="block text-xs font-bold text-slate-500 uppercase mb-1">
            Operario / Conductor
          </label>
          <div className="relative">
            <Search className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <select
              value={selectedProfile}
              onChange={(e) => setSelectedProfile(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 appearance-none bg-white"
            >
              <option value="">Todos los trabajadores</option>
              {profiles.map(p => (
                <option key={p.id} value={p.id}>{p.last_name}, {p.first_name}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Tabla Formato FR-DT.005 */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        {loading ? (
          <div className="p-12 flex justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
          </div>
        ) : actividades.length === 0 ? (
          <div className="p-12 text-center text-slate-500">
            No se encontraron actividades para estos filtros.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-slate-600 uppercase bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-6 py-4 font-bold">Trabajador</th>
                  <th className="px-6 py-4 font-bold border-l border-slate-200">Orden de Contrato</th>
                  <th className="px-6 py-4 font-bold border-l border-slate-200">Actividad</th>
                  <th className="px-6 py-4 font-bold border-l border-slate-200">Detalle u Observaciones</th>
                  <th className="px-6 py-4 font-bold border-l border-slate-200 text-center">Hora Inicio</th>
                  <th className="px-6 py-4 font-bold border-l border-slate-200 text-center">Hora Final</th>
                  <th className="px-6 py-4 font-bold border-l border-slate-200 text-center">Tipo de Hora</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {actividades.map((act) => (
                  <tr key={act.id} className="hover:bg-slate-50">
                    <td className="px-6 py-3 font-medium text-slate-800">
                      {act.operaciones_turnos?.profiles?.last_name}, {act.operaciones_turnos?.profiles?.first_name}
                    </td>
                    <td className="px-6 py-3 border-l border-slate-100 text-slate-600">
                      {act.tipo_actividad === 'BREAK' ? '-' : (act.referencia_ot || '-')}
                    </td>
                    <td className="px-6 py-3 border-l border-slate-100">
                      <span className={`px-2.5 py-1 rounded-md text-xs font-bold ${
                        act.tipo_actividad === 'BREAK' ? 'bg-slate-100 text-slate-600' : 'bg-indigo-50 text-indigo-700'
                      }`}>
                        {act.tipo_actividad}
                      </span>
                    </td>
                    <td className="px-6 py-3 border-l border-slate-100 text-slate-600 text-xs max-w-xs truncate" title={act.observaciones}>
                      {act.observaciones || '-'}
                    </td>
                    <td className="px-6 py-3 border-l border-slate-100 text-center font-mono">
                      {formatTime(act.start_time)}
                    </td>
                    <td className="px-6 py-3 border-l border-slate-100 text-center font-mono">
                      {formatTime(act.end_time)}
                    </td>
                    <td className="px-6 py-3 border-l border-slate-100 text-center">
                      {act.tipo_actividad === 'BREAK' ? '-' : (
                        <span className={`font-bold ${act.tipo_hora === 'EXTRA' ? 'text-red-600' : 'text-slate-500'}`}>
                          {act.tipo_hora === 'EXTRA' ? 'E' : 'N'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  )
}
