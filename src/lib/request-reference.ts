/** Recojos y traslados se sustentan con una orden; la OT es opcional. */
export function requiresOrderReference(requestType: string) {
  return requestType === 'RECOJO' || requestType === 'TRASLADO'
}

export function orderReferenceComplete(type: string | null | undefined, number: string | null | undefined) {
  return ['OC', 'OS', 'RQ'].includes((type || '').trim().toUpperCase()) && Boolean(number?.trim()) && (number?.trim().length || 0) <= 100
}
