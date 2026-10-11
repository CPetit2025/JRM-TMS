import { isSystemAdminRole, roleDeniesPath } from '@/lib/roles'
import { NAV_SECTIONS, activeEntry, flatEntries, visibleSections, type Has } from '@/lib/nav/navConfig'

const permissionList = (permissions: unknown): string[] =>
  Array.isArray(permissions) ? permissions.filter((p): p is string => typeof p === 'string') : []
// Permiso con o sin nivel: dashboard, dashboard:read, despacho:write
const hasModule = (list: string[]): Has => module => list.some(p => p === module || p.startsWith(`${module}:`))

// Acceso a la plataforma web: administrador o un rol con al menos una opción visible del menú, con la misma regla
// del menú lateral. Así nadie entra a la web sin un módulo al que llegar; los permisos que no abren ninguna opción
// (JRM IA, aprobaciones sueltas) no cuentan.
export function hasWebAccess(roleName: string | null | undefined, permissions: unknown): boolean {
  if (isSystemAdminRole(roleName)) return true
  const list = permissionList(permissions)
  if (!list.length) return false
  return visibleSections(hasModule(list), href => roleDeniesPath(roleName, href)).length > 0
}

// Páginas de cualquier usuario de la web: Inicio, su perfil, «Mi avance» (dentro de /reportes) y la evidencia, que
// la base de datos autoriza por documento. Las direcciones antiguas se revisan como la página a la que redirigen.
const OPEN_PATHS = ['/', '/perfil', '/reportes', '/desempeno', '/evidencia']
const PATH_ALIASES: Record<string, string> = { '/despacho/planificacion': '/despacho/documentos', '/caja/fondos': '/caja/cajas' }
const MENU_ENTRIES = flatEntries(NAV_SECTIONS)

// Una página abre solo si su opción del menú es visible para el rol: la dirección escrita a mano respeta el mismo
// permiso que el menú (la de mayor coincidencia: /contratos/servicios usa su propia regla, /contratos/123 la de
// Contratos). Una dirección que no pertenece a ningún módulo sigue su curso (Next responde 404).
export function canOpenPath(roleName: string | null | undefined, permissions: unknown, pathname: string): boolean {
  if (isSystemAdminRole(roleName)) return true
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  const path = PATH_ALIASES[clean] ?? clean
  if (OPEN_PATHS.some(p => path === p || (p !== '/' && path.startsWith(p + '/')))) return true
  const entry = activeEntry(MENU_ENTRIES, path)
  return !entry || entry.item.show(hasModule(permissionList(permissions)))
}

// Nombre de la página para el aviso de acceso denegado («Caja de Transporte · Panel de Caja»)
export function pathLabel(pathname: string): string | null {
  const entry = activeEntry(MENU_ENTRIES, PATH_ALIASES[pathname] ?? pathname)
  return entry ? entry.item.label : null
}
