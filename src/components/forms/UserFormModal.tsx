"use client"
import { useState, useEffect } from 'react'
import { Loader2, User, Share2, Mail, Copy, CheckCircle2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'

export interface UserData {
  id?: string
  first_name: string
  last_name: string
  username: string
  document_number: string
  phone: string
  role_id: string
  password?: string
  is_active?: boolean
}

interface Role {
  id: string
  name: string
}

interface UserFormModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: (user: UserData) => void
  editingUser?: UserData | null
  roles: Role[]
}

export function UserFormModal({ isOpen, onClose, onSuccess, editingUser, roles }: UserFormModalProps) {
  const supabase = createClient()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [successView, setSuccessView] = useState(false)
  const [createdUser, setCreatedUser] = useState<UserData | null>(null)
  
  const initialUser = {
    first_name: '',
    last_name: '',
    username: '',
    document_number: '',
    phone: '',
    role_id: '',
    password: ''
  }
  
  const [newUser, setNewUser] = useState(initialUser)

  useEffect(() => {
    if (editingUser) {
      setNewUser({
        first_name: editingUser.first_name || '',
        last_name: editingUser.last_name || '',
        username: editingUser.username || '',
        document_number: editingUser.document_number || '',
        phone: editingUser.phone || '',
        role_id: editingUser.role_id || '',
        password: ''
      })
    } else {
      setNewUser(initialUser)
      setSuccessView(false)
      setCreatedUser(null)
    }
  }, [editingUser, isOpen])

  const handleSaveUser = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)

    try {
      // Validar duplicidad
      if (!editingUser?.id) {
        const { data: existingDni } = await supabase
          .from('profiles')
          .select('id')
          .eq('document_number', newUser.document_number)
          .single()

        if (existingDni) {
          toast.error('El número de documento ya está registrado.')
          setIsSubmitting(false)
          return
        }

        const { data: existingUser } = await supabase
          .from('profiles')
          .select('id')
          .eq('username', newUser.username)
          .single()

        if (existingUser) {
          toast.error('El nombre de usuario ya está registrado.')
          setIsSubmitting(false)
          return
        }
      }

      if (editingUser?.id) {
        const { data, error } = await supabase
          .from('profiles')
          .update({
            first_name: newUser.first_name,
            last_name: newUser.last_name,
            username: newUser.username,
            document_number: newUser.document_number,
            phone: newUser.phone,
            role_id: newUser.role_id,
            ...(newUser.password ? { mock_password: newUser.password } : {})
          })
          .eq('id', editingUser.id)
          .select()
          .single()

        if (error) throw error
        toast.success('Usuario actualizado correctamente')
        onSuccess(data)
        onClose()
      } else {
        // Crear usuario mediante la API para que se cree en auth.users
        const res = await fetch('/api/users/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(newUser)
        })

        const resData = await res.json()

        if (!res.ok) {
          throw new Error(resData.error || 'Error al crear usuario')
        }

        toast.success('Usuario creado correctamente')
        setCreatedUser({...newUser, id: resData.userId, password: newUser.password})
        setSuccessView(true)
      }
    } catch (error: any) {
      toast.error('Error al guardar usuario. Verifica las reglas de clave foránea con auth.users: ' + error.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleFinish = () => {
    if (createdUser) {
      onSuccess(createdUser)
    }
    onClose()
  }

  const shareText = createdUser ? `Hola ${createdUser.first_name}, tus credenciales de acceso al sistema JRM son:\nUsuario: ${createdUser.username}\nContraseña: ${createdUser.password}\n\nRecuerda que tienes un máximo de 24 horas para cambiar esta contraseña por seguridad.` : ''

  const handleWhatsApp = () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, '_blank')
  }

  const handleEmail = () => {
    window.open(`mailto:?subject=Tus Credenciales de Acceso JRM&body=${encodeURIComponent(shareText)}`, '_blank')
  }

  if (successView && createdUser) {
    return (
      <Modal isOpen={isOpen} onClose={handleFinish} title="Usuario Creado Exitosamente">
        <div className="flex flex-col items-center justify-center space-y-4 py-4">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center text-green-600 mb-2">
            <CheckCircle2 className="w-8 h-8" />
          </div>
          <p className="text-center text-slate-600">
            El usuario <strong>{createdUser.first_name} {createdUser.last_name}</strong> ha sido registrado.
          </p>
          <div className="bg-slate-50 p-4 rounded-lg border border-slate-200 w-full mb-4 space-y-2">
            <div className="flex justify-between items-center text-sm">
              <span className="text-slate-500">Usuario:</span>
              <span className="font-mono font-medium text-slate-800">{createdUser.username}</span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-slate-500">Contraseña temporal:</span>
              <span className="font-mono font-medium text-slate-800">{createdUser.password}</span>
            </div>
          </div>
          <p className="text-xs text-amber-600 font-medium mb-4 text-center">
            Nota: El usuario debe cambiar su contraseña en las próximas 24 horas. Comparte estas credenciales ahora.
          </p>
          <div className="flex flex-col w-full gap-2 mt-4">
            <button onClick={handleWhatsApp} className="flex items-center justify-center gap-2 w-full py-2 bg-[#25D366] text-white rounded-lg hover:bg-[#128C7E] transition-colors font-medium">
              <Share2 className="w-4 h-4" />
              Compartir por WhatsApp
            </button>
            <button onClick={handleEmail} className="flex items-center justify-center gap-2 w-full py-2 bg-slate-800 text-white rounded-lg hover:bg-slate-900 transition-colors font-medium">
              <Mail className="w-4 h-4" />
              Compartir por Correo
            </button>
            <button onClick={handleFinish} className="flex items-center justify-center gap-2 w-full py-2 bg-white border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors font-medium mt-2">
              Cerrar y Continuar
            </button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={editingUser ? "Editar Usuario" : "Crear Nuevo Usuario"}
    >
      <form onSubmit={handleSaveUser} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Nombres</label>
            <input 
              type="text" 
              required
              className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
              value={newUser.first_name}
              onChange={(e) => setNewUser({...newUser, first_name: e.target.value})}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Apellidos</label>
            <input 
              type="text" 
              required
              className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
              value={newUser.last_name}
              onChange={(e) => setNewUser({...newUser, last_name: e.target.value})}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Documento de Identidad (DNI/RUC)</label>
            <input 
              type="text" 
              required
              className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
              value={newUser.document_number}
              onChange={(e) => setNewUser({...newUser, document_number: e.target.value})}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Teléfono</label>
            <input 
              type="text" 
              required
              className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
              value={newUser.phone}
              onChange={(e) => setNewUser({...newUser, phone: e.target.value})}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
              <div className="relative">
                <label className="block text-sm font-medium text-slate-700 mb-1">Correo Corporativo</label>
                <input
                  type="email"
                  required
                  value={newUser.username}
                  onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                  placeholder="ejemplo@jrmsac.com.pe"
                  className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] focus:border-[#002855] outline-none transition-all text-slate-700"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Debe terminar en @jrmsac.com.pe
                </p>
              </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              {editingUser ? 'Nueva Contraseña (Opcional)' : 'Contraseña de Acceso'}
            </label>
            <input 
              type="password" 
              required={!editingUser}
              placeholder={editingUser ? "Dejar en blanco para no cambiar" : ""}
              className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
              value={newUser.password}
              onChange={(e) => setNewUser({...newUser, password: e.target.value})}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Rol</label>
            <select 
              required
              className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
              value={newUser.role_id}
              onChange={(e) => setNewUser({...newUser, role_id: e.target.value})}
            >
              <option value="">Selecciona un rol...</option>
              {roles.map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="pt-4 flex justify-end gap-3">
          <button 
            type="button" 
            onClick={onClose}
            className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg transition-colors"
          >
            Cancelar
          </button>
          <button 
            type="submit" 
            disabled={isSubmitting}
            className="px-4 py-2 bg-[#002855] text-white font-medium rounded-lg hover:bg-[#001d3d] transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <User className="w-4 h-4" />}
            {editingUser ? 'Guardar Cambios' : 'Crear Usuario'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
