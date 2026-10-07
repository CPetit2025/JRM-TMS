export type DispatchExecutionAction = {
  label: string
  rpc: 'transition_dispatch_status' | 'close_dispatch_route'
  nextStatus?: 'EN_CURSO' | 'RETORNO'
  reason?: string
}

export function dispatchExecutionAction(status: string, modalidad?: string | null): DispatchExecutionAction | null {
  if (status === 'PROGRAMADO' && modalidad !== 'TERCERO') return {
    label: modalidad === 'RECOJO_CLIENTE' ? 'Preparar retiro' : 'Preparar salida', rpc: 'transition_dispatch_status', nextStatus: 'EN_CURSO',
    reason: 'Salida preparada desde Torre de Control',
  }
  if (status === 'ESPERANDO_AUTORIZACION') return {
    label: 'Autorizar retorno', rpc: 'transition_dispatch_status', nextStatus: 'RETORNO',
    reason: 'Retorno autorizado desde Torre de Control',
  }
  if (status === 'ENTREGADO' || status === 'RETORNO_COMPLETADO') return { label: 'Cerrar ruta', rpc: 'close_dispatch_route' }
  return null
}

export function dispatchClosureMessage(result: { actual_distance_km?: unknown; gps_complete?: unknown }, modalidad?: string | null): string {
  if (modalidad === 'RECOJO_CLIENTE') return 'Retiro por cliente cerrado. No corresponde seguimiento GPS de transporte JRM.'
  const km = Number(result.actual_distance_km)
  if (!Number.isFinite(km) || km <= 0) return modalidad === 'TERCERO' ? 'Servicio cerrado · sin recorrido GPS registrado.' : 'Ruta cerrada · sin medición GPS; kilometraje pendiente de conciliación.'
  return `Ruta cerrada · ${km.toFixed(3)} km GPS${result.gps_complete === true ? '' : ' · cobertura parcial; kilometraje pendiente de conciliación'}`
}
