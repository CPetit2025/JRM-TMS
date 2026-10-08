import type { FlowAlmacen } from './flowTypes'

export type GanttEstado = 'CON_SALDO' | 'PARCIAL' | 'DESPACHADO' | 'SALIDA_NO_ENTREGA' | 'RESIDUAL'
export interface GanttFilters {
  desde?: string; hasta?: string; corte?: string; ot?: string; lote?: string; lote_exacto?: string; cliente?: string
  almacen?: FlowAlmacen; estado?: GanttEstado; solo_criticos?: boolean
}
export interface GanttSegment {
  almacen: FlowAlmacen; producto: string; tipo: string; desde: string | null; hasta: string
  ingresadas_tn: number; saldo_tn: number; dias: number | null; abierto: boolean
  documento: string | null; precision: 'FIFO'; capas: number
}
export interface GanttEvent {
  fecha: string | null; tipo: string; almacen: FlowAlmacen; documento: string | null
  tn: number; sentido: 'INGRESO' | 'SALIDA'; lote_rel: string | null; precision: 'DOCUMENTAL' | 'INFERIDO'
}
export interface GanttRow {
  lote: string; ot: string | null; cliente: string | null; productos: number
  ingresadas_tn: number; inicial_tn: number; asignadas_tn: number; cedidas_tn: number
  despachadas_tn: number; otras_salidas_tn: number; saldo_tn: number; saldo_sin_fecha_tn: number
  fecha_entrega_min: string | null; fecha_entrega_max: string | null; fechas_entrega_total: number
  primera_fecha: string | null; ultima_fecha: string | null; primera_salida: string | null
  dias: number | null; edad_ponderada: number | null; tn_dias: number; estado: GanttEstado; critico: boolean
  segmentos: GanttSegment[]; eventos: GanttEvent[]; segmentos_total: number; eventos_total: number
}
export interface GanttResult {
  age_basis: 'ALMACEN' | 'ORIGEN'; data_max: string | null; model_cutoff: string | null; requested_cutoff: string | null
  vacio?: boolean; cutoff: string | null; data_min: string | null; desde: string | null; hasta: string | null
  model_pending: boolean; last_upload_at: string | null
  rebuilt_at: string | null; alert_days: number; tolerance: number; total: number; limit: number; offset: number
  cobertura: Array<{ tipo: string; desde: string | null; hasta: string | null; filas: number; sin_peso: number }>
  kpis: { lotes: number; ot: number; abiertas: number; ingresadas_tn: number; inicial_tn: number
    asignadas_tn: number; cedidas_tn: number; despachadas_tn: number; saldo_tn: number
    criticas_tn: number; sin_fecha_tn: number; edad_ponderada: number | null; tn_dias: number }
  filas: GanttRow[]
  prioridades: Array<{ lote: string; ot: string | null; cliente: string | null; saldo_tn: number; dias: number | null; tn_dias: number; motivo: string }>
  serie: Array<{ fecha: string; saldo_tn: number }>
}
