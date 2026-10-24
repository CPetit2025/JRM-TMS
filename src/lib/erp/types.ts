import type { ErpKind } from './parse'

export interface ErpImport { id: string; file_name: string; cut_at: string | null; applied_at: string | null; rows: number; summary: Record<string, unknown> }
export interface ErpEstado {
  success: true; can_load: boolean
  activas: Partial<Record<ErpKind, ErpImport>>
  historial: Array<{ id: string; kind: ErpKind; status: 'CARGANDO' | 'ACTIVA' | 'REEMPLAZADA'; file_name: string; cut_at: string | null; applied_at: string | null; created_at: string; rows: number }>
}

export interface ErpOt {
  ot: string; cliente: string | null; ruc: string | null; fecha_contrato: string | null; fecha_vcto: string | null; vigente: boolean
  lineas: number; documentos: number; contrato: number; despachado: number; pendiente: number; lineas_pendientes: number; sobredespacho: number
  listo: number; ult_despacho: string | null; t_pendiente: number | null; t_listo: number | null; peso_completo: boolean
}
export interface ErpOts { success: true; sin_datos?: boolean; total: number; ots: ErpOt[] }

export interface ErpGuia {
  guia: string; ots: string | null; docs: string | null; items: number | null; cantidad: number | null; kg: number | null; cliente: string | null
  fecha_erp: string | null; erp_exacta: boolean | null; erp_fuente: 'ACTUALIZABLE' | 'SALIDAS' | 'APROXIMADA' | null
  fecha_tms: string | null; rutas: string | null; placas: string | null; ot_tms: string | null
  origen: 'AMBOS' | 'SOLO_ERP' | 'SOLO_TMS'; dif_dias: number | null; fecha_ref: string | null; ot_distinta: boolean | null
}
export interface ErpGuias {
  success: true; sin_datos?: boolean; tolerancia: number; referencia: 'AUTO' | 'ERP' | 'TMS'
  resumen: { total: number; ambos: number; solo_erp: number; solo_tms: number; desfase: number; ot_distinta: number; erp_aproximada: number; kg: number }
  guias: ErpGuia[]
}
export interface ErpOtDetalle {
  success: true; ot: string
  lineas: Array<{ documento: string; tipo_documento: string | null; secuencia: number; cod_producto: string; producto: string | null; color: string | null
    unidad: string | null; tipo_producto: string | null; contrato: number; despachado: number; pendiente: number; estado: string | null; guias: number
    ult_despacho: string | null; stock: number | null; listo: number | null; peso_unit: number | null; cliente: string | null; fecha_contrato: string | null; vigencia: string | null }>
  guias: Array<{ guia: string; fecha_erp: string | null; erp_exacta: boolean; fecha_tms: string | null; rutas: string | null; placas: string | null
    items: number; cantidad: number; documentos: string; dif_dias: number | null }>
  stock: Array<{ bodega: string; lote: string | null; cod_producto: string; producto: string | null; stock: number; unidad: string | null; kg: number | null }>
}
export type ErpSituacion = 'LISTO' | 'SOBRANTE' | 'OT_COMPLETA' | 'SKU_FUERA_DE_CONTRATO' | 'SIN_CONTRATO' | 'SIN_LOTE' | 'NEGATIVO' | 'SIN_ACTUALIZABLE'
export interface ErpStockLote {
  bodega: string; lote: string | null; documento: string | null; ot: string | null; cod_producto: string; producto: string | null; tipo_producto: string | null
  unidad: string | null; stock: number; stock_falla: number; kg: number | null; pendiente: number | null; cliente: string | null; listo: number; situacion: ErpSituacion
}
export interface ErpStock {
  success: true; sin_datos?: boolean
  resumen: Array<{ bodega: string; situacion: ErpSituacion; lotes: number; kg: number }> | null
  lotes: ErpStockLote[]
}

