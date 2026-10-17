// Áreas que solicitan transporte. Las usa el registro público (área del perfil), Usuarios y la Nueva solicitud
// (área solicitante, que se completa con el área del perfil).
export const REQUEST_AREAS = ['OT (Administración de Contratos)', 'Recursos Humanos', 'Logística', 'Gerencia', 'Producción', 'Almacén', 'Otros'] as const

export function isRequestArea(value: unknown): value is (typeof REQUEST_AREAS)[number] {
  return typeof value === 'string' && (REQUEST_AREAS as readonly string[]).includes(value)
}
