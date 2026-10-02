// Tipos del módulo APT (Estadía del inventario en el Almacén de Producto Terminado).
// Reflejan lo que devuelven las funciones public.apt_* de la migración 20261002100000_apt_estadia_inventario.sql.

export type AptEstado = 'En APT' | 'Salida parcial' | 'Despachado' | 'Sin salida identificada' | 'Problema de información'
export type AptTipoLote = 'CONTRATO' | 'SUBCONTRATO' | 'ERROR' | 'GARANTIA'
export type AptAlerta = 'problema_info' | 'posible_cruce'
export type AptGrain = 'dia' | 'semana' | 'mes'
export type AptLevel = 'capa' | 'lote' | 'producto' | 'glosa' | 'familia' | 'numrel_op' | 'ipt' | 'contrato' | 'cliente'
export type AptDim = 'lote' | 'producto' | 'glosa' | 'familia'

// Filtros comunes; todas las claves son opcionales y se envían tal cual a las funciones
export interface AptFilters {
  lote?: string
  lotes?: string[]
  contrato?: string
  tipos?: AptTipoLote[]
  numrel_op?: string
  producto?: string
  productos?: string[]   // coincidencia exacta (clic en un producto)
  glosa?: string
  glosas?: string[]      // coincidencia exacta
  alertas?: AptAlerta[]
  clientes?: string[]    // cliente del lote (exacto)
  contratos?: string[]   // OT madre (exacto)  // capas con problema de información o posible cruce de NumRel
  ipt?: string
  familias?: string[]
  estados?: AptEstado[]
  rangos?: string[]
  docrels?: string[]
  ingreso_desde?: string
  ingreso_hasta?: string
  entrega_desde?: string
  entrega_hasta?: string
  cliente?: string
  solo_saldo?: boolean
  dias_min?: number
}

export interface AptKpis {
  tn_ingresadas: number
  tn_despachadas: number
  tn_saldo: number
  kg_saldo: number
  pct_despachado: number | null
  lotes_total: number
  lotes_activos: number
  ops_activas: number
  productos_apt: number
  ipt_apt: number
  capas_abiertas: number
  dias_prom: number | null
  dias_mediana: number | null
  dias_max: number | null
  aging_pond: number | null
  tn_gt7: number
  tn_gt15: number
  tn_gt30: number
  tn_gt_alerta: number
  pct_gt7: number | null
  pct_gt15: number | null
  pct_gt30: number | null
  lotes_criticos: number
  lotes_sin_salida: number
  lotes_parciales: number
  tn_dias: number
  fecha_mas_antigua: string | null
  dias_despacho_pond: number | null
  capas_problema: number
  tn_posible_cruce: number
  tn_fe_vencida: number
  dias_fe_vencida_pond: number | null
  despacho_diario_30d: number | null
  cobertura_dias: number | null
  rotacion_30d: number | null
  lote_mayor_tn: { lote: string; tn: number } | null
  lote_mayor_txd: { lote: string; tn_dias: number } | null
  lote_mas_antiguo: { lote: string; dias: number; tn: number } | null
  producto_mayor_tn: { producto: string; glosa: string; tn: number } | null
  producto_mas_antiguo: { producto: string; glosa: string; dias: number } | null
}

export interface AptAgingBucket { rango: string; desde: number; tn: number; pct: number | null; capas: number; lotes: number; tn_dias: number }
export interface AptEstadoRow { estado: AptEstado; capas: number; tn_in: number; tn_saldo: number }
export interface AptLoteTop {
  lote: string; tipo: AptTipoLote; glosa: string | null; tn_saldo: number; tn_in: number; tn_dias: number; dias: number | null
  aging_pond: number | null; estado: AptEstado; rango: string | null; fecha_saldo: string | null; fecha_entrega: string | null; productos: number
}
export interface AptProductoTop { producto: string; glosa: string | null; tn_saldo: number; tn_dias: number; dias: number | null; aging_pond: number | null; lotes: number }
export interface AptFamiliaTop { familia: string; tn_saldo: number; tn_dias: number; aging_pond: number | null; lotes: number }
export interface AptTrendPoint {
  periodo: string; hasta: string; tn_in: number; tn_out: number; neto: number; entradas: number; salidas: number
  lotes_ingresados: number; lotes_despachados: number; tn_prom_entrada: number | null; tn_prom_salida: number | null
  dias_prom_despacho: number | null; tn_in_acum: number; tn_out_acum: number; saldo_tn: number; aging_pond: number | null
}