// ---- Análisis con cruce exacto (documento + producto + unidad, sin reglas de conversión) ----
export type ErpCruce = 'COINCIDE' | 'UNIDAD_DISTINTA' | 'LOTE_CON_CEROS' | 'LOTE_CON_SUFIJO_D' | 'SIN_COINCIDENCIA'
export type ErpStockCruceEstado = 'COINCIDE' | 'UNIDAD_DISTINTA' | 'DOCUMENTO_SIN_PRODUCTO' | 'LOTE_CON_CEROS' | 'LOTE_CON_SUFIJO_D' | 'SIN_DOCUMENTO' | 'SIN_LOTE'
export interface ErpAnalisisFiltros {
  ot?: string; cliente?: string; documento?: string; tipo_documento?: string; familia?: string; producto?: string; unidad?: string; bodega?: string
  estado?: string; vigencia?: string; cruce?: string; solo_pendiente?: boolean; vencida?: boolean; vista?: 'DOCUMENTO' | 'OT'; limit?: number; offset?: number
}
export interface ErpAnalisisDoc {
  documento: string; cod_producto: string; unidad: string; ot: string | null; tipo_documento: string | null; cliente: string | null; ruc: string | null
  producto: string | null; familia: string | null; tipo_producto: string | null; lineas: number; contratado: number; despachado: number; reemplazado: number
  pendiente: number; dif_formula: number; dato_ausente: boolean; fecha_contrato: string | null; fecha_vcto: string | null; ult_despacho: string | null
  estados: string | null; vigencia: string | null; guias: number; secuencias: number[]; filas_origen: Array<number | null>
  stock: number | null; lotes: number | null; bodegas: string | null; cruce: ErpCruce
  faltante: number | null; cobertura: number | null; avance: number | null; vencida: boolean; antiguedad: number | null
}
export interface ErpAnalisisOt {
  ot: string; tipo_documento: string | null; unidad: string; cliente: string | null; documentos_producto: number; documentos: number
  contratado: number; despachado: number; reemplazado: number; pendiente: number; stock: number | null; faltante: number | null; con_stock: number
  vencidas: number; fecha_contrato: string | null; fecha_vcto: string | null; ult_despacho: string | null; avance: number | null; cobertura: number | null
}
export interface ErpAnalisisResumen {
  unidad: string; tipo_documento: string | null; filas: number; documentos: number; lineas: number; contratado: number; despachado: number; reemplazado: number
  pendiente: number; avance: number | null; stock_coincidente: number | null; faltante: number | null; cobertura: number | null
  con_pendiente: number; pendiente_con_stock: number; sobredespacho: number; vencidas: number
}
export interface ErpAnalisis {
  success: true; sin_datos?: boolean; vista: 'DOCUMENTO' | 'OT'; unidad_original: boolean; hoy: string; total: number
  resumen: ErpAnalisisResumen[]; estados: Record<string, number>; cruces: Partial<Record<ErpCruce, number>>
  filas: Array<ErpAnalisisDoc | ErpAnalisisOt>
}
export interface ErpAnalisisDetalle {
  success: true
  lineas: Array<{ fila_origen: number | null; tipo_documento: string | null; correlativo: number | null; secuencia: number; producto: string | null; color: string | null
    unidad_erp: string | null; unidad: string | null; contratado: number; despachado: number; reemplazado: number; pendiente: number; estado: string | null
    vigencia: string | null; fecha_contrato: string | null; fecha_vcto: string | null; ult_despacho: string | null; guias: number; dato_ausente: boolean }>
  lotes: Array<{ fila_origen: number; bodega: string; lote: string | null; unidad: string | null; stock: number; stock_falla: number; peso_unitario: number | null
    peso_total_erp: number | null; coincide: boolean }>
  guias: Array<{ guia: string; cantidad: number; secuencia: number; fecha_erp: string | null; fecha_erp_exacta: boolean | null }>
}
export interface ErpStockCruce {
  success: true; sin_datos?: boolean; total: number
  resumen: Array<{ bodega: string; unidad: string | null; cruce: ErpStockCruceEstado; lotes: number; stock: number }>
  filas: Array<{ fila_origen: number; bodega: string; cod_producto: string; producto: string | null; tipo_producto: string | null; unidad: string | null; lote: string | null
    stock: number; stock_falla: number; stock_comprometido: number | null; peso_unitario: number | null; peso_total_erp: number | null; familia: string | null
    pendiente: number | null; cruce: ErpStockCruceEstado }>
}

