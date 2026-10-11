"use client"
import { PageHeader } from '@/components/ui/page-header'
import { DataTable } from '@/components/ui/data-table'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Plus, Shield, Trash2, Edit2, Search, Loader2, Copy, History, Lock } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { usePermissions } from '@/hooks/usePermissions'
import {
  OBSOLETE_PERMISSIONS, PERMISSION_GROUPS, describePermission, menuItemsFor, moduleLevel, setModuleLevel, setToggle,
  type PermissionLevel,
} from '@/lib/permissions/catalog'
import { visibleSections } from '@/lib/nav/navConfig'
import { isBaseRole, isSystemAdminRole, roleDeniesPath } from '@/lib/roles'

interface Role {
  id: string
  name: string
  description: string | null
  permissions?: string[] | null
}
type Change = {
  id: number; role_name: string | null; action: 'ALTA' | 'CAMBIO' | 'BAJA'; old_name: string | null
  old_permissions: string[] | null; new_permissions: string[] | null; changed_by: string | null; changed_at: string
}

const LEVELS: { value: PermissionLevel; label: string }[] = [
  { value: 'none', label: 'Ninguno' }, { value: 'read', label: 'Lectura' }, { value: 'write', label: 'Escritura' },
]
const CHIP: Record<string, string> = {
  write: 'bg-[#002855] text-white border-[#002855]',
  read: 'bg-blue-50 text-blue-800 border-blue-200',
  toggle: 'bg-amber-50 text-amber-800 border-amber-200',
  obsolete: 'bg-slate-100 text-slate-500 border-slate-200 line-through',
}
const CHIP_SUFFIX: Record<string, string> = { write: '', read: ' · lectura', toggle: '', obsolete: ' · sin efecto' }

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Error inesperado'
}
const asList = (value: unknown): string[] => Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : []

// Diferencias entre dos listas de permisos, en palabras («Monitoreo GPS: Ninguno → Lectura»)
function diffPermissions(before: string[], after: string[]): string[] {
  const out: string[] = []
  for (const group of PERMISSION_GROUPS) for (const m of group.modules) {
    if (m.mode === 'toggle') {
      const a = before.includes(m.id), b = after.includes(m.id)
      if (a !== b) out.push(`${m.label}: ${b ? 'activado' : 'desactivado'}`)
    } else {
      const a = moduleLevel(before, m.id), b = moduleLevel(after, m.id)
      if (a !== b) out.push(`${m.label}: ${LEVELS.find(l => l.value === a)?.label} → ${LEVELS.find(l => l.value === b)?.label}`)
    }
  }
  return out
}