export interface AptDashboard {
  cutoff: string | null
  alert_days: number
  kpis: AptKpis
  aging: AptAgingBucket[]
  estados: AptEstadoRow[]
  top_lotes_tn: AptLoteTop[]
  top_lotes_txd: AptLoteTop[]
  top_productos: AptProductoTop[]
  top_familias: AptFamiliaTop[]
  pareto: { lotes_con_saldo: number; lotes_80: number | null; pct_lotes_80: number | null; top10_pct: number | null }
  trend: AptTrendPoint[]
}

// Fila de detalle a nivel capa (una fila de ENTRADA con su FIFO)
export interface AptCapa {
  id: number; lote: string; tipo: AptTipoLote; numrel_op: string | null; producto: string; glosa: string | null; familia: string | null
  ipt: string | null; documento: string | null; fecha_ingreso: string; fecha_entrega: string | null; primera_salida: string | null
  ultima_salida: string | null; cantidad: number | null; unidad: string | null; kg_in: number; kg_out: number; kg_saldo: number
  tn_in: number; tn_out: number; tn_saldo: number; dias: number | null; dias_saldo: number | null; dias_despacho_pond: number | null
  rango: string | null; tn_dias: number; estado: AptEstado; salida_antes_ingreso: boolean
  problema_info: boolean; posible_cruce: boolean
}

// Fila agregada (lote, producto, glosa, familia, numrel_op, ipt)
export interface AptGroupRow {
  clave: string; etiqueta: string | null; tipo: AptTipoLote | null; capas: number; lotes: number; productos: number; ops: number; ipts: number
  kg_in: number; kg_out: number; kg_saldo: number; tn_in: number; tn_out: number; tn_saldo: number; pct_despachado: number | null
  primer_ingreso: string | null; ultimo_ingreso: string | null; primera_salida: string | null; ultima_salida: string | null
  fecha_entrega: string | null; fecha_saldo: string | null; dias: number | null; dias_max: number | null; aging_pond: number | null
  dias_despacho_pond: number | null; tn_dias: number; capas_problema: number; estado: AptEstado; rango: string | null; rango_orden: number | null
  cliente: string | null; contratos: number; ultimo_despacho: string | null; kg_salidas_lote: number | null
}

export interface AptDetail<T> { level: AptLevel; total: number; totals: { tn_in: number; tn_out: number; tn_saldo: number; tn_dias: number }; rows: T[] }

export type AptSalidaClase = 'ASIGNADA' | 'EXCEDE_INGRESO' | 'OTRO_PRODUCTO_DEL_LOTE' | 'LOTE_SIN_INGRESO' | 'SIN_NUMREL'

export interface AptLoteFicha {
  lote: string
  tipo: AptTipoLote
  cutoff: string | null
  resumen: AptGroupRow | null
  contrato: { id: string; code: string; type: string; status: string } | null
  productos: AptGroupRow[]
  capas: Array<{
    id: number; producto: string; glosa: string | null; numrel_op: string | null; ipt: string | null; documento: string | null
    fecha_ingreso: string; fecha_entrega: string | null; cantidad: number | null; unidad: string | null; kg_in: number; kg_out: number
    kg_saldo: number; dias: number | null; dias_saldo: number | null; tn_dias: number; estado: AptEstado; rango: string | null
    ultima_salida: string | null; problema_info: boolean; posible_cruce: boolean; salida_antes_ingreso: boolean
    row_no: number; archivo: string; raw: Record<string, unknown>
  }>
  salidas: Array<{
    id: number; fecha: string; guia: string | null; cliente: string | null; docrel: string | null; numrel: string | null; producto: string
    glosa: string | null; cantidad: number | null; unidad: string | null; kg: number; kg_asignado: number; kg_sin_entrada: number
    clase: AptSalidaClase | null; row_no: number; archivo: string; raw: Record<string, unknown>
  }>
  asignaciones: Array<{ capa: number; salida: number; kg: number; fecha_ingreso: string; fecha_salida: string; dias: number }>
}

export interface AptPareto {
  dim: AptDim; metric: 'tn' | 'txd'; total: number; items_total: number; items_80: number | null; pct_items_80: number | null
  items: Array<{ rank: number; clave: string; etiqueta: string | null; valor: number; dias: number | null; pct: number; pct_acum: number; clase: 'A' | 'B' | 'C' }>
}

export interface AptHeatmap {
  dim: AptDim; rangos: string[]
  rows: Array<{ clave: string; etiqueta: string | null; tn: number; tn_dias: number; celdas: Array<{ rango: string; tn: number }> }>
}

