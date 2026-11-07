export const OUTSOURCING_STAGES = ['Solicitud generada', 'Enviada a Compras', 'En cotización', 'Pendiente de aprobación', 'Servicio adjudicado', 'Proveedor confirmado', 'Servicio ejecutado', 'Cerrado'] as const
export const OUTSOURCING_SERVICES = { FLETE: 'Transporte', MONTACARGAS: 'Montacargas', GRUA: 'Grúa', STOCKA: 'Stocka / transpaleta', ESTIBA: 'Estiba y desestiba', OTROS: 'Otros recursos' } as const
export type OutsourcingService = keyof typeof OUTSOURCING_SERVICES
export type ServiceRequirement = { kind: OutsourcingService; requirements: string; details?: Record<string,string> }
export type Specification = { [key: string]: unknown; services: ServiceRequirement[] }
export type Outsourcing = { id: string; number: number; request_id: string; dispatch_id: string | null; stage: number; version: number; review_status?: 'ACTIVE' | 'OBSERVED' | 'CANCELLED'; revision?: number; specification: Specification; updated_at: string }
export type OutsourcingQuote = { id: string; service: OutsourcingService; supplier_id: string; amount_pen: number; terms: string; evidence: string; selected: boolean; spec_revision?: number }
export const SPEC_FIELDS = [
 ['Información general', [
  ['required_at', 'Fecha y hora requeridas (Lima)', 'datetime-local'], ['pickup', 'Lugar de recojo'], ['delivery', 'Lugar de entrega'],
  ['intermediate_points', 'Puntos intermedios (o No aplica)'], ['responsible', 'Responsable de la solicitud'],
 ]],
 ['Requerimientos de transporte', [
  ['unit_type', 'Tipo de unidad (camión, plataforma, tráiler, furgón…)'], ['length_m', 'Largo útil mínimo (m)', 'number'],
  ['width_m', 'Ancho útil mínimo (m)', 'number'], ['height_m', 'Alto útil mínimo (m)', 'number'], ['capacity_t', 'Capacidad mínima (t)', 'number'],
  ['volume_m3', 'Volumen requerido (m³)', 'number'], ['cargo_weight_kg', 'Peso total de mercadería (kg)', 'number'], ['cargo_quantity', 'Cantidad de bultos', 'number'],
  ['cargo', 'Mercadería y dimensiones de los bultos'], ['packaging', 'Tipo de embalaje'], ['special_conditions', 'Permisos, restricciones, sujeción y protección (o No aplica)'],
 ]],
 ['Condiciones operativas', [
  ['loading_window', 'Ventana horaria de carga'], ['unloading_window', 'Ventana horaria de descarga'], ['entry_requirements', 'Requisitos de ingreso a planta u obra'],
  ['documents', 'Documentos del proveedor, unidad, conductor y operadores'], ['safety', 'Equipos de seguridad'], ['access', 'Condiciones de acceso'],
  ['duration_hours', 'Tiempo estimado de operación (horas)', 'number'], ['notes', 'Observaciones e instrucciones especiales', 'optional'],
 ]],
] as const
export const SERVICE_HINTS: Partial<Record<OutsourcingService, string>> = {
 MONTACARGAS: 'Capacidad (t), altura de elevación (m) y horas de uso.', GRUA: 'Capacidad (t), alcance (m) y condiciones de maniobra.',
 STOCKA: 'Capacidad y características requeridas.', ESTIBA: 'Cantidad de operarios, horario y actividades.', OTROS: 'Equipo o recurso, cantidad y condiciones de uso.',
}
export const nextPermission = (stage: number) => [ 'despacho', 'compras-tercerizaciones', 'compras-tercerizaciones', 'compras-aprobar', 'compras-tercerizaciones', 'despacho', 'cierre-economico' ][stage]

export const SERVICE_FIELDS: Partial<Record<OutsourcingService, [string,string,string][]>> = {
 MONTACARGAS: [['capacity','Capacidad (t)','number'],['height','Altura de elevación (m)','number'],['hours','Tiempo de uso (horas)','number']],
 GRUA: [['capacity','Capacidad (t)','number'],['reach','Alcance (m)','number'],['maneuver','Condiciones de maniobra','text']],
 STOCKA: [['capacity','Capacidad (t)','number'],['characteristics','Características requeridas','text']],
 ESTIBA: [['workers','Cantidad de operarios','number'],['schedule','Horario','text'],['activities','Actividades','text']],
 OTROS: [['resource','Equipo o recurso requerido','text']],
}
