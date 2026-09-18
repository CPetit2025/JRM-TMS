"use client"
import { useState, useEffect } from 'react'
import { Plus, User, Edit2, Trash2, Search, Filter, Loader2, UserCheck, UserX } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { UserFormModal, UserData } from '@/components/forms/UserFormModal'

interface Profile extends Omit<UserData, 'password'> {
  id: string
  roles?: {
    id: string
    name: string
    permissions?: string[]
  }
}

interface Role {
  id: string
  name: string
}

export default function UsuariosPage() {
  const supabase = createClient()
  const [users, setUsers] = useState<Profile[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [loading, setLoading] = useState(true)
  
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingUser, setEditingUser] = useState<UserData | null>(null)

    const [searchTerm, setSearchTerm] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filterStatus, setFilterStatus] = useState('TODOS')
  const filteredList = users.filter(item => {
    const matchesSearch = searchTerm === '' || (item.first_name + ' ' + item.last_name).toLowerCase().includes(searchTerm.toLowerCase()) || ((item as any).email || '').toLowerCase().includes(searchTerm.toLowerCase()) || (item.document_number || '').includes(searchTerm);
    let matchesStatus = true;
    if (filterStatus !== 'TODOS') {
      if ((item as any).status !== undefined) matchesStatus = (item as any).status === filterStatus;
      else if ((item as any).is_active !== undefined) matchesStatus = filterStatus === 'ACTIVO' ? (item as any).is_active === true : (item as any).is_active === false;
    }
    return matchesSearch && matchesStatus;
  });

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    setLoading(true)
    try {
      // Fetch users
      const { data: usersData, error: usersError } = await supabase
        .from('profiles')
        .select('*, roles(id, name, permissions)')
        .order('created_at', { ascending: false })

      if (usersError) throw usersError

      // Fetch roles for the dropdown
      const { data: rolesData, error: rolesError } = await supabase
        .from('roles')
        .select('id, name')

      if (rolesError) throw rolesError

      setUsers(usersData || [])
      setRoles(rolesData || [])
    } catch (error: any) {
      toast.error('Error al cargar datos: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  const handleEdit = (user: Profile) => {
    setEditingUser({
      id: user.id,
      first_name: user.first_name,
      last_name: user.last_name,
      username: user.username || '',
      document_number: user.document_number,
      phone: user.phone,
      role_id: user.roles?.id || '',
    })
    setIsModalOpen(true)
  }

  const openCreateModal = () => {
    setEditingUser(null)
    setIsModalOpen(true)
  }

  const toggleStatus = async (user: Profile) => {
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ is_active: !user.is_active })
        .eq('id', user.id)

      if (error) throw error
      
      toast.success(`Usuario ${!user.is_active ? 'activado' : 'desactivado'}`)
      fetchData()
    } catch (error: any) {
      toast.error('Error al actualizar estado.')
    }
  }

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Usuarios</h1>
          <p className="text-sm text-slate-500">Gestión de personal y accesos</p>
        </div>
        <button 
          onClick={openCreateModal}
          className="flex items-center gap-2 bg-[#002855] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#001d3d] transition-colors shadow-sm"
        >
          <Plus className="w-4 h-4" />
          Nuevo Usuario
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
              placeholder="Buscar por nombre, email o DNI..."
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

        <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
          <div className="relative w-72">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input 
              type="text" 
              placeholder="Buscar por nombre o DNI..." 
              className="w-full pl-9 pr-4 py-2 bg-white text-slate-900 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#002855]"
            />
          </div>
          <button className="flex items-center gap-2 px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100">
            <Filter className="w-4 h-4" />
            Filtrar
          </button>
        </div>

        <div className="overflow-auto max-h-[calc(100vh-220px)]">
          <table className="w-full text-left border-collapse relative">
            <thead className="sticky top-0 z-10 shadow-[0_1px_0_0_#e2e8f0]">
              <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider ">
                <th className="p-4 font-semibold">Usuario</th>
                <th className="p-4 font-semibold">Documento</th>
                <th className="p-4 font-semibold">Teléfono</th>
                <th className="p-4 font-semibold">Rol</th>
                <th className="p-4 font-semibold">Estado</th>
                <th className="p-4 font-semibold text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-slate-500">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                    Cargando usuarios...
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-slate-500">
                    No hay usuarios registrados.
                  </td>
                </tr>
              ) : (
                users.map(user => (
                  <tr key={user.id} className="hover:bg-slate-50 transition-colors">
                    <td className="p-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center text-slate-500">
                          <User className="w-4 h-4" />
                        </div>
                        <span className="font-semibold text-slate-800">{user.first_name} {user.last_name}</span>
                      </div>
                      {user.username && (
                        <div className="text-xs text-slate-500 mt-1 ml-11">{user.username}</div>
                      )}
                    </td>
                    <td className="p-4 text-sm text-slate-600">{user.document_number}</td>
                    <td className="p-4 text-sm text-slate-600">{user.phone}</td>
                    <td className="p-4">
                      <div className="flex flex-col gap-1">
                        <span className="text-sm font-medium text-slate-700 bg-slate-100 px-2 py-1 rounded w-max">
                          {user.roles?.name || 'Sin rol'}
                        </span>
                        {user.roles?.permissions && user.roles.permissions.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {user.roles.permissions.map(p => (
                              <span key={p} className="bg-blue-50 text-blue-700 border border-blue-100 px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold">
                                {p}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="p-4">
                      <span className={`px-2 py-1 text-xs font-semibold rounded-md ${
                        user.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                      }`}>
                        {user.is_active ? 'Activo' : 'Inactivo'}
                      </span>
                    </td>
                    <td className="p-4 text-right">
                      <div className="flex justify-end gap-2">
                        <button 
                          onClick={() => handleEdit(user)}
                          title="Editar"
                          className="p-2 text-slate-400 hover:text-[#002855] transition-colors rounded hover:bg-blue-50"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={() => toggleStatus(user)}
                          title={user.is_active ? 'Desactivar' : 'Activar'}
                          className={`p-2 transition-colors rounded ${user.is_active ? 'text-slate-400 hover:text-red-600 hover:bg-red-50' : 'text-slate-400 hover:text-green-600 hover:bg-green-50'}`}
                        >
                          {user.is_active ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
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

      <UserFormModal 
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSuccess={() => fetchData()}
        editingUser={editingUser}
        roles={roles}
      />
    </div>
  )
}
