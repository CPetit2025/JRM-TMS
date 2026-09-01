"use client"

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { MapPin, Plus, Edit2, Trash2, Eye, EyeOff, Layers, Save, X, Circle } from 'lucide-react'

const GeofenceMap = dynamic(() => import('@/components/map/GeofenceMap'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full bg-slate-100 flex items-center justify-center rounded-xl">
      <div className="w-8 h-8 border-4 border-[#002855] border-t-transparent rounded-full animate-spin" />
    </div>
  )
})

type Geofence = {
  id: string
  name: string
  color: string
  type: string
  coordinates: [number, number][]
  is_active: boolean
  description: string | null
  created_at: string
}

const TYPE_LABELS: Record<string, string> = {
  cedi:              'CEDI / Almacén',
  depot:             'Depósito',
  zona_distribucion: 'Zona de Distribución',
  restringida:       'Zona Restringida',
}

const COLORS = ['#3B82F6', '#F59E0B', '#10B981', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316']

export default function GeocercasPage() {
  const supabase = createClient()
  const [geofences, setGeofences] = useState<Geofence[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingGeo, setEditingGeo] = useState<Geofence | null>(null)
  const [saving, setSaving] = useState(false)

  const [form, setForm] = useState({
    name: '',
    color: '#3B82F6',
    type: 'zona_distribucion',
    description: '',
    is_active: true,
    // Coordenadas ingresadas manualmente como texto lat,lng por punto
    rawCoords: '',
  })

  useEffect(() => { fetchGeofences() }, [])

  const fetchGeofences = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('geofences')
        .select('*')
        .order('name')
      if (error) throw error
      setGeofences(data || [])
    } catch (err: any) {
      toast.error('Error al cargar geocercas: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const openModal = (geo?: Geofence) => {
    if (geo) {
      setEditingGeo(geo)
      setForm({
        name: geo.name,
        color: geo.color,
        type: geo.type,
        description: geo.description || '',
        is_active: geo.is_active,
        rawCoords: geo.coordinates.map(c => `${c[0]},${c[1]}`).join('\n'),
      })
    } else {
      setEditingGeo(null)
      setForm({ name: '', color: '#3B82F6', type: 'zona_distribucion', description: '', is_active: true, rawCoords: '' })
    }
    setIsModalOpen(true)
  }

  const parseCoords = (raw: string): [number, number][] => {
    return raw.trim().split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => {
        const parts = line.split(',')
        return [parseFloat(parts[0]), parseFloat(parts[1])] as [number, number]
      })
      .filter(c => !isNaN(c[0]) && !isNaN(c[1]))
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    const coords = parseCoords(form.rawCoords)
    if (coords.length < 3) {
      toast.error('Se necesitan al menos 3 puntos (filas) para formar un polígono.')
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: form.name,
        color: form.color,
        type: form.type,
        description: form.description || null,
        is_active: form.is_active,
        coordinates: coords,
        updated_at: new Date().toISOString(),
      }

      if (editingGeo) {
        const { error } = await supabase.from('geofences').update(payload).eq('id', editingGeo.id)
        if (error) throw error
        toast.success('Geocerca actualizada')
      } else {
        const { error } = await supabase.from('geofences').insert([payload])
        if (error) throw error
        toast.success('Geocerca creada correctamente')
      }
      setIsModalOpen(false)
      fetchGeofences()
    } catch (err: any) {
      toast.error('Error al guardar: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleToggleActive = async (geo: Geofence) => {
    try {
      const { error } = await supabase
        .from('geofences')
        .update({ is_active: !geo.is_active })
        .eq('id', geo.id)
      if (error) throw error
      toast.success(geo.is_active ? 'Geocerca desactivada' : 'Geocerca activada')
      fetchGeofences()
    } catch (err: any) {
      toast.error('Error: ' + err.message)
    }
  }

  const handleDelete = async (geo: Geofence) => {
    if (!confirm(`¿Eliminar la geocerca "${geo.name}"? Esta acción no se puede deshacer.`)) return
    try {
      const { error } = await supabase.from('geofences').delete().eq('id', geo.id)
      if (error) throw error
      toast.success('Geocerca eliminada')
      if (selectedId === geo.id) setSelectedId(null)
      fetchGeofences()
    } catch (err: any) {
      toast.error('Error: ' + err.message)
    }
  }

  return (
    <div className="h-[calc(100vh-2rem)] flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between bg-white px-5 py-3 rounded-xl shadow-sm border border-slate-200 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-[#002855] rounded-lg flex items-center justify-center">
            <Layers className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-black text-slate-800">Gestión de Geocercas</h1>
            <p className="text-xs text-slate-500">Zonas operativas y de control sobre el mapa</p>
          </div>
        </div>
        <button
          onClick={() => openModal()}
          className="flex items-center gap-2 bg-[#002855] text-white px-4 py-2 rounded-xl text-sm font-bold hover:bg-[#001d3d] transition-colors shadow"
        >
          <Plus className="w-4 h-4" />
          Nueva Geocerca
        </button>
      </div>

      {/* Main */}
      <div className="flex-1 flex gap-3 min-h-0">
        {/* Left panel */}
        <div className="w-80 bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col shrink-0 overflow-hidden">
          <div className="p-3 border-b border-slate-100 bg-slate-50">
            <p className="text-xs font-bold text-slate-600 uppercase tracking-wide">
              {geofences.length} zona{geofences.length !== 1 ? 's' : ''} configurada{geofences.length !== 1 ? 's' : ''}
            </p>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-50">
            {loading ? (
              <div className="p-8 text-center">
                <div className="w-6 h-6 border-2 border-[#002855] border-t-transparent rounded-full animate-spin mx-auto" />
              </div>
            ) : geofences.length === 0 ? (
              <div className="p-8 text-center text-slate-400">
                <MapPin className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No hay geocercas configuradas</p>
                <p className="text-xs mt-1">Crea la primera con el botón de arriba</p>
              </div>
            ) : (
              geofences.map(geo => (
                <div
                  key={geo.id}
                  onClick={() => setSelectedId(geo.id === selectedId ? null : geo.id)}
                  className={`p-3 cursor-pointer transition-all ${
                    selectedId === geo.id ? 'bg-blue-50 border-l-4 border-l-[#002855]' : 'hover:bg-slate-50 border-l-4 border-l-transparent'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <div className="w-4 h-4 rounded-full shrink-0 border-2 border-white shadow" style={{ backgroundColor: geo.color }} />
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-slate-800 truncate">{geo.name}</p>
                        <p className="text-[10px] text-slate-500">{TYPE_LABELS[geo.type] || geo.type} · {geo.coordinates.length} puntos</p>
                      </div>
                    </div>
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ${
                      geo.is_active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'
                    }`}>
                      {geo.is_active ? 'ACTIVA' : 'INACTIVA'}
                    </span>
                  </div>

                  {geo.description && (
                    <p className="text-[10px] text-slate-400 mt-1.5 pl-6 line-clamp-1">{geo.description}</p>
                  )}

                  {selectedId === geo.id && (
                    <div className="flex gap-1.5 mt-2.5 pl-6">
                      <button
                        onClick={(e) => { e.stopPropagation(); openModal(geo) }}
                        className="flex items-center gap-1 text-[10px] bg-white border border-slate-200 text-slate-700 px-2 py-1 rounded-lg hover:bg-slate-50 font-medium"
                      >
                        <Edit2 className="w-3 h-3" /> Editar
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleToggleActive(geo) }}
                        className={`flex items-center gap-1 text-[10px] px-2 py-1 rounded-lg font-medium border ${
                          geo.is_active
                            ? 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                            : 'bg-green-50 border-green-200 text-green-700'
                        }`}
                      >
                        {geo.is_active ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                        {geo.is_active ? 'Desactivar' : 'Activar'}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(geo) }}
                        className="flex items-center gap-1 text-[10px] bg-red-50 border border-red-200 text-red-600 px-2 py-1 rounded-lg hover:bg-red-100 font-medium"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Legend */}
          <div className="p-3 border-t border-slate-100 bg-slate-50">
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-2">Tipos de Zona</p>
            <div className="space-y-1">
              {Object.entries(TYPE_LABELS).map(([key, label]) => (
                <div key={key} className="flex items-center gap-2">
                  <Circle className="w-2.5 h-2.5 text-slate-300 fill-slate-200 shrink-0" />
                  <span className="text-[10px] text-slate-500">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Map */}
        <div className="flex-1 rounded-xl overflow-hidden relative">
          <GeofenceMap geofences={geofences} selectedId={selectedId} onSelect={setSelectedId} />
        </div>
      </div>

      {/* Modal: Crear/Editar Geocerca */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[1000] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h2 className="text-lg font-black text-slate-800">
                {editingGeo ? 'Editar Geocerca' : 'Nueva Geocerca'}
              </h2>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="p-6 space-y-4">
              {/* Nombre */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Nombre de la Zona *</label>
                <input
                  required
                  type="text"
                  placeholder="Ej: CEDI Principal - Callao"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none"
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                />
              </div>

              {/* Tipo + Color */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Tipo</label>
                  <select
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none"
                    value={form.type}
                    onChange={e => setForm({ ...form, type: e.target.value })}
                  >
                    {Object.entries(TYPE_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Color en el mapa</label>
                  <div className="flex gap-1.5 flex-wrap pt-0.5">
                    {COLORS.map(c => (
                      <button
                        key={c} type="button"
                        onClick={() => setForm({ ...form, color: c })}
                        className="w-6 h-6 rounded-full border-2 transition-all"
                        style={{ backgroundColor: c, borderColor: form.color === c ? '#1e3a5f' : 'transparent', transform: form.color === c ? 'scale(1.2)' : 'scale(1)' }}
                      />
                    ))}
                  </div>
                </div>
              </div>

              {/* Descripción */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Descripción (opcional)</label>
                <input
                  type="text"
                  placeholder="Ej: Zona de descarga principal, horario 7am - 5pm"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none"
                  value={form.description}
                  onChange={e => setForm({ ...form, description: e.target.value })}
                />
              </div>

              {/* Coordenadas */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Coordenadas del polígono * <span className="text-slate-400 font-normal">(una por línea: latitud,longitud)</span>
                </label>
                <textarea
                  required
                  rows={5}
                  placeholder={`-12.052,-77.130\n-12.052,-77.100\n-12.075,-77.100\n-12.075,-77.130`}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900 font-mono focus:ring-2 focus:ring-[#002855] outline-none resize-none"
                  value={form.rawCoords}
                  onChange={e => setForm({ ...form, rawCoords: e.target.value })}
                />
                <p className="text-[10px] text-slate-400 mt-1">
                  💡 Puedes obtener coordenadas haciendo clic derecho en Google Maps → "¿Qué hay aquí?" y copiar latitud,longitud.
                  Mínimo 3 puntos para formar un polígono.
                </p>
              </div>

              {/* Activa */}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setForm({ ...form, is_active: !form.is_active })}
                  className={`w-12 h-6 rounded-full transition-colors relative ${form.is_active ? 'bg-[#002855]' : 'bg-slate-300'}`}
                >
                  <div className={`w-5 h-5 bg-white rounded-full absolute top-0.5 transition-all shadow-sm ${form.is_active ? 'left-6' : 'left-0.5'}`} />
                </button>
                <span className="text-sm text-slate-700 font-medium">
                  {form.is_active ? 'Geocerca activa (visible en el mapa)' : 'Geocerca inactiva (oculta del mapa)'}
                </span>
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="flex-1 py-2.5 border border-slate-300 text-slate-700 rounded-xl text-sm font-bold hover:bg-slate-50"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex-1 py-2.5 bg-[#002855] text-white rounded-xl text-sm font-bold hover:bg-[#001d3d] disabled:opacity-70 flex items-center justify-center gap-2"
                >
                  {saving ? (
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )}
                  {editingGeo ? 'Guardar cambios' : 'Crear Geocerca'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
