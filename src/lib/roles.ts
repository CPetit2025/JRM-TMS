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

// Acceso a la plataforma web: administrador o cualquier módulo web en el rol, con nivel o sin él
// (dashboard, dashboard:read, despacho:write, …). Los permisos de JRM IA no abren la web por sí solos.
export function hasWebAccess(roleName: string | null | undefined, permissions: unknown): boolean {
  if (isSystemAdminRole(roleName)) return true
  return Array.isArray(permissions) && permissions.some(p => typeof p === 'string' && p.trim() !== '' && !p.startsWith('ia:'))
}
