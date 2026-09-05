"use client"

import { useState, useEffect } from 'react'
import { Plus, Users, Edit2, ShieldAlert, Loader2 } from 'lucide-react'
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
    employee_type: 'Montacarguista'
  })

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
            employee_type: formData.employee_type
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
    setFormData({ id: '', first_name: '', last_name: '', document_number: '', employee_type: 'Montacarguista' })
    setIsModalOpen(true)
  }

  const openEdit = (t: any) => {
    setFormData({
      id: t.id,
      first_name: t.first_name || '',
      last_name: t.last_name || '',
      document_number: t.document_number || '',
      employee_type: t.employee_type || 'Montacarguista'
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
                <th className="p-4 font-semibold text-center">Estado</th>
                <th className="p-4 font-semibold text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {trabajadores.map((t) => (
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
