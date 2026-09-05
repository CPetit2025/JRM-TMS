"use client"
import { useState, useEffect } from 'react'
import { Plus, Shield, Trash2, Edit2, Search, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'

interface Role {
  id: string
  name: string
  description: string
  permissions?: string[]
}

const MODULE_GROUPS = [
  {
    title: 'Analítica y General',
    modules: [{ id: 'dashboard', label: 'Analítica / KPIs' }]
  },
  {
    title: 'Comercial y Despacho',
    modules: [
      { id: 'clientes', label: 'Clientes' },
      { id: 'ot', label: 'Órdenes de Trabajo (Comercial)' },
      { id: 'solicitudes', label: 'Solicitudes de Transporte' },
      { id: 'despacho', label: 'Despacho (Programación)' },
      { id: 'monitoreo', label: 'Monitoreo GPS' },
      { id: 'operaciones-live', label: 'Tareo en Vivo' },
      { id: 'operaciones-revision', label: 'Revisión de Tareos' },
      { id: 'operaciones-kpis', label: 'Dashboard Analítico' },
      { id: 'servicios-realizados', label: 'Servicios Realizados' },
      { id: 'reportes', label: 'Reporte Desp. y Recojo' }
    ]
  },
  {
    title: 'Mantenimiento de Flota',
    modules: [
      { id: 'mantenimiento-dashboard', label: 'Dashboard' },
      { id: 'mantenimiento-flota', label: 'Unidades y Documentos' },
      { id: 'mantenimiento-vencimientos', label: 'Proyección y Vencimientos' },
      { id: 'mantenimiento-fallas', label: 'Solicitudes y Fallas' },
      { id: 'mantenimiento-ot', label: 'Órdenes de Trabajo' },
      { id: 'mantenimiento-planes', label: 'Planes Preventivos' }
    ]
  },
  {
    title: 'Maestros',
    modules: [
      { id: 'flota', label: 'Unidades y Conductores' },
      { id: 'tarifas', label: 'Tarifas por KM' },
      { id: 'productos', label: 'Productos' }
    ]
  },
  {
    title: 'Administración',
    modules: [
      { id: 'usuarios', label: 'Usuarios' },
      { id: 'permisos', label: 'Roles y Permisos' },
      { id: 'configuracion', label: 'Configuración General' }
    ]
  }
]

export default function PermisosPage() {
  const supabase = createClient()
  const [roles, setRoles] = useState<Role[]>([])
  const [loading, setLoading] = useState(true)
  
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [newRole, setNewRole] = useState<{name: string, description: string, permissions: string[]}>({ 
    name: '', 
    description: '',
    permissions: []
  })
  const [editingId, setEditingId] = useState<string | null>(null)

  useEffect(() => {
    fetchRoles()
  }, [])

  const fetchRoles = async () => {
    try {
      const { data, error } = await supabase
        .from('roles')
        .select('*')
        .order('created_at', { ascending: true })

      if (error) throw error
      setRoles(data || [])
    } catch (error: any) {
      toast.error('Error al cargar roles: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSaveRole = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)

    try {
      if (editingId) {
        const { error } = await supabase
          .from('roles')
          .update({ 
            name: newRole.name, 
            description: newRole.description,
            permissions: newRole.permissions
          })
          .eq('id', editingId)
          
        if (error) throw error
        toast.success('Rol actualizado correctamente')
      } else {
        const { error } = await supabase
          .from('roles')
          .insert([{ 
            name: newRole.name, 
            description: newRole.description,
            permissions: newRole.permissions
          }])
          
        if (error) throw error
        toast.success('Rol creado correctamente')
      }

      setIsModalOpen(false)
      setNewRole({ name: '', description: '', permissions: [] })
      setEditingId(null)
      fetchRoles()
    } catch (error: any) {
      toast.error('Error al guardar rol: ' + error.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleEdit = (role: Role) => {
    setEditingId(role.id)
    setNewRole({
      name: role.name,
      description: role.description,
      permissions: role.permissions || []
    })
    setIsModalOpen(true)
  }

  const openCreateModal = () => {
    setEditingId(null)
    setNewRole({ name: '', description: '', permissions: [] })
    setIsModalOpen(true)
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`¿Estás seguro de eliminar el rol "${name}"?`)) return

    try {
      const { error } = await supabase
        .from('roles')
        .delete()
        .eq('id', id)

      if (error) throw error
      
      toast.success('Rol eliminado')
      fetchRoles()
    } catch (error: any) {
      toast.error('No se puede eliminar este rol porque tiene usuarios asignados o ha ocurrido un error.')
    }
  }

  const setModulePermission = (moduleId: string, level: 'none' | 'read' | 'write') => {
    setNewRole(prev => {
      // Filtrar permisos anteriores de este módulo
      const perms = prev.permissions.filter(id => !id.startsWith(moduleId + ':') && id !== moduleId)
      if (level === 'none') {
        return { ...prev, permissions: perms }
      } else {
        return { ...prev, permissions: [...perms, `${moduleId}:${level}`] }
      }
    })
  }

  const getModuleLevel = (moduleId: string, permissions: string[]) => {
    if (permissions.includes(`${moduleId}:write`) || permissions.includes(moduleId)) return 'write'
    if (permissions.includes(`${moduleId}:read`)) return 'read'
    return 'none'
  }

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Roles y Permisos</h1>
          <p className="text-sm text-slate-500">Administra los niveles de acceso a la Torre de Control</p>
        </div>
        <button 
          onClick={openCreateModal}
          className="flex items-center gap-2 bg-[#002855] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#001d3d] transition-colors shadow-sm"
        >
          <Plus className="w-4 h-4" />
          Nuevo Rol
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
          <div className="relative w-64">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input 
              type="text" 
              placeholder="Buscar rol..." 
              className="w-full pl-9 pr-4 py-2 bg-white text-slate-900 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#002855]"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider border-b">
                <th className="p-4 font-semibold">Rol</th>
                <th className="p-4 font-semibold">Descripción</th>
                <th className="p-4 font-semibold hidden md:table-cell">Permisos (Módulos)</th>
                <th className="p-4 font-semibold text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={4} className="p-8 text-center text-slate-500">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                    Cargando roles...
                  </td>
                </tr>
              ) : roles.length === 0 ? (
                <tr>
                  <td colSpan={4} className="p-8 text-center text-slate-500">
                    No hay roles registrados.
                  </td>
                </tr>
              ) : (
                roles.map(role => (
                  <tr key={role.id} className="hover:bg-slate-50 transition-colors">
                    <td className="p-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded bg-blue-100 text-[#002855] flex items-center justify-center">
                          <Shield className="w-4 h-4" />
                        </div>
                        <span className="font-semibold text-slate-800">{role.name}</span>
                      </div>
                    </td>
                    <td className="p-4 text-sm text-slate-600 max-w-xs truncate" title={role.description}>{role.description}</td>
                    <td className="p-4 text-sm text-slate-600 hidden md:table-cell">
                      {role.permissions && role.permissions.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {role.permissions.map(p => {
                            const isRead = p.endsWith(':read')
                            const label = p.replace(':read', '').replace(':write', '')
                            // Buscar el label amigable en MODULE_GROUPS
                            let friendlyLabel = label
                            MODULE_GROUPS.forEach(g => {
                              const found = g.modules.find(m => m.id === label)
                              if (found) friendlyLabel = found.label
                            })

                            return (
                              <span 
                                key={p} 
                                className={`px-2 py-0.5 rounded text-xs border ${
                                  isRead 
                                    ? 'bg-amber-50 text-amber-700 border-amber-200' 
                                    : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                }`}
                              >
                                {friendlyLabel} {isRead ? '(Solo Lectura)' : ''}
                              </span>
                            )
                          })}
                        </div>
                      ) : (
                        <span className="text-slate-400 italic">Todos / Ninguno (Legado)</span>
                      )}
                    </td>
                    <td className="p-4 text-right">
                      <div className="flex justify-end gap-2">
                        <button 
                          onClick={() => handleEdit(role)}
                          className="p-2 text-slate-400 hover:text-[#002855] transition-colors rounded hover:bg-blue-50"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={() => handleDelete(role.id, role.name)}
                          className="p-2 text-slate-400 hover:text-red-600 transition-colors rounded hover:bg-red-50"
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

      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingId ? "Editar Rol" : "Crear Nuevo Rol"}
        maxWidth="max-w-4xl"
      >
        <form onSubmit={handleSaveRole} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Nombre del Rol</label>
              <input 
                type="text" 
                required
                placeholder="Ej: Supervisor"
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                value={newRole.name}
                onChange={(e) => setNewRole({...newRole, name: e.target.value})}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Descripción</label>
              <input 
                type="text"
                required
                placeholder="Ej: Actividades de Despacho"
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                value={newRole.description}
                onChange={(e) => setNewRole({...newRole, description: e.target.value})}
              />
            </div>
          </div>
          
          <div className="border-t border-slate-200 pt-6">
            <div className="flex justify-between items-center mb-4">
              <label className="block text-sm font-bold text-slate-800">Permisos de Acceso a Módulos</label>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {MODULE_GROUPS.map((group, gIndex) => (
                <div key={gIndex} className="bg-slate-50 p-4 rounded-xl border border-slate-200">
                  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 pb-2 border-b border-slate-200">
                    {group.title}
                  </h4>
                  <div className="space-y-3">
                    {group.modules.map(module => {
                      const level = getModuleLevel(module.id, newRole.permissions)
                      return (
                        <div key={module.id} className="flex flex-col gap-1 p-2 rounded-lg hover:bg-white hover:shadow-sm transition-all border border-transparent hover:border-slate-200">
                          <span className="text-sm font-semibold text-slate-700 leading-tight">{module.label}</span>
                          <select 
                            className="w-full text-xs p-1.5 mt-1 border border-slate-300 rounded focus:ring-[#002855] focus:outline-none bg-slate-50"
                            value={level}
                            onChange={(e) => setModulePermission(module.id, e.target.value as 'none' | 'read' | 'write')}
                          >
                            <option value="none">⛔ Sin Acceso</option>
                            <option value="read">👁️ Solo Lectura</option>
                            <option value="write">✏️ Lectura y Escritura</option>
                          </select>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="pt-4 flex justify-end gap-3 border-t border-slate-200 mt-4">
            <button 
              type="button" 
              onClick={() => setIsModalOpen(false)}
              className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg transition-colors"
            >
              Cancelar
            </button>
            <button 
              type="submit" 
              disabled={isSubmitting || newRole.permissions.length === 0}
              className="px-4 py-2 bg-[#002855] text-white font-medium rounded-lg hover:bg-[#001d3d] transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
              Guardar Rol
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
