'use client'
import { Fragment, useMemo, useState } from 'react'
import { Lock } from 'lucide-react'
import { PERMISSION_GROUPS, moduleLevel } from '@/lib/permissions/catalog'
import { isBaseRole, isSystemAdminRole } from '@/lib/roles'

// Vista matriz: todos los roles en columnas y los módulos del catálogo en filas, agrupados como el menú.
// E = escritura, L = lectura, SÍ = interruptor activo, — = sin acceso. Clic en el nombre del rol abre su editor.
type MatrixRole = { id: string; name: string; permissions?: string[] | null }
type Props = { roles: MatrixRole[]; onEdit?: (id: string) => void }

export function RoleMatrix({ roles, onEdit }: Props) {
  const [query, setQuery] = useState('')
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    return PERMISSION_GROUPS.map(g => ({ ...g, modules: g.modules.filter(m => !q || `${g.title} ${m.label} ${m.id}`.toLowerCase().includes(q)) }))
      .filter(g => g.modules.length)
  }, [query])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex flex-col gap-1 text-xs text-slate-500">Buscar módulo
          <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Ej. Despacho, Caja, APT"
            className="min-h-10 w-64 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-[#002855]" />
        </label>
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
          <span className="inline-flex items-center gap-1.5"><Cell kind="write" />Escritura</span>
          <span className="inline-flex items-center gap-1.5"><Cell kind="read" />Lectura</span>
          <span className="inline-flex items-center gap-1.5"><Cell kind="on" />Interruptor</span>
          <span className="inline-flex items-center gap-1.5"><Cell kind="none" />Sin acceso</span>
        </div>
      </div>
      <div className="max-h-[calc(100vh-260px)] overflow-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[900px] border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50">
            <tr>
              <th className="sticky left-0 z-20 min-w-64 border-b border-slate-200 bg-slate-50 px-4 py-3 text-left text-xs font-semibold text-slate-500">Módulo</th>
              {roles.map(r => (
                <th key={r.id} className="border-b border-slate-200 px-2 py-2 align-bottom">
                  <button type="button" onClick={() => onEdit?.(r.id)} disabled={!onEdit}
                    className="mx-auto flex max-w-28 flex-col items-center gap-0.5 text-xs font-bold leading-tight text-slate-800 hover:text-[#002855] disabled:hover:text-slate-800">
                    <span className="text-center">{r.name}</span>
                    {isBaseRole(r.name) && <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500"><Lock className="h-2.5 w-2.5" />Base</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(g => (
              <Fragment key={g.title}>
                <tr>
                  <td colSpan={roles.length + 1} className="sticky left-0 border-t border-slate-200 bg-slate-50 px-4 pb-1.5 pt-3 text-[11px] font-bold uppercase tracking-wider text-[#002855]">{g.title}</td>
                </tr>
                {g.modules.map(m => (
                  <tr key={m.id} className="border-t border-slate-100 hover:bg-slate-50/60">
                    <td className="sticky left-0 bg-white px-4 py-2">
                      <span className="block font-medium text-slate-800">{m.label}</span>
                      <span className="block font-mono text-[11px] text-slate-500">{m.id}</span>
                    </td>
                    {roles.map(r => {
                      const perms = Array.isArray(r.permissions) ? r.permissions : []
                      const kind = isSystemAdminRole(r.name) ? (m.mode === 'toggle' ? 'on' : 'write')
                        : m.mode === 'toggle' ? (perms.includes(m.id) ? 'on' : 'none')
                        : moduleLevel(perms, m.id)
                      return <td key={r.id} className="px-2 py-2 text-center"><Cell kind={kind} /></td>
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">El Administrador tiene acceso total. Para cambiar un permiso, haga clic en el nombre del rol.</p>
    </div>
  )
}

function Cell({ kind }: { kind: 'write' | 'read' | 'on' | 'none' }) {
  if (kind === 'write') return <span aria-label="Escritura" className="inline-grid h-7 w-8 place-items-center rounded-md bg-[#002855] text-xs font-bold text-white">E</span>
  if (kind === 'read') return <span aria-label="Lectura" className="inline-grid h-7 w-8 place-items-center rounded-md border border-blue-200 bg-blue-50 text-xs font-bold text-blue-800">L</span>
  if (kind === 'on') return <span aria-label="Activado" className="inline-grid h-6 w-9 place-items-center rounded-full border border-amber-300 bg-amber-50 text-[10px] font-bold text-amber-800">SÍ</span>
  return <span aria-label="Sin acceso" className="inline-grid h-7 w-8 place-items-center text-sm text-slate-400">—</span>
}
