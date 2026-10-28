/** A missing authorized detail is not evidence that a scoped service is historical. */
export function forkliftScopeLabel(requestId: string | null | undefined, stop?: { number?: string | null; destination?: string | null; otCode?: string | null } | null): string {
 if (!requestId) return 'Servicio general de ruta (histórico)'
 const details = [stop?.number, stop?.otCode ? `OT ${stop.otCode}` : null, stop?.destination].filter(Boolean)
 return details.length ? details.join(' · ') : 'Punto de entrega no disponible'
}
