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
