"use client"

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { MapPin, Plus, Edit, Trash2, CheckCircle, XCircle, Loader2 } from 'lucide-react'

type AuthorizedLocation = {
  id: string
  name: string
  address: string
  latitude: number
  longitude: number
  radius_km: number
  is_active: boolean
}

export default function UbicacionesPage() {
  const [locations, setLocations] = useState<AuthorizedLocation[]>([])
  const [loading, setLoading] = useState(true)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingLocation, setEditingLocation] = useState<AuthorizedLocation | null>(null)
  
  const [formData, setFormData] = useState({
    name: '',
    address: '',
    latitude: '',
    longitude: '',
    radius_km: '0.5',
    is_active: true
  })

  const supabase = createClient()

  useEffect(() => {
    fetchLocations()
  }, [])

  const fetchLocations = async () => {
    try {
      const { data, error } = await supabase
        .from('authorized_locations')
        .select('*')
        .order('name', { ascending: true })

      if (error) throw error
      setLocations(data || [])
    } catch (err: any) {
      toast.error('Error al cargar ubicaciones: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleOpenModal = (loc?: AuthorizedLocation) => {
    if (loc) {
      setEditingLocation(loc)
      setFormData({
        name: loc.name,
        address: loc.address || '',
        latitude: loc.latitude.toString(),
        longitude: loc.longitude.toString(),
        radius_km: loc.radius_km.toString(),
        is_active: loc.is_active
      })
    } else {
      setEditingLocation(null)
      setFormData({
        name: '',
        address: '',
        latitude: '',
        longitude: '',
        radius_km: '0.5',
        is_active: true
      })
    }
    setIsModalOpen(true)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!formData.name || !formData.latitude || !formData.longitude || !formData.radius_km) {
      toast.error('Por favor completa los campos obligatorios (Nombre, Latitud, Longitud, Radio)')
      return
    }

    try {
      const payload = {
        name: formData.name,
        address: formData.address,
        latitude: parseFloat(formData.latitude),
        longitude: parseFloat(formData.longitude),
        radius_km: parseFloat(formData.radius_km),
        is_active: formData.is_active
      }

      if (editingLocation) {
        const { error } = await supabase
          .from('authorized_locations')
          .update(payload)
          .eq('id', editingLocation.id)
        if (error) throw error
        toast.success('Ubicación actualizada correctamente')
      } else {
        const { error } = await supabase
          .from('authorized_locations')
          .insert([payload])
        if (error) throw error
        toast.success('Ubicación creada correctamente')
      }
      
      setIsModalOpen(false)
      fetchLocations()
    } catch (err: any) {
      toast.error('Error al guardar: ' + err.message)
    }
  }

  const handleToggleActive = async (loc: AuthorizedLocation) => {
    try {
      const { error } = await supabase
        .from('authorized_locations')
        .update({ is_active: !loc.is_active })
        .eq('id', loc.id)
      if (error) throw error
      toast.success(loc.is_active ? 'Ubicación desactivada' : 'Ubicación activada')
      fetchLocations()
    } catch (err: any) {
      toast.error('Error al cambiar estado: ' + err.message)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('¿Estás seguro de eliminar esta ubicación? Esta acción no se puede deshacer.')) return
    
    try {
      const { error } = await supabase
        .from('authorized_locations')
        .delete()
        .eq('id', id)
      if (error) throw error
      toast.success('Ubicación eliminada')
      fetchLocations()
    } catch (err: any) {
      toast.error('Error al eliminar: ' + err.message)
    }
  }

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[#002855]" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Geocercas (Bases Autorizadas)</h1>
          <p className="text-sm text-slate-500">Administra las ubicaciones permitidas para iniciar el Checklist</p>
        </div>
        <button 
          onClick={() => handleOpenModal()}
          className="flex items-center gap-2 bg-[#002855] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#001d3d] transition-colors"
        >
          <Plus className="w-4 h-4" />
          Nueva Ubicación
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-50 text-slate-500 text-xs text-left border-b border-slate-100 uppercase tracking-wider">
              <tr>
                <th className="p-4 font-semibold">Ubicación</th>
                <th className="p-4 font-semibold">Coordenadas</th>
                <th className="p-4 font-semibold">Radio (KM)</th>
                <th className="p-4 font-semibold">Estado</th>
                <th className="p-4 font-semibold text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {locations.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-slate-500">
                    No hay ubicaciones registradas.
                  </td>
                </tr>
              ) : (
                locations.map(loc => (
                  <tr key={loc.id} className="hover:bg-slate-50 transition-colors">
                    <td className="p-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                          <MapPin className="w-5 h-5 text-blue-600" />
                        </div>
                        <div>
                          <p className="font-bold text-[#002855]">{loc.name}</p>
                          <p className="text-xs text-slate-500">{loc.address}</p>
                        </div>
                      </div>
                    </td>
                    <td className="p-4">
                      <p className="text-sm text-slate-700">{loc.latitude}, {loc.longitude}</p>
                      <a 
                        href={`https://www.google.com/maps/search/?api=1&query=${loc.latitude},${loc.longitude}`}
                        target="_blank" 
                        rel="noreferrer"
                        className="text-xs text-blue-600 hover:underline"
                      >
                        Ver en Google Maps
                      </a>
                    </td>
                    <td className="p-4">
                      <p className="text-sm font-semibold text-slate-700">{loc.radius_km} km</p>
                      <p className="text-xs text-slate-500">Tolerancia GPS</p>
                    </td>
                    <td className="p-4">
                      <button 
                        onClick={() => handleToggleActive(loc)}
                        className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold transition-colors ${
                          loc.is_active 
                            ? 'bg-green-100 text-green-700 hover:bg-green-200' 
                            : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                        }`}
                      >
                        {loc.is_active ? (
                          <><CheckCircle className="w-3 h-3" /> Activo</>
                        ) : (
                          <><XCircle className="w-3 h-3" /> Inactivo</>
                        )}
                      </button>
                    </td>
                    <td className="p-4 text-right">
                      <div className="flex justify-end gap-2">
                        <button 
                          onClick={() => handleOpenModal(loc)}
                          className="p-2 text-slate-400 hover:text-blue-600 transition-colors bg-white border border-slate-200 rounded-lg shadow-sm"
                          title="Editar"
                        >
                          <Edit className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={() => handleDelete(loc.id)}
                          className="p-2 text-slate-400 hover:text-red-600 transition-colors bg-white border border-slate-200 rounded-lg shadow-sm"
                          title="Eliminar"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 bg-black/60 z-[100] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
            <div className="p-5 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <h3 className="font-bold text-slate-800 text-lg flex items-center gap-2">
                <MapPin className="w-5 h-5 text-blue-600" />
                {editingLocation ? 'Editar Ubicación' : 'Nueva Ubicación'}
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-600 transition-colors">
                <XCircle className="w-6 h-6" />
              </button>
            </div>
            
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">Nombre de la Base *</label>
                <input 
                  type="text" 
                  required
                  value={formData.name}
                  onChange={e => setFormData({...formData, name: e.target.value})}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-[#002855] focus:border-[#002855]"
                  placeholder="Ej. Planta Chilca"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">Dirección</label>
                <input 
                  type="text" 
                  value={formData.address}
                  onChange={e => setFormData({...formData, address: e.target.value})}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-[#002855] focus:border-[#002855]"
                  placeholder="Ej. Panamericana Sur Km 62"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-1">Latitud *</label>
                  <input 
                    type="number" 
                    step="any"
                    required
                    value={formData.latitude}
                    onChange={e => setFormData({...formData, latitude: e.target.value})}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-[#002855] focus:border-[#002855]"
                    placeholder="-12.5204"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-1">Longitud *</label>
                  <input 
                    type="number" 
                    step="any"
                    required
                    value={formData.longitude}
                    onChange={e => setFormData({...formData, longitude: e.target.value})}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-[#002855] focus:border-[#002855]"
                    placeholder="-76.7371"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 items-center pt-2">
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-1">Radio Tolerancia (KM) *</label>
                  <input 
                    type="number" 
                    step="0.1"
                    min="0.1"
                    required
                    value={formData.radius_km}
                    onChange={e => setFormData({...formData, radius_km: e.target.value})}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-[#002855] focus:border-[#002855]"
                  />
                  <p className="text-xs text-slate-500 mt-1">Ej. 0.5 (500 metros)</p>
                </div>
                
                <div className="flex items-center gap-2 mt-4">
                  <input 
                    type="checkbox"
                    id="isActive"
                    checked={formData.is_active}
                    onChange={e => setFormData({...formData, is_active: e.target.checked})}
                    className="w-4 h-4 rounded border-slate-300 text-[#002855] focus:ring-[#002855]"
                  />
                  <label htmlFor="isActive" className="text-sm font-semibold text-slate-700 cursor-pointer">
                    Geocerca Activa
                  </label>
                </div>
              </div>

              <div className="pt-6 flex gap-3">
                <button type="button" onClick={() => setIsModalOpen(false)} className="flex-1 px-4 py-2 bg-slate-100 text-slate-700 rounded-lg font-bold">
                  Cancelar
                </button>
                <button type="submit" className="flex-1 px-4 py-2 bg-[#002855] text-white rounded-lg font-bold hover:bg-[#001d3d]">
                  Guardar Ubicación
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
