import { isSystemAdminRole, roleDeniesPath } from '@/lib/roles'
import { visibleSections } from '@/lib/nav/navConfig'

// Acceso a la plataforma web: administrador o un rol con al menos una opción visible del menú, con la misma regla
// del menú lateral (permiso con o sin nivel: dashboard, dashboard:read, despacho:write). Así nadie entra a la web
// sin un módulo al que llegar; los permisos que no abren ninguna opción (JRM IA, aprobaciones sueltas) no cuentan.
export function hasWebAccess(roleName: string | null | undefined, permissions: unknown): boolean {
  if (isSystemAdminRole(roleName)) return true
  if (!Array.isArray(permissions)) return false
  const list = permissions.filter((p): p is string => typeof p === 'string')
  return visibleSections(module => list.some(p => p === module || p.startsWith(`${module}:`)), href => roleDeniesPath(roleName, href)).length > 0
}