export default function PermisosPage() {
  const [supabase] = useState(() => createClient())
  const { canWrite } = usePermissions()
  const writable = canWrite('permisos')
  const [roles, setRoles] = useState<Role[]>([])
  const [loading, setLoading] = useState(true)

  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [newRole, setNewRole] = useState<{ name: string; description: string; permissions: string[] }>({ name: '', description: '', permissions: [] })
  const [original, setOriginal] = useState<string[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingBase, setEditingBase] = useState(false)
  const [history, setHistory] = useState<{ title: string; items: Change[] } | null>(null)
  const [names, setNames] = useState<Record<string, string>>({})

  const [searchTerm, setSearchTerm] = useState('')
  const filteredList = roles.filter(item => {
    const query = searchTerm.trim().toLowerCase()
    return !query || item.name.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query)
  })

  const fetchRoles = useCallback(async () => {
    try {
      const { data, error } = await supabase.from('roles').select('*').order('created_at', { ascending: true })
      if (error) throw error
      setRoles(data || [])
    } catch (error: unknown) {
      toast.error('Error al cargar roles: ' + getErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [supabase])

  useEffect(() => {
    // This client-only screen loads the external role store after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchRoles()
  }, [fetchRoles])

  // Menú que verá el rol con los permisos marcados (la misma regla del menú lateral y del acceso por página)
  const preview = useMemo(() => {
    if (isSystemAdminRole(newRole.name)) return null
    const has = (module: string) => newRole.permissions.some(p => p === module || p.startsWith(`${module}:`))
    return visibleSections(has, href => roleDeniesPath(newRole.name, href))
  }, [newRole.name, newRole.permissions])
  const pending = useMemo(() => editingId ? diffPermissions(original, newRole.permissions) : [], [editingId, original, newRole.permissions])

  const handleSaveRole = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    try {
      if (editingId) {
        const { error } = await supabase.from('roles')
          .update({ ...(editingBase ? {} : { name: newRole.name }), description: newRole.description, permissions: newRole.permissions })
          .eq('id', editingId)
        if (error) throw error
        toast.success('Rol actualizado correctamente')
      } else {
        const { error } = await supabase.from('roles').insert([{ name: newRole.name, description: newRole.description, permissions: newRole.permissions }])
        if (error) throw error
        toast.success('Rol creado correctamente')
      }
      setIsModalOpen(false)
      setEditingId(null)
      await fetchRoles()
    } catch (error: unknown) {
      toast.error('Error al guardar rol: ' + getErrorMessage(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  const openEditor = (role: Role | null, duplicate = false) => {
    const permissions = asList(role?.permissions)
    setEditingId(role && !duplicate ? role.id : null)
    setEditingBase(Boolean(role && !duplicate && isBaseRole(role.name)))
    setOriginal(permissions)
    setNewRole({
      name: role ? (duplicate ? `${role.name} (copia)` : role.name) : '',
      description: role?.description || '',
      permissions,
    })
    setIsModalOpen(true)
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`¿Estás seguro de eliminar el rol "${name}"?`)) return
    try {
      const { error } = await supabase.from('roles').delete().eq('id', id)
      if (error) throw error
      toast.success('Rol eliminado')
      await fetchRoles()
    } catch {
      toast.error('No se puede eliminar este rol porque tiene usuarios asignados o ha ocurrido un error.')
    }
  }

  const openHistory = async (role: Role | null) => {
    let query = supabase.from('role_permission_changes').select('*').order('changed_at', { ascending: false }).limit(100)
    if (role) query = query.eq('role_id', role.id)
    const { data, error } = await query
    if (error) { toast.error('No se pudo cargar el historial: ' + error.message); return }
    const items = (data || []) as Change[]
    const ids = [...new Set(items.map(i => i.changed_by).filter((v): v is string => Boolean(v)))]
    if (ids.length) {
      const { data: people } = await supabase.from('profiles').select('id, first_name, last_name, username').in('id', ids)
      setNames(Object.fromEntries((people || []).map((p: { id: string; first_name?: string | null; last_name?: string | null; username?: string | null }) =>
        [p.id, [p.first_name, p.last_name].filter(Boolean).join(' ') || p.username || 'Usuario'])))
    }
    setHistory({ title: role ? `Historial · ${role.name}` : 'Historial de cambios de roles', items })
  }

  return (
    <div className="space-y-3 max-w-7xl mx-auto">
      <PageHeader showTitle title="Roles y Permisos" description="Un solo catálogo decide el menú, el acceso a cada página y lo que permite la base de datos." actions={<>
        <button onClick={() => void openHistory(null)} className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50">
          <History className="w-4 h-4" />Historial
        </button>
        {writable && <button onClick={() => openEditor(null)} className="flex items-center gap-2 bg-[#002855] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#001d3d] transition-colors shadow-sm">
          <Plus className="w-4 h-4" />Nuevo Rol
        </button>}
      </>} />

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
        <div className="flex flex-col md:flex-row gap-4 justify-between items-center">
          <div className="relative w-full md:w-96">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-slate-400" />
            </div>
            <input type="text" placeholder="Buscar por nombre o descripción..." aria-label="Buscar rol"
              className="block w-full pl-10 pr-3 py-2 border border-slate-300 rounded-lg bg-slate-50 focus:bg-white focus:ring-2 focus:ring-[#002855] focus:border-transparent transition-colors sm:text-sm"
              value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <span className={`rounded border px-2 py-0.5 ${CHIP.write}`}>Escritura</span>
            <span className={`rounded border px-2 py-0.5 ${CHIP.read}`}>Lectura</span>
            <span className={`rounded border px-2 py-0.5 ${CHIP.toggle}`}>Interruptor</span>
            <span className={`rounded border px-2 py-0.5 ${CHIP.obsolete}`}>Sin efecto</span>
          </div>
        </div>
      </div>
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="overflow-auto max-h-[calc(100vh-220px)]">
          <DataTable className="w-full text-left border-collapse relative">
            <thead className="sticky top-0 z-10 shadow-[0_1px_0_0_#e2e8f0]">
              <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider ">
                <th className="p-4 font-semibold">Rol</th>
                <th className="p-4 font-semibold">Descripción</th>
                <th className="p-4 font-semibold hidden md:table-cell">Permisos</th>
                <th className="p-4 font-semibold text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={4} className="p-8 text-center text-slate-500"><Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />Cargando roles...</td></tr>
              ) : filteredList.length === 0 ? (
                <tr><td colSpan={4} className="p-8 text-center text-slate-500">{roles.length === 0 ? 'No hay roles registrados.' : 'No hay roles que coincidan con la búsqueda.'}</td></tr>
              ) : filteredList.map(role => {
                const base = isBaseRole(role.name)
                const perms = asList(role.permissions)
                return (
                  <tr key={role.id} className="hover:bg-slate-50 transition-colors">
                    <td className="p-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded bg-blue-100 text-[#002855] flex items-center justify-center"><Shield className="w-4 h-4" /></div>
                        <div>
                          <span className="font-semibold text-slate-800">{role.name}</span>
                          {base && <span className="mt-0.5 flex items-center gap-1 text-[11px] font-semibold text-slate-500"><Lock className="h-3 w-3" />Rol base</span>}
                        </div>
                      </div>
                    </td>
                    <td className="p-4 text-sm text-slate-600 max-w-xs truncate" title={role.description || undefined}>{role.description}</td>
                    <td className="p-4 text-sm text-slate-600 hidden md:table-cell">
                      {isSystemAdminRole(role.name) ? <span className="text-xs font-semibold text-[#002855]">Acceso total</span>
                        : perms.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {perms.map(p => {
                              const d = describePermission(p)
                              return <span key={p} title={p} className={`px-2 py-0.5 rounded text-xs border ${CHIP[d.level]}`}>{d.label}{CHIP_SUFFIX[d.level]}</span>
                            })}
                          </div>
                        ) : <span className="text-slate-400 italic">Sin permisos de módulos</span>}
                    </td>
                    <td className="p-4 text-right">
                      <div className="flex justify-end gap-1">
                        <button onClick={() => void openHistory(role)} title="Historial del rol" aria-label={`Historial de ${role.name}`} className="p-2 text-slate-400 hover:text-[#002855] transition-colors rounded hover:bg-blue-50"><History className="w-4 h-4" /></button>
                        {writable && <>
                          <button onClick={() => openEditor(role, true)} title="Duplicar como plantilla" aria-label={`Duplicar ${role.name}`} className="p-2 text-slate-400 hover:text-[#002855] transition-colors rounded hover:bg-blue-50"><Copy className="w-4 h-4" /></button>
                          <button onClick={() => openEditor(role)} title="Editar rol" aria-label={`Editar ${role.name}`} className="p-2 text-slate-400 hover:text-[#002855] transition-colors rounded hover:bg-blue-50"><Edit2 className="w-4 h-4" /></button>
                          {!base && <button onClick={() => handleDelete(role.id, role.name)} title="Eliminar rol" aria-label={`Eliminar ${role.name}`} className="p-2 text-slate-400 hover:text-red-600 transition-colors rounded hover:bg-red-50"><Trash2 className="w-4 h-4" /></button>}
                        </>}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </DataTable>
        </div>
      </div>

      {isModalOpen && <Modal isOpen onClose={() => setIsModalOpen(false)} title={editingId ? 'Editar Rol' : 'Crear Nuevo Rol'} maxWidth="max-w-6xl">
        <form onSubmit={handleSaveRole} className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="role-name" className="block text-sm font-medium text-slate-700 mb-1">Nombre del Rol</label>
              <input id="role-name" type="text" required placeholder="Ej: Supervisor" disabled={editingBase}
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none disabled:bg-slate-100"
                value={newRole.name} onChange={(e) => setNewRole({ ...newRole, name: e.target.value })} />
              {editingBase && <p className="mt-1 flex items-center gap-1 text-xs text-slate-500"><Lock className="h-3 w-3" />Rol base: sus permisos se editan, el nombre no.</p>}
            </div>
            <div>
              <label htmlFor="role-description" className="block text-sm font-medium text-slate-700 mb-1">Descripción</label>
              <input id="role-description" type="text" required placeholder="Ej: Actividades de Despacho"
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                value={newRole.description} onChange={(e) => setNewRole({ ...newRole, description: e.target.value })} />
            </div>
          </div>

          <div className="flex flex-wrap gap-5 border-t border-slate-200 pt-5">
            <div className="min-w-0 flex-[999_1_560px] space-y-4">
              {PERMISSION_GROUPS.map(group => (
                <section key={group.title} className="rounded-xl border border-slate-200 overflow-hidden">
                  <div className="bg-slate-50 px-4 py-2.5 border-b border-slate-200">
                    <h4 className="text-xs font-bold text-[#002855] uppercase tracking-wider">{group.title}</h4>
                    {group.hint && <p className="mt-0.5 text-xs text-slate-500">{group.hint}</p>}
                  </div>
                  <div className="divide-y divide-slate-100">
                    {group.modules.map(module => {
                      const opens = menuItemsFor(module.id)
                      const detail = module.hint || (opens.length ? `Abre: ${opens.join(', ')}` : 'Sin pantalla propia')
                      if (module.mode === 'toggle') {
                        const enabled = newRole.permissions.includes(module.id)
                        return (
                          <label key={module.id} className="flex cursor-pointer items-center justify-between gap-3 px-4 py-2.5">
                            <span className="min-w-0">
                              <span className="block text-sm font-semibold text-slate-700">{module.label}</span>
                              <span className="block truncate text-xs text-slate-500" title={detail}>{detail}</span>
                            </span>
                            <input type="checkbox" checked={enabled} className="h-5 w-5 shrink-0 accent-[#002855]"
                              onChange={e => setNewRole(prev => ({ ...prev, permissions: setToggle(prev.permissions, module.id, e.target.checked) }))} />
                          </label>
                        )
                      }
                      const level = moduleLevel(newRole.permissions, module.id)
                      return (
                        <div key={module.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold text-slate-700">{module.label}</span>
                            <span className="block truncate text-xs text-slate-500" title={detail}>{detail}</span>
                          </span>
                          <div role="radiogroup" aria-label={module.label} className="inline-flex shrink-0 overflow-hidden rounded-lg border border-slate-300">
                            {LEVELS.map(l => (
                              <button key={l.value} type="button" role="radio" aria-checked={level === l.value}
                                onClick={() => setNewRole(prev => ({ ...prev, permissions: setModuleLevel(prev.permissions, module.id, l.value) }))}
                                className={`min-h-9 px-3 text-xs font-semibold ${level === l.value ? 'bg-[#002855] text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                                {l.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </section>
              ))}
              {newRole.permissions.some(p => OBSOLETE_PERMISSIONS.includes(p) || describePermission(p).level === 'obsolete') && (
                <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
                  Este rol tiene permisos antiguos sin efecto ({newRole.permissions.filter(p => describePermission(p).level === 'obsolete').join(', ')}).{' '}
                  <button type="button" className="font-semibold text-[#002855] underline"
                    onClick={() => setNewRole(prev => ({ ...prev, permissions: prev.permissions.filter(p => describePermission(p).level !== 'obsolete') }))}>Quitarlos</button>
                </p>
              )}
            </div>

            <aside className="flex-[1_1_300px] min-w-[260px] space-y-4 self-start lg:sticky lg:top-0">
              <section className="rounded-xl bg-[#0F1B33] p-4 text-slate-100">
                <h4 className="text-sm font-bold text-white">Así verá el menú</h4>
                <p className="mt-1 text-xs text-slate-300">Las páginas que no aparecen aquí tampoco abren escribiendo la dirección.</p>
                <div className="mt-3 space-y-3">
                  {preview === null ? <p className="text-sm">Administrador: acceso total.</p>
                    : preview.length === 0 ? <p className="text-sm text-amber-200">Sin ninguna opción del menú: este rol no podrá entrar a la web.</p>
                    : preview.map(s => (
                      <div key={s.id}>
                        <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{s.title}</p>
                        <ul className="mt-1 space-y-1">
                          {s.groups.flatMap(g => g.items).map(i => <li key={i.href} className="rounded-md bg-white/10 px-2.5 py-1.5 text-xs">{i.label}</li>)}
                        </ul>
                      </div>
                    ))}
                </div>
              </section>
              {editingId && <section className="rounded-xl border border-slate-200 p-4">
                <h4 className="text-sm font-bold text-[#002855]">Cambios sin guardar</h4>
                {pending.length === 0 ? <p className="mt-1 text-xs text-slate-500">Sin cambios de permisos.</p>
                  : <ul className="mt-2 space-y-1 text-xs text-slate-700">{pending.map(c => <li key={c}>{c}</li>)}</ul>}
                <p className="mt-2 text-[11px] text-slate-500">Al guardar queda en el historial: quién, cuándo y qué cambió.</p>
              </section>}
            </aside>
          </div>

          <div className="pt-4 flex justify-end gap-3 border-t border-slate-200 mt-4">
            <button type="button" onClick={() => setIsModalOpen(false)} className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg transition-colors">Cancelar</button>
            <button type="submit" disabled={isSubmitting} className="px-4 py-2 bg-[#002855] text-white font-medium rounded-lg hover:bg-[#001d3d] transition-colors disabled:opacity-50 flex items-center gap-2">
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}Guardar Rol
            </button>
          </div>
        </form>
      </Modal>}

      {history && <Modal isOpen onClose={() => setHistory(null)} title={history.title} maxWidth="max-w-3xl">
        {history.items.length === 0 ? <p className="text-sm text-slate-500">Sin cambios registrados todavía.</p> : (
          <ol className="max-h-[60vh] space-y-3 overflow-auto">
            {history.items.map(h => {
              const changes = h.action === 'CAMBIO' ? diffPermissions(asList(h.old_permissions), asList(h.new_permissions)) : []
              return (
                <li key={h.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-slate-800">{h.role_name}{h.old_name ? ` (antes «${h.old_name}»)` : ''} · {h.action === 'ALTA' ? 'Creado' : h.action === 'BAJA' ? 'Eliminado' : 'Modificado'}</span>
                    <span className="text-xs text-slate-500">{new Date(h.changed_at).toLocaleString('es-PE', { timeZone: 'America/Lima' })} · {h.changed_by ? names[h.changed_by] || 'Usuario' : 'Sistema'}</span>
                  </div>
                  {changes.length > 0 && <ul className="mt-2 space-y-0.5 text-xs text-slate-600">{changes.map(c => <li key={c}>{c}</li>)}</ul>}
                  {h.action === 'CAMBIO' && changes.length === 0 && <p className="mt-1 text-xs text-slate-500">Mismo acceso (cambio de nombre o de formato).</p>}
                </li>
              )
            })}
          </ol>
        )}
      </Modal>}
    </div>
  )
}
