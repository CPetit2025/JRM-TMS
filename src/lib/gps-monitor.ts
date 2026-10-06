export type DriverMonitorRow = {
  id: string; driver_id: string | null; profile_id: string | null; driver: string
  dispatch_id: string | null; dispatch_number: string | null; plate: string | null
  route_status: string | null; operational_status: string; connected: boolean
  last_seen_at: string | null; gps_state: string; lat: number | null; lng: number | null
  gps_at: string | null; gps_fresh: boolean; accuracy_m: number | null; speed: number | null
}
export const monitorStates: Record<string, { label: string; color: string }> = {
  SIN_RUTA: { label: 'Sin ruta', color: 'blue' },
  ESPERANDO_DOCUMENTOS: { label: 'Con ruta · esperando Packing List', color: 'amber' },
  RUTA_ASIGNADA: { label: 'Con ruta · listo para salir', color: 'blue' },
  EN_RUTA: { label: 'En ruta', color: 'green' },
  ESPERANDO_GUIA: { label: 'En destino · esperando guía', color: 'amber' },
  GUIA_EN_VALIDACION: { label: 'Guía en validación', color: 'amber' },
  GUIA_OBSERVADA: { label: 'Guía observada / rechazada', color: 'red' },
  ESPERANDO_RETORNO: { label: 'Esperando autorización de retorno', color: 'amber' },
  RETORNO: { label: 'En retorno', color: 'green' },
  EN_BASE: { label: 'En base · pendiente de cierre', color: 'blue' },
  ENTREGADO: { label: 'Entregado · pendiente de cierre', color: 'blue' },
}
export const stateFor = (row: DriverMonitorRow) => monitorStates[row.operational_status] || { label: row.route_status || 'Sin ruta', color: 'blue' }
export const gpsTime = (value: string | null) => value ? new Date(value).toLocaleString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Sin señal registrada'
export function monitorMarker(row: DriverMonitorRow) {
  if (row.lat === null || row.lng === null || !Number.isFinite(Number(row.lat)) || !Number.isFinite(Number(row.lng)) ||
    Number(row.lat) < -90 || Number(row.lat) > 90 || Number(row.lng) < -180 || Number(row.lng) > 180) return null
  const state = stateFor(row)
  const status: 'sin_senal' | 'incidencia' | 'en_ruta' | 'esperando' | 'ubicacion' = !row.gps_fresh ? 'sin_senal' :
    state.color === 'red' ? 'incidencia' : state.color === 'green' ? 'en_ruta' : state.color === 'amber' ? 'esperando' : 'ubicacion'
  return { id: row.id, plate: row.plate || 'Sin unidad asignada', driver: row.driver, status,
    lat: Number(row.lat), lng: Number(row.lng), speed: row.gps_fresh && row.speed !== null ? Math.round(Number(row.speed)) : null,
    lastUpdate: gpsTime(row.gps_at), operationalLabel: state.label,
    connectionLabel: row.driver_id ? (row.connected ? 'App conectada' : 'App sin conexión reciente') : 'Sin conexión de app registrada',
    gpsFresh: !!row.gps_fresh, accuracy: row.accuracy_m }
}
