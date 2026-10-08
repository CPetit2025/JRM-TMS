// Etiqueta visible del estado del despacho. El estado técnico LIQUIDADO es el cierre operativo de la ruta
// (close_dispatch_route): se muestra como "CERRADO" para no confundirlo con la liquidación de Caja.
export function dispatchStatusLabel(status: string | null | undefined): string {
  if (!status) return 'Desconocido'
  if (status === 'LIQUIDADO' || status === 'CERRADO') return 'CERRADO'
  return status.replace(/_/g, ' ')
}

/** Grupos de estado compartidos por Despacho (contadores) y Torre de Control (filtro). */
export const DISPATCH_STATUS_GROUPS = {
  RUTA: ['EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO'],
  POR_CERRAR: ['ENTREGADO', 'RETORNO_COMPLETADO'],
} as const satisfies Record<string, readonly string[]>
export type DispatchStatusGroup = keyof typeof DISPATCH_STATUS_GROUPS
export const isDispatchStatusGroup = (value: string): value is DispatchStatusGroup => value in DISPATCH_STATUS_GROUPS