// ---- Calidad de datos ----
export interface ErpControl { codigo: string; origen: 'Actualizable' | 'Stock' | 'Cruce'; titulo: string; tipo: 'ERROR' | 'REVISAR' | 'INFORMATIVO'; cantidad: number
  ejemplos: Array<Record<string, unknown>> | null }
export interface ErpCalidad {
  success: true; controles: ErpControl[]
  cortes: { contratos: string | null; stock: string | null; contratos_procesado: string | null; stock_procesado: string | null }
}

// ---- Reglas heredadas y su comparación ----
export interface ErpRegla { codigo: string; titulo: string; detalle: string; aplica_en: string[] }
type Rows = Array<Record<string, unknown>> | null
export interface ErpReglas {
  success: true; sin_datos?: boolean
  regla_vigente: { version: number; origen: 'HEREDADA' | 'APROBADA'; nota: string | null; reglas: ErpRegla[] } | null
  cortes: Partial<Record<'CONTRATOS' | 'STOCK', { corte: string | null; procesado: string | null; version_reglas: number | null }>>
  CIEN_A_UND: { lotes_afectados: number; productos: number; stock_original_por_unidad: Record<string, number> | null; stock_convertido_und: number | null
    documentos_producto_que_cruzan_solo_con_regla: number; pendiente_que_cruza_solo_con_regla: number | null; catalogo: Rows; ejemplos: Rows }
  LOTE_SIN_CEROS: { lotes_con_ceros: number; coinciden_con_clave_auxiliar: number; stock_que_cruza_solo_con_regla: number | null
    colisiones_misma_bodega: number; claves_ambiguas: number; ejemplos: Rows }
  PESO_POR_UNIDAD: { filas: number; peso_total_erp_coincide_con_stock_x_peso_unitario: number; kg_erp: number | null; kg_con_regla: number | null; ejemplos: Rows }
  OT_SUMA_TIPOS: { ot_con_pendiente: number; ot_con_varios_tipos: number; ot_con_varias_unidades: number
    sobredespacho_que_la_regla_cuenta_como_cero: { lineas: number; cantidad: number | null }; pendiente_por_tipo_y_unidad: Rows }
  EXCLUSION_POR_DEFECTO: { detalle: Rows }
  UNID_A_UND: { lineas: number; sin_unidad_original: number }
}

// ---- Registro de cargas y marcas de actualización ----
export interface ErpCargaLog {
  id: string; tipo: 'CONTRATOS' | 'STOCK' | 'MOVIMIENTOS' | 'LECTURA'; archivo: string | null; corte_erp: string | null; inicio: string; fin: string | null
  estado: 'EN_CURSO' | 'OK' | 'ERROR' | 'INTERRUMPIDA'; filas_esperadas: number | null; filas_cargadas: number | null; error: string | null
  detalle: Record<string, unknown>; version_reglas: number | null; usuario: string | null
}
export interface ErpCargasLog {
  success: true; regla_vigente: number | null
  activas: Partial<Record<'CONTRATOS' | 'STOCK', { corte_erp: string | null; procesado_tms: string | null; filas: number; version_reglas: number | null; archivo: string }>>
  ultimo_dia_derivado: { fecha: string; generado: string; version_reglas: number | null } | null
  registro: ErpCargaLog[]
}
