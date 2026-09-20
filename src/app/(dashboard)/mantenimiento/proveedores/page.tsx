'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Building2, Plus, Search, CheckCircle, XCircle, Clock, Save, X, Phone, MapPin } from 'lucide-react'
import { toast } from 'react-hot-toast'

export default function ProveedoresPage() {
  const [providers, setProviders] = useState<any[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  
  const supabase = createClient()

  const [form, setForm] = useState({
    ruc: '',
    business_name: '',
    address: '',
    contact_name: '',
    contact_phone: '',
    specialty: ''
  })

  useEffect(() => {
    checkAdmin()
    fetchProviders()
  }, [])

  const checkAdmin = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (user?.email === 'cpetit@jrmsac.com.pe') {
      setIsAdmin(true)
    }
  }

  const fetchProviders = async () => {
    try {
      const { data, error } = await supabase
        .from('maintenance_providers')
        .select('*')
        .order('created_at', { ascending: false })
      
      if (error) throw error
      setProviders(data || [])
    } catch (e: any) {
      toast.error('Error al cargar proveedores')
      console.error(e)
    } finally {
      setIsLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    try {
      const { error } = await supabase.from('maintenance_providers').insert([{
        ...form,
        status: isAdmin ? 'APROBADO' : 'PENDIENTE'
      }])
      
      if (error) throw error
      
      toast.success(isAdmin ? 'Proveedor registrado y aprobado' : 'Proveedor solicitado correctamente. Esperando aprobación.')
      setIsModalOpen(false)
      setForm({ ruc: '', business_name: '', address: '', contact_name: '', contact_phone: '', specialty: '' })
      fetchProviders()
    } catch (e: any) {
      toast.error('Error al registrar: ' + e.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleStatusUpdate = async (id: string, newStatus: string) => {
    if (!isAdmin) return
    try {
      const { error } = await supabase
        .from('maintenance_providers')
        .update({ status: newStatus })
        .eq('id', id)
      
      if (error) throw error
      toast.success(`Proveedor marcado como ${newStatus}`)
      fetchProviders()
    } catch (e: any) {
      toast.error('Error al actualizar estado')
    }
  }

  const filtered = providers.filter(p => 
    p.business_name?.toLowerCase().includes(searchTerm.toLowerCase()) || 
    p.ruc?.includes(searchTerm)
  )

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <Building2 className="w-8 h-8 text-blue-600" />
            Gestor de Proveedores de Mantenimiento
          </h1>
          <p className="text-slate-500">
            Administra los talleres y proveedores externos.
          </p>
        </div>
        
        <button 
          onClick={() => setIsModalOpen(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium shadow-lg shadow-blue-500/20"
        >
          <Plus className="w-5 h-5" />
          Proponer Proveedor
        </button>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        <div className="p-4 border-b border-slate-100 flex gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input 
              type="text"
              placeholder="Buscar por RUC o Razón Social..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none transition-all"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-500 font-medium">
              <tr>
                <th className="px-6 py-4">RUC</th>
                <th className="px-6 py-4">Razón Social</th>
                <th className="px-6 py-4">Especialidad</th>
                <th className="px-6 py-4">Contacto</th>
                <th className="px-6 py-4">Estado</th>
                {isAdmin && <th className="px-6 py-4 text-right">Acciones</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-slate-500">Cargando...</td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-slate-500">No se encontraron proveedores.</td>
                </tr>
              ) : (
                filtered.map(p => (
                  <tr key={p.id} className="hover:bg-slate-50/50 transition-colors group">
                    <td className="px-6 py-4 font-mono text-slate-600">{p.ruc}</td>
                    <td className="px-6 py-4 font-medium text-slate-900">{p.business_name}</td>
                    <td className="px-6 py-4 text-slate-600">{p.specialty || '-'}</td>
                    <td className="px-6 py-4">
                      <div className="text-slate-900">{p.contact_name || '-'}</div>
                      <div className="text-slate-500 text-xs flex items-center gap-1 mt-0.5">
                        <Phone className="w-3 h-3" />
                        {p.contact_phone || '-'}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${
                        p.status === 'APROBADO' ? 'bg-green-100 text-green-700' :
                        p.status === 'RECHAZADO' ? 'bg-red-100 text-red-700' :
                        'bg-amber-100 text-amber-700'
                      }`}>
                        {p.status === 'APROBADO' && <CheckCircle className="w-3.5 h-3.5" />}
                        {p.status === 'RECHAZADO' && <XCircle className="w-3.5 h-3.5" />}
                        {(!p.status || p.status === 'PENDIENTE') && <Clock className="w-3.5 h-3.5" />}
                        {p.status || 'PENDIENTE'}
                      </span>
                    </td>
                    {isAdmin && (
                      <td className="px-6 py-4 text-right">
                        {p.status !== 'APROBADO' && (
                          <button 
                            onClick={() => handleStatusUpdate(p.id, 'APROBADO')}
                            className="p-2 text-green-600 hover:bg-green-50 rounded-lg transition-colors mr-2"
                            title="Aprobar"
                          >
                            <CheckCircle className="w-4 h-4" />
                          </button>
                        )}
                        {p.status !== 'RECHAZADO' && (
                          <button 
                            onClick={() => handleStatusUpdate(p.id, 'RECHAZADO')}
                            className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                            title="Rechazar"
                          >
                            <XCircle className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between p-6 border-b border-slate-100">
              <div>
                <h3 className="text-xl font-bold text-slate-900">Proponer Proveedor</h3>
                <p className="text-sm text-slate-500 mt-1">
                  {isAdmin ? 'Registra un nuevo proveedor.' : 'La administración revisará y aprobará tu solicitud.'}
                </p>
              </div>
              <button 
                onClick={() => setIsModalOpen(false)}
                className="p-2 text-slate-400 hover:bg-slate-100 rounded-full transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">RUC *</label>
                  <input 
                    required
                    type="text"
                    maxLength={11}
                    value={form.ruc}
                    onChange={e => setForm({...form, ruc: e.target.value})}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">Razón Social *</label>
                  <input 
                    required
                    type="text"
                    value={form.business_name}
                    onChange={e => setForm({...form, business_name: e.target.value})}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">Especialidad</label>
                  <input 
                    type="text"
                    placeholder="Ej. Tornería, Llantas, Planchado..."
                    value={form.specialty}
                    onChange={e => setForm({...form, specialty: e.target.value})}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">Dirección</label>
                  <input 
                    type="text"
                    value={form.address}
                    onChange={e => setForm({...form, address: e.target.value})}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">Contacto (Nombre)</label>
                  <input 
                    type="text"
                    value={form.contact_name}
                    onChange={e => setForm({...form, contact_name: e.target.value})}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">Teléfono</label>
                  <input 
                    type="text"
                    value={form.contact_phone}
                    onChange={e => setForm({...form, contact_phone: e.target.value})}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
              </div>

              <div className="pt-4 flex justify-end gap-3">
                <button 
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 text-slate-600 hover:bg-slate-100 font-medium rounded-lg transition-colors"
                >
                  Cancelar
                </button>
                <button 
                  type="submit"
                  disabled={isSubmitting}
                  className="px-6 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  {isSubmitting ? 'Guardando...' : (isAdmin ? 'Guardar y Aprobar' : 'Enviar Solicitud')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
