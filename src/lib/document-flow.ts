export type DocumentPhase = 'salida' | 'liquidacion' | 'conformidad' | 'observados' | 'historial'

const CLOSED_PENDING_SETTLEMENT = ['CIERRE_OPERATIVO', 'RETORNO_COMPLETADO', 'ENTREGADO']

// A route is not a service: conformity filters must run on each individual stop.
export function documentPhaseMatches(
  phase: DocumentPhase,
  dispatch: { status: string; docs_reissue: boolean; is_pickup: boolean },
  delivery?: { conformity: string },
  noteLinked = false,
  // Regla de la base por tipo de servicio (settlement_checklist); si llega, manda sobre la regla local
  settlementComplete?: boolean,
): boolean {
  if (phase === 'salida') return dispatch.status === 'PROGRAMADO'
  if (phase === 'historial') return true
  // Ruta con cierre operativo (00:00, último punto o llegada a base) y documentación incompleta: guía sin validar o,
  // en un recojo del cliente, sin Nota de Despacho. Sale de aquí al validarse o al liquidarse la ruta.
  if (phase === 'liquidacion') return CLOSED_PENDING_SETTLEMENT.includes(dispatch.status)
    && (settlementComplete !== undefined ? !settlementComplete : dispatch.is_pickup ? !noteLinked : !['VALIDADA', 'NO_APLICA', 'HISTORICA'].includes(delivery?.conformity || ''))
  if (phase === 'observados') return dispatch.docs_reissue || ['OBSERVADA', 'RECHAZADA'].includes(delivery?.conformity || '')
  return dispatch.status !== 'PROGRAMADO' && dispatch.status !== 'CANCELADO' && !dispatch.is_pickup
}
