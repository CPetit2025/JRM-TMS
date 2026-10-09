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
