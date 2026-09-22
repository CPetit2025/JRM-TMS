export const SYSTEM_ADMIN_ROLE_NAME = 'Administrador'
export const CONTRACT_ADMIN_ROLE_NAME = 'Administrador de Contratos'

export function normalizeRoleName(name: string | null | undefined): string {
  const normalized = name?.trim().toLowerCase() || ''
  return normalized === 'administrador' ? 'admin' : normalized
}

export function isSystemAdminRole(name: string | null | undefined): boolean {
  return normalizeRoleName(name) === 'admin'
}

export function isContractAdminRole(name: string | null | undefined): boolean {
  return name?.trim() === CONTRACT_ADMIN_ROLE_NAME
}

export function isProtectedRole(name: string | null | undefined): boolean {
  return isSystemAdminRole(name) || isContractAdminRole(name)
}
