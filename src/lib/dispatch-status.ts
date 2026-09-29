// Etiqueta visible del estado del despacho. El estado técnico LIQUIDADO es el cierre operativo de la ruta
// (close_dispatch_route): se muestra como "CERRADO" para no confundirlo con la liquidación de Caja.
export function dispatchStatusLabel(status: string | null | undefined): string {
  if (!status) return 'Desconocido'
  if (status === 'LIQUIDADO' || status === 'CERRADO') return 'CERRADO'
  return status.replace(/_/g, ' ')
}