export type AptFeClase = 'Antes de FechaEntrega' | 'En fecha' | 'Después de FechaEntrega' | 'Sin FechaEntrega'
export interface AptFechaEntrega {
  cutoff: string | null
  ingreso_vs_fe: Array<{ clase: AptFeClase; capas: number; tn: number; dias_prom: number | null }>
  salida_vs_fe: Array<{ clase: AptFeClase; tn: number; dias_prom: number | null }>
  distribucion_ingreso: Array<{ rango: string; tn: number; capas: number }>
  distribucion_salida: Array<{ rango: string; tn: number }>
  saldo_vencido: { tn: number; tn_sin_fe: number; dias_prom_pond: number | null }
  top_lotes_saldo_vencido: Array<{ lote: string; tn: number; fecha_entrega: string; dias_desde_fe: number; primer_ingreso: string }>
}

export interface AptFilterOptions {
  lotes: Array<{ lote: string; tipo: AptTipoLote; tn_saldo: number }>
  contratos: string[]
  familias: Array<{ familia: string; tn_saldo: number }>
  clientes: Array<{ cliente: string; tn_saldo: number }>
  docrels: string[]
  estados: AptEstado[]
  rangos: string[]
  fechas: { ingreso_min: string | null; ingreso_max: string | null; entrega_min: string | null; entrega_max: string | null }
  state: AptState
}

export interface AptState { cutoff: string | null; data_min: string | null; data_max: string | null; rebuilt_at: string | null }

export interface AptSettings {
  settings: { cutoff_date: string | null; tolerance: number; alert_days: number; updated_by: string | null; updated_at: string }
  ranges: Array<{ desde: number; label: string }>
  state: AptState
  can_load: boolean
  last_upload: AptUpload | null
}

export interface AptUploadSummaryKind { filas: number; validas: number; excluidas: number; desde: string | null; hasta: string | null; reemplazadas: number; tn: number }
export interface AptUpload {
  id: string; file_name: string; status: 'CARGANDO' | 'APLICADA' | 'DESCARTADA'; created_by: string | null; created_at: string
  applied_at: string | null; summary: { entrada?: AptUploadSummaryKind; salida?: AptUploadSummaryKind }
}

export interface AptQualitySheet {
  tipo: 'ENTRADA' | 'SALIDA'; filas: number; validas: number; excluidas: number; motivos_exclusion: Record<string, number>
  fecha_min: string | null; fecha_max: string | null; dias_con_movimiento: number; posteriores_al_corte: number; tn: number
  lotes: number; productos: number; documentos: number; sin_peso: number; sin_numrel: number; lote_derivado: number
  error_contrato_a_lote: number; peso_inconsistente: number; duplicados: number
  unidades: Record<string, number>; bodegas: Record<string, number>; docrels: Record<string, number>
}
export interface AptQuality {
  cutoff: string | null
  hojas: AptQualitySheet[]
  conciliacion: Array<{ concepto: string; fuente: number; modelo: number; diferencia: number; estado: 'OK' | 'REVISAR'; explicacion: string }>
  salidas_por_clase: Array<{ clase: AptSalidaClase; filas: number; tn: number; tn_sin_entrada: number }>
  capas_por_estado: Array<{ estado: AptEstado; capas: number; tn_in: number }>
  salida_antes_de_ingreso: { capas: number; tn: number }
  lotes_sin_ingreso: number
  posible_cruce: { capas: number; lotes: number; tn_saldo: number }
  problema_info: { capas: number; tn_in: number }
  historico_suficiente: boolean
  excluidas_total: number
  excluidas: Array<{ tipo: string; fila: number; archivo: string; motivo: string; raw: Record<string, unknown> }>
}

export type AptAlertaNivel = 'error' | 'aviso' | 'info'
export interface AptCoverageSheet {
  rangos: Array<{ desde: string; hasta: string }>
  huecos: Array<{ desde: string; hasta: string; dias: number }>
  desde: string | null
  hasta: string | null
  dias_sin_movimiento: Array<{ desde: string; hasta: string; dias: number }>
  preview: { desde: string; hasta: string; filas_a_reemplazar: number; hueco_antes: { desde: string; hasta: string; dias: number } | null } | null
}
export interface AptCoverage {
  hojas: { ENTRADA: AptCoverageSheet; SALIDA: AptCoverageSheet }
  alertas: Array<{ nivel: AptAlertaNivel; hoja: 'ENTRADA' | 'SALIDA' | null; mensaje: string }>
  secuencia_ok: boolean
}
