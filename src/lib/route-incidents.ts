// Catálogos de la fase 3c (mismos valores que los CHECK de route_incidents y route_stop_waits)
export const INCIDENT_CATEGORIES: Record<string, string> = {
  RETRASO: 'Retraso', ESPERA: 'Espera', DIRECCION_INCORRECTA: 'Dirección incorrecta', CONTACTO_NO_DISPONIBLE: 'Contacto no disponible',
  FALTA_DOCUMENTOS: 'Falta de documentos', CARGA_NO_PREPARADA: 'Carga no preparada', RECHAZO: 'Rechazo', DIFERENCIA_CANTIDAD: 'Diferencia de cantidad',
  DANO: 'Daño', AVERIA: 'Avería', ACCIDENTE: 'Accidente', RESTRICCION_ACCESO: 'Restricción de acceso', OTRO: 'Otro',
}
export const INCIDENT_CAUSES: Record<string, string> = {
  CLIENTE: 'Cliente', TRANSPORTE_JRM: 'Transporte JRM', ALMACEN_JRM: 'Almacén JRM', PROVEEDOR: 'Proveedor', EXTERNO: 'Externo (tráfico, clima, vía)', OTRO: 'Otro',
}
export const INCIDENT_STATUS: Record<string, string> = { ABIERTA: 'Abierta', EN_ATENCION: 'En atención', CERRADA: 'Cerrada' }
export const WAIT_REASONS: Record<string, string> = {
  COLA_INGRESO: 'Cola para ingresar', AUTORIZACION_INGRESO: 'Autorización de ingreso', CONTACTO_NO_DISPONIBLE: 'Contacto no disponible',
  CARGA_NO_PREPARADA: 'Carga no preparada', DOCUMENTOS: 'Documentos', REVISION_CARGA: 'Revisión de la carga', OTRO: 'Otro',
}

export type RouteIncident = {
  id: string; dispatch_id: string; request_id: string | null; category: string; description: string; occurred_at: string; recorded_at: string
  reported_cause: string | null; status: string; action_taken: string | null; responsible: string | null; confirmed_cause: string | null
  confirmed_at: string | null; closed_at: string | null; reporto: string | null; confirmo: string | null; es_mio: boolean
  dispatch_number: string | null; vehicle_plate: string | null; driver_name: string | null; request_number: string | null; puede_gestionar: boolean
}

export const limaTime = (d: string | null | undefined) => d ? new Date(d).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' }) : '—'
