export function normalizeRoleName(name: string | null | undefined): string {
  const normalized = name?.trim().toLowerCase() || ''
  return normalized === 'administrador' ? 'admin' : normalized
}

export function isSystemAdminRole(name: string | null | undefined): boolean {
  return normalizeRoleName(name) === 'admin'
}

const hasFlag = (permissions: unknown, flag: string) => Array.isArray(permissions) && permissions.includes(flag)

// «Solo documentos de despacho»: el Auditor de Despacho (rol base) o cualquier rol con el permiso especial.
export function isDispatchAuditorRole(name: string | null | undefined, permissions?: unknown): boolean {
  return normalizeRoleName(name) === 'auditor de despacho' || hasFlag(permissions, 'solo-documentos')
}

export function dispatchAuditorPathAllowed(path: string): boolean {
  return ['/despacho/planificacion', '/despacho/documentos', '/perfil'].includes(path)
}

// Rutas que un rol no ve aunque algún permiso las habilite (p. ej. /reportes se abre con APT o Torre de Control).
// «Solo su cartera de OT» (Administrador de Contratos o el permiso especial cartera-propia) no abre /reportes.
const PORTFOLIO_DENIED_PATHS = ['/reportes']
export function roleDeniesPath(roleName: string | null | undefined, path: string, permissions?: unknown): boolean {
  const portfolio = normalizeRoleName(roleName) === 'administrador de contratos' || hasFlag(permissions, 'cartera-propia')
  return portfolio && PORTFOLIO_DENIED_PATHS.some(p => path === p || path.startsWith(p + '/'))
}

// Roles base: el sistema tiene reglas que dependen de su nombre, por eso no se renombran ni se eliminan
// (lo impide también la base de datos). Sus permisos sí se editan.
export const BASE_ROLES = [
  'Administrador', 'Administrador de Contratos', 'Supervisor de Despacho', 'Jefe de Distribución', 'Asistente Documentario',
  'Auditor de Despacho', 'Supervisor de Transporte', 'Soporte Mecánico', 'Conductor',
]
export function isBaseRole(name: string | null | undefined): boolean {
  const n = normalizeRoleName(name)
  return BASE_ROLES.some(r => normalizeRoleName(r) === n)
}
