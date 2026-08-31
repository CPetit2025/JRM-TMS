"use client"
import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'

interface Role {
  id: string
  name: string
}

interface PublicRegistrationModalProps {
  isOpen: boolean
  onClose: () => void
}

export function PublicRegistrationModal({ isOpen, onClose }: PublicRegistrationModalProps) {
  const supabase = createClient()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [roles, setRoles] = useState<Role[]>([])
  
  const [newUser, setNewUser] = useState({
    first_name: '',
    last_name: '',
    username: '',
    document_number: '',
    phone: '',
    role_id: '',
    password: ''
  })

  useEffect(() => {
    if (isOpen) {
      fetchRoles()
    }
  }, [isOpen])

  const fetchRoles = async () => {
    try {
      const { data, error } = await supabase.from('roles').select('id, name')
      if (error) throw error
      setRoles(data || [])
    } catch (error) {
      console.error('Error fetching roles:', error)
    }
  }

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)

    try {
      // Create user via API
      const res = await fetch('/api/users/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newUser)
      })

      const resData = await res.json()

      if (!res.ok) {
        throw new Error(resData.error || 'Error al registrarse')
      }

      toast.success('Registro exitoso. Tu cuenta está pendiente de aprobación por un administrador.')
      onClose()
      
      // Reset form
      setNewUser({
        first_name: '', last_name: '', username: '', document_number: '', phone: '', role_id: '', password: ''
      })
    } catch (error: any) {
      toast.error(error.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Registro de Nuevo Usuario">
      <div className="p-6">
        <p className="text-sm text-slate-500 mb-6">
          Completa tus datos. Una vez registrado, un Administrador deberá aprobar tu cuenta antes de que puedas ingresar al sistema.
        </p>

        <form onSubmit={handleRegister} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Nombres</label>
              <input required type="text" value={newUser.first_name} onChange={e => setNewUser({...newUser, first_name: e.target.value})} className="w-full px-3 py-2 border rounded-md" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Apellidos</label>
              <input required type="text" value={newUser.last_name} onChange={e => setNewUser({...newUser, last_name: e.target.value})} className="w-full px-3 py-2 border rounded-md" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">DNI / Documento</label>
              <input required type="text" value={newUser.document_number} onChange={e => setNewUser({...newUser, document_number: e.target.value})} className="w-full px-3 py-2 border rounded-md" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Teléfono</label>
              <input required type="text" value={newUser.phone} onChange={e => setNewUser({...newUser, phone: e.target.value})} className="w-full px-3 py-2 border rounded-md" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Rol Solicitado</label>
            <select required value={newUser.role_id} onChange={e => setNewUser({...newUser, role_id: e.target.value})} className="w-full px-3 py-2 border rounded-md bg-white">
              <option value="">Seleccione un rol...</option>
              {roles.map(role => (
                <option key={role.id} value={role.id}>{role.name}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4 pt-4 border-t">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Correo Corporativo</label>
              <input required type="email" value={newUser.username} onChange={e => setNewUser({...newUser, username: e.target.value})} placeholder="ejemplo@jrmsac.com.pe" className="w-full px-3 py-2 border rounded-md" />
              <p className="text-xs text-slate-500 mt-1">Debe terminar en @jrmsac.com.pe</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Contraseña</label>
              <input required type="password" value={newUser.password} onChange={e => setNewUser({...newUser, password: e.target.value})} className="w-full px-3 py-2 border rounded-md" minLength={6} />
            </div>
          </div>

          <div className="flex justify-end gap-3 mt-8">
            <button type="button" onClick={onClose} className="px-4 py-2 border rounded-md hover:bg-slate-50 transition-colors">Cancelar</button>
            <button type="submit" disabled={isSubmitting} className="px-4 py-2 bg-[#002855] text-white rounded-md flex items-center hover:bg-[#001d3d] transition-colors disabled:opacity-50">
              {isSubmitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Registrarse
            </button>
          </div>
        </form>
      </div>
    </Modal>
  )
}
