"use client"

import { useState, useEffect } from 'react'
import { Plus, Users, Edit2, ShieldAlert, Loader2 , Filter, Search} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'

const PUESTOS = [
  'Conductor',
  'Auxiliar de Transporte',
  'Auxiliar de Despacho',
  'Lider de Recepcion - APT',
  'Montacarguista',
  'Operador de Grua Estacional'
]

export default function TrabajadoresPage() {
  const supabase = createClient()
  const [trabajadores, setTrabajadores] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [isModalOpen, setIsModalOpen] = useState(false)
  
  // Form State
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [formData, setFormData] = useState({
    id: '',
    first_name: '',
    last_name: '',
    document_number: '',
    employee_type: 'Montacarguista',
    license_type: '',
    license_expiration: ''
  })

    const [searchTerm, setSearchTerm] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filterStatus, setFilterStatus] = useState('TODOS')
  const filteredList = trabajadores.filter(item => {
    const matchesSearch = searchTerm === '' || (item.first_name + ' ' + item.last_name).toLowerCase().includes(searchTerm.toLowerCase()) || (item.document_number || '').includes(searchTerm);
    let matchesStatus = true;
    if (filterStatus !== 'TODOS') {
      if (item.status !== undefined) matchesStatus = item.status === filterStatus;
      else if (item.is_active !== undefined) matchesStatus = filterStatus === 'ACTIVO' ? item.is_active === true : item.is_active === false;
    }
    return matchesSearch && matchesStatus;
  });

  useEffect(() => {
    fetchTrabajadores()
  }, [])

  const fetchTrabajadores = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .in('employee_type', PUESTOS)
        .order('last_name')

      if (error) throw error
      setTrabajadores(data || [])
    } catch (error) {
      toast.error('Error al cargar trabajadores')
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    
    try {
      if (formData.id) {
        // Update
        const { error } = await supabase
          .from('profiles')
          .update({
            first_name: formData.first_name,
            last_name: formData.last_name,
            document_number: formData.document_number,
            employee_type: formData.employee_type,
            license_type: formData.employee_type === 'Conductor' ? formData.license_type : null,
            license_expiration: formData.employee_type === 'Conductor' && formData.license_expiration ? formData.license_expiration : null
          })
          .eq('id', formData.id)
          
        if (error) throw error
        toast.success('Trabajador actualizado')
      } else {
        // Create (Generate UUID and insert directly into profiles, bypassing Auth)
        const newId = crypto.randomUUID()
        const { error } = await supabase
          .from('profiles')
          .insert({
            id: newId,
            first_name: formData.first_name,
            last_name: formData.last_name,
            document_number: formData.document_number,
            employee_type: formData.employee_type,
            license_type: formData.employee_type === 'Conductor' ? formData.license_type : null,
            license_expiration: formData.employee_type === 'Conductor' && formData.license_expiration ? formData.license_expiration : null,
            is_active: true
          })
          
        if (error) throw error
        toast.success('Trabajador registrado exitosamente')
      }
      
      setIsModalOpen(false)
      fetchTrabajadores()
    } catch (error: any) {
      toast.error(error.message || 'Error al guardar')
    } finally {
      setIsSubmitting(false)
    }
  }

  const openNew = () => {
    setFormData({ id: '', first_name: '', last_name: '', document_number: '', employee_type: 'Montacarguista', license_type: '', license_expiration: '' })
    setIsModalOpen(true)
  }

  const openEdit = (t: any) => {
    setFormData({
      id: t.id,
      first_name: t.first_name || '',
      last_name: t.last_name || '',
      document_number: t.document_number || '',
      employee_type: t.employee_type || 'Montacarguista',
      license_type: t.license_type || '',
      license_expiration: t.license_expiration || ''
    })
    setIsModalOpen(true)
  }

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <Users className="w-6 h-6 text-indigo-600" />
            Maestro de Trabajadores Operativos
          </h1>
          <p className="text-slate-500 mt-1">
            Personal sin acceso al sistema para asignación de Tareo Automático y Rutas.
          </p>
        </div>
        <button 
          onClick={openNew}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2"
        >
          <Plus className="w-5 h-5" />
          Registrar Trabajador
        </button>
      </div>

            {/* Filtros y Búsqueda */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
        <div className="flex flex-col md:flex-row gap-4 justify-between items-center">
          <div className="relative w-full md:w-96">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-slate-400" />
            </div>
            <input
              type="text"
              placeholder="Buscar por nombre o DNI..."
              className="block w-full pl-10 pr-3 py-2 border border-slate-300 rounded-lg bg-slate-50 focus:bg-white focus:ring-2 focus:ring-[#002855] focus:border-transparent transition-colors sm:text-sm"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors border ${showFilters ? 'bg-slate-100 border-slate-300 text-slate-800' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}
          >
            <Filter className="w-4 h-4" />
            Filtros Avanzados
          </button>
        </div>
        {showFilters && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4 pt-4 border-t border-slate-100">
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Estado</label>
              <select
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
              >
                <option value="TODOS">Todos</option>
                <option value="ACTIVO">Activo</option>
                <option value="INACTIVO">Inactivo</option>
              </select>
            </div>
          </div>
        )}
      </div>
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">

        {loading ? (
          <div className="p-12 flex justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
          </div>
        ) : trabajadores.length === 0 ? (
          <div className="p-12 text-center text-slate-500">
            No hay trabajadores operativos registrados.
          </div>
        ) : (
          <table className="w-full text-sm text-left">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider border-b">
              <tr>
                <th className="p-4 font-semibold">Apellidos y Nombres</th>
                <th className="p-4 font-semibold">DNI</th>
                <th className="p-4 font-semibold">Puesto</th>
                <th className="p-4 font-semibold">Licencia</th>
                <th className="p-4 font-semibold text-center">Estado</th>
                <th className="p-4 font-semibold text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredList.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50">
                  <td className="px-6 py-4 font-medium text-slate-800">
                    {t.last_name}, {t.first_name}
                  </td>
                  <td className="px-6 py-4 font-mono text-slate-600">
                    {t.document_number || '-'}
                  </td>
                  <td className="px-6 py-4">
                    <span className="px-2.5 py-1 rounded-md text-xs font-bold bg-indigo-50 text-indigo-700">
                      {t.employee_type}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    {t.employee_type === 'Conductor' && t.license_type ? (
                      <div>
                        <div className="font-semibold text-slate-800">{t.license_type}</div>
                        <div className="text-xs text-slate-500">Vence: {new Date(t.license_expiration).toLocaleDateString()}</div>
                      </div>
                    ) : (
                      <span className="text-slate-400">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-center">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${t.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                      {t.is_active ? 'Activo' : 'Inactivo'}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <button 
                      onClick={() => openEdit(t)}
                      className="p-2 text-slate-400 hover:text-[#002855] transition-colors rounded hover:bg-blue-50"
                      title="Editar"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={formData.id ? 'Editar Trabajador' : 'Nuevo Trabajador'}>
        <form onSubmit={handleSubmit} className="space-y-4">
          
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex gap-3 text-amber-800 text-sm">
            <ShieldAlert className="w-5 h-5 shrink-0" />
            <p>
              Estos perfiles <strong>no tienen contraseña ni acceso al sistema</strong>. Solo se usan para asignarles Costos de Horas Hombre en el Tareo Automático y Rutas.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Nombres</label>
              <input
                required
                type="text"
                value={formData.first_name}
                onChange={e => setFormData({...formData, first_name: e.target.value})}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Apellidos</label>
              <input
                required
                type="text"
                value={formData.last_name}
                onChange={e => setFormData({...formData, last_name: e.target.value})}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">DNI</label>
              <input
                type="text"
                value={formData.document_number}
                onChange={e => setFormData({...formData, document_number: e.target.value})}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Puesto de Trabajo</label>
              <select
                required
                value={formData.employee_type}
                onChange={e => setFormData({...formData, employee_type: e.target.value})}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {PUESTOS.map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
          </div>

          {formData.employee_type === 'Conductor' && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Tipo de Licencia</label>
                <select
                  required
                  value={formData.license_type}
                  onChange={e => setFormData({...formData, license_type: e.target.value})}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">Seleccione...</option>
                  <option value="A1">A-I</option>
                  <option value="A2A">A-IIA</option>
                  <option value="A2B">A-IIB</option>
                  <option value="A3A">A-IIIA</option>
                  <option value="A3B">A-IIIB</option>
                  <option value="A3C">A-IIIC</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Vencimiento Licencia</label>
                <input
                  required
                  type="date"
                  value={formData.license_expiration}
                  onChange={e => setFormData({...formData, license_expiration: e.target.value})}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            </div>
          )}

          <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setIsModalOpen(false)}
              className="px-4 py-2 text-slate-600 hover:bg-slate-50 font-medium rounded-lg"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2 rounded-lg font-medium flex items-center gap-2"
            >
              {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Guardar Trabajador
            </button>
          </div>
        </form>
      </Modal>

    </div>
  )
}
