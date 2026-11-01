// Etiqueta visible del estado del despacho. El estado técnico LIQUIDADO es el cierre de la ruta (close_dispatch_route):
// se muestra como "RUTA CERRADA" para no confundirlo con la liquidación de Caja ni con el cierre final del servicio
// (Torre de Control · Cierre del servicio, dispatch_final_close).
export function dispatchStatusLabel(status: string | null | undefined): string {
  if (!status) return 'Desconocido'
  if (status === 'CIERRE_OPERATIVO') return 'Cierre operativo · documentación y cierre financiero pendientes'
  if (status === 'LIQUIDADO' || status === 'CERRADO') return 'RUTA CERRADA'
  // Cierre operativo: unidad y conductor libres; falta la liquidación documentaria
  if (status === 'RETORNO_COMPLETADO') return 'UNIDAD LIBERADA'
  return status.replace(/_/g, ' ')
}

/** Grupos de estado compartidos por Despacho (contadores) y Torre de Control (filtro en el servidor:
 *  get_tower_dispatches acepta RUTA y POR_CERRAR con los mismos estados). */
export const DISPATCH_STATUS_GROUPS = {
  RUTA: ['EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO'],
  POR_CERRAR: ['ENTREGADO', 'RETORNO_COMPLETADO', 'CIERRE_OPERATIVO'],
} as const satisfies Record<string, readonly string[]>
export type DispatchStatusGroup = keyof typeof DISPATCH_STATUS_GROUPS
export const isDispatchStatusGroup = (value: string): value is DispatchStatusGroup => Object.hasOwn(DISPATCH_STATUS_GROUPS, value)
