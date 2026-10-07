export type DocumentPhase = 'salida' | 'conformidad' | 'observados' | 'historial'

// A route is not a service: conformity filters must run on each individual stop.
export function documentPhaseMatches(
  phase: DocumentPhase,
  dispatch: { status: string; docs_reissue: boolean; is_pickup: boolean },
  delivery?: { conformity: string },
): boolean {
  if (phase === 'salida') return dispatch.status === 'PROGRAMADO'
  if (phase === 'historial') return true
  if (phase === 'observados') return dispatch.docs_reissue || ['OBSERVADA', 'RECHAZADA'].includes(delivery?.conformity || '')
  return dispatch.status !== 'PROGRAMADO' && dispatch.status !== 'CANCELADO' && !dispatch.is_pickup
}
