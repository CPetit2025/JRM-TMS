import { createClient } from '@/lib/supabase/client'

export type Frecuencia = 'SEMANAL' | 'QUINCENAL' | 'MENSUAL'
export type Equipo = 'TRANSPORTE' | 'DESPACHO' | 'INVENTARIO' | 'AUDITORIA'
export type EstadoKpi = 'CUMPLE' | 'ALERTA' | 'NO_CUMPLE' | 'DATOS_INSUFICIENTES' | 'SIN_REGISTROS' | 'PENDIENTE_DATOS' | 'INFORMATIVO'
export type EstadoDatos = 'ACTIVO' | 'PARCIAL' | 'PENDIENTE_CAPTURA' | 'PENDIENTE_INTEGRACION'
export type EstadoCorreccion = 'PROPUESTA' | 'APROBADA' | 'RECHAZADA' | 'ANULADA'
export type Accion = 'CORREGIR' | 'EXCLUIR'

export interface PuntoTendencia { desde: string; etiqueta: string; valor: number | null; estado: EstadoKpi }
export interface KpiDef {
  codigo: string; equipo: Equipo; nombre: string; descripcion: string; formula: string; fuente: string; unidad: string
  sentido: 'MAYOR' | 'MENOR'; meta: number | null; tolerancia: number | null; responsable: string | null
  estado_datos: EstadoDatos; nota_datos: string | null; tipo: 'PERIODO' | 'FOTO'; frecuencias: Frecuencia[]
}
export interface KpiResultado extends KpiDef {
  valor: number | null; n: number; n_con_dato: number; cobertura: number | null; estado: EstadoKpi; tendencia: PuntoTendencia[]
  num?: number | null; den?: number | null; correcciones_pendientes?: number
}
export interface Periodo { desde: string; hasta: string; etiqueta: string; estado?: string }
export interface Tablero {
  frecuencia: Frecuencia; desde: string; hasta: string; etiqueta: string; estado_periodo: 'ABIERTO' | 'CERRADO' | 'REABIERTO'
  version: number | null; cerrado_at: string | null; provisional: boolean; es_revisor: boolean; equipos: Equipo[]; periodos: Periodo[]; kpis: KpiResultado[]
}
export interface Correccion { id: string; estado: EstadoCorreccion; accion: Accion; motivo: string; detalle: string | null; num_nuevo: number | null; den_nuevo: number | null; propuesto_por_nombre: string }
export interface FilaDetalle {
  ref: string; fecha: string; etiqueta: string; num: number | null; den: number | null; con_dato: boolean; origen: 'AUTO' | 'CORREGIDO' | 'EXCLUIDO'
  responsable_nombre: string | null; dims: Record<string, unknown> | null; puede_proponer: boolean; correccion: Correccion | null
  cerrado: boolean; num_orig: number | null; den_orig: number | null
}
export interface KpiDefConfig extends KpiDef { updated_at: string | null; updated_by_nombre: string | null }
export interface Detalle { kpi: KpiDef; cerrado: boolean; filas: FilaDetalle[] }
export interface CorreccionBandeja {
  id: string; codigo: string; kpi_nombre: string; equipo: Equipo; ref: string; etiqueta: string; fecha: string; accion: Accion
  num_orig: number | null; den_orig: number | null; num_nuevo: number | null; den_nuevo: number | null; motivo: string; detalle: string | null
  estado: EstadoCorreccion; propuesto_por_nombre: string; propuesto_at: string; resuelto_por_nombre: string | null; resuelto_at: string | null
  comentario: string | null; puede_resolver: boolean; puede_anular: boolean; puede_revertir: boolean
}
export interface Enlace { token: string; etiqueta: string; equipos: Equipo[]; created_at: string; revoked_at: string | null; visitas: number; ultima_visita: string | null }
export interface DefCambio { codigo: string; meta: number | null; tolerancia: number | null; responsable: string | null; estado_datos: EstadoDatos; nota_datos: string | null }
export interface Publico {
  etiqueta: string; frecuencia: Frecuencia; periodo: { desde: string; hasta: string; etiqueta: string; version: number | null; cerrado_at: string | null } | null
  periodos: Periodo[]; kpis: KpiResultado[]
}

// Todas las RPC devuelven jsonb; un `error` en la respuesta o en el json se convierte en excepción con su mensaje.
async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await createClient().rpc(fn, args)
  if (error) throw new Error(error.message)
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as { error?: string; success?: boolean }
    if (d.error) throw new Error(d.error)
    if (d.success === false) throw new Error('La operación no se pudo completar.')
  }
  return data as T
}

export const tablero = (frecuencia: Frecuencia, desde: string | null) => rpc<Tablero>('kpi_eq_tablero', { p_frecuencia: frecuencia, p_desde: desde })
export const detalle = (codigo: string, desde: string, hasta: string) => rpc<Detalle>('kpi_eq_detalle', { p_codigo: codigo, p_desde: desde, p_hasta: hasta })
export const proponer = (p: { codigo: string; ref: string; fecha: string; accion: Accion; num: number | null; den: number | null; motivo: string; detalle: string }) =>
  rpc<{ success: boolean; id: string }>('kpi_eq_proponer', { p_codigo: p.codigo, p_ref: p.ref, p_fecha: p.fecha, p_accion: p.accion, p_num: p.num, p_den: p.den, p_motivo: p.motivo, p_detalle: p.detalle })
export const resolver = (id: string, aprobar: boolean, comentario: string) => rpc('kpi_eq_resolver', { p_id: id, p_aprobar: aprobar, p_comentario: comentario })
export const anular = (id: string) => rpc('kpi_eq_anular', { p_id: id })
export const revertir = (id: string, motivo: string) => rpc('kpi_eq_revertir', { p_id: id, p_motivo: motivo })
export const correcciones = async (estado: EstadoCorreccion | 'TODAS') => (await rpc<CorreccionBandeja[] | null>('kpi_eq_correcciones', { p_estado: estado })) || []
export const cerrar = (frecuencia: Frecuencia, desde: string) => rpc('kpi_eq_cerrar', { p_frecuencia: frecuencia, p_desde: desde })
export const reabrir = (frecuencia: Frecuencia, desde: string, motivo: string) => rpc('kpi_eq_reabrir', { p_frecuencia: frecuencia, p_desde: desde, p_motivo: motivo })
export const defs = async () => (await rpc<KpiDefConfig[] | null>('kpi_eq_defs')) || []
export const guardarDef =(items: DefCambio[]) => rpc('kpi_eq_guardar_def', { p_items: items })
export const enlaceCrear = (etiqueta: string, equipos: Equipo[]) => rpc<{ token: string; pin: string }>('kpi_eq_enlace_crear', { p_etiqueta: etiqueta, p_equipos: equipos })
export const enlaces = async () => (await rpc<Enlace[] | null>('kpi_eq_enlaces')) || []
export const enlaceRevocar = (token: string) => rpc('kpi_eq_enlace_revocar', { p_token: token })
export const publico = (token: string, pin: string, nombre: string, frecuencia: Frecuencia, desde: string | null) =>
  rpc<Publico>('kpi_eq_publico', { p_token: token, p_pin: pin, p_nombre: nombre, p_frecuencia: frecuencia, p_desde: desde })
