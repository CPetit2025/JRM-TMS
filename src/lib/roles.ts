export function normalizeRoleName(name: string | null | undefined): string {
  const normalized = name?.trim().toLowerCase() || ''
  return normalized === 'administrador' ? 'admin' : normalized
}

export function isSystemAdminRole(name: string | null | undefined): boolean {
  return normalizeRoleName(name) === 'admin'
}

export function isDispatchAuditorRole(name: string | null | undefined): boolean {
  return normalizeRoleName(name) === 'auditor de despacho'
}

export function dispatchAuditorPathAllowed(path: string): boolean {
  return ['/despacho/planificacion', '/despacho/documentos', '/perfil'].includes(path)
}

// Rutas que un rol no ve aunque algún permiso las habilite (p. ej. /reportes se abre con APT o Torre de Control).
const ROLE_DENIED_PATHS: Record<string, string[]> = {
  'administrador de contratos': ['/reportes'],
}
export function roleDeniesPath(roleName: string | null | undefined, path: string): boolean {
  return (ROLE_DENIED_PATHS[normalizeRoleName(roleName)] || []).some(p => path === p || path.startsWith(p + '/'))
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
