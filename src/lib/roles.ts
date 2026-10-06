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
