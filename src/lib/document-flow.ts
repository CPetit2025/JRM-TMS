export type DocumentPhase = 'salida' | 'liquidacion' | 'conformidad' | 'observados' | 'historial'

// A route is not a service: conformity filters must run on each individual stop.
export function documentPhaseMatches(
  phase: DocumentPhase,
  dispatch: { status: string; docs_reissue: boolean; is_pickup: boolean },
  delivery?: { conformity: string },
): boolean {
  if (phase === 'salida') return dispatch.status === 'PROGRAMADO'
  if (phase === 'historial') return true
  // Ruta con cierre operativo (último punto o 00:00) cuya guía aún no está validada: liquidación documentaria pendiente
  if (phase === 'liquidacion') return ['RETORNO_COMPLETADO', 'ENTREGADO'].includes(dispatch.status) && !dispatch.is_pickup
    && !['VALIDADA', 'NO_APLICA', 'HISTORICA'].includes(delivery?.conformity || '')
  if (phase === 'observados') return dispatch.docs_reissue || ['OBSERVADA', 'RECHAZADA'].includes(delivery?.conformity || '')
  return dispatch.status !== 'PROGRAMADO' && dispatch.status !== 'CANCELADO' && !dispatch.is_pickup
}
