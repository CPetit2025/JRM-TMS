import { createClient } from '@/lib/supabase/client'
import type { FlowAdelantos, FlowFilters, Kardex, KardexFilters, KardexNivel, OtFamilia, FlowLeadDim, FlowLeadtime, FlowQuality, FlowSt, FlowStock, FlowSummary, FlowTrace } from './flowTypes'
import type {
  AptDashboard, AptDetail, AptDim, AptFechaEntrega, AptFilterOptions, AptFilters, AptGrain, AptHeatmap, AptLevel, AptLoteFicha,
  AptCoverage, AptPareto, AptQuality, AptSettings, AptTrendPoint, AptUpload,
} from './types'

// Acceso a las funciones public.apt_*. Todas devuelven { success, error?, ... }; aquí se convierte un error en excepción.
const supabase = createClient()

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
  const out = data as { success?: boolean; error?: string } | null
  if (!out || out.success === false) throw new Error(out?.error || 'No se pudo obtener la información de APT')
  return out as T
}

// Las cargas se procesan exclusivamente en el servidor. Una respuesta perdida nunca
// autoriza repetir una operación de reemplazo con el límite del navegador.
const PASO = { aplicar: 'aplicar la carga', estadia: 'recalcular la estadía', flujo: 'recalcular el flujo' } as const

async function procesar(body: { accion: 'aplicar' | 'estadia' | 'flujo'; upload_id?: string }) {
  let res: Response
  try {
    res = await fetch('/api/apt/procesar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    throw new Error(`Se perdió la conexión al ${PASO[body.accion]}. Revise el historial antes de repetir la carga.`)
  }
  const out = await res.json().catch(() => null) as { success?: boolean; error?: string; summary?: unknown; model?: unknown; flow?: unknown } | null
  if (res.status === 404 || (res.status === 503 && !out?.success)) {
    throw new Error('El procesamiento de APT en el servidor no está disponible. No se intentó aplicar desde el navegador. Contacte al administrador para revisar la configuración del servidor.')
  }
  if (res.status === 504) throw new Error(`El servidor tardó demasiado al ${PASO[body.accion]}. Revise el historial antes de repetir la carga.`)
  if (!res.ok || !out?.success) throw new Error(out?.error || `No se pudo procesar la carga (${res.status})`)
  return out
}

async function rebuildModels() {
  const model = await procesar({ accion: 'estadia' })
  const flow = await procesar({ accion: 'flujo' })
  return { model: model.model, flow: flow.flow }
}

// Hojas de carga: ENTRADA (P/E Producción), SALIDA (despacho), lados de los traspasos, consumos internos y devoluciones
export type AptUploadKind = 'ENTRADA' | 'SALIDA' | 'TRASPASO_SAL' | 'TRASPASO_ENT' | 'CONSUMO' | 'DEVOLUCION'

// Quita claves vacías para que la URL y las consultas solo lleven filtros activos
export function cleanFilters<T extends object = AptFilters>(f: T): T {
  const out: Record<string, unknown> = {}
  Object.entries(f).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '' || v === false) return
    if (Array.isArray(v) && v.length === 0) return
    out[k] = typeof v === 'string' ? v.trim() : v
  })
  return out as T
}

export const aptApi = {
  dashboard: (f: AptFilters, grain: AptGrain = 'semana') => call<AptDashboard>('apt_dashboard', { p: cleanFilters(f), p_grain: grain }),
  trends: (f: AptFilters, grain: AptGrain) =>
    call<{ grain: AptGrain; cutoff: string | null; series: AptTrendPoint[] }>('apt_trends', { p: cleanFilters(f), p_grain: grain }),
  detail: <T>(f: AptFilters, level: AptLevel, sort: string, desc: boolean, limit = 100, offset = 0) =>
    call<AptDetail<T>>('apt_detail', { p: cleanFilters(f), p_level: level, p_sort: sort, p_desc: desc, p_limit: limit, p_offset: offset }),
  lote: (lote: string) => call<AptLoteFicha>('apt_lote', { p_lote: lote }),
  pareto: (f: AptFilters, dim: AptDim, metric: 'tn' | 'txd') => call<AptPareto>('apt_pareto', { p: cleanFilters(f), p_dim: dim, p_metric: metric }),
  heatmap: (f: AptFilters, dim: AptDim, top = 25) => call<AptHeatmap>('apt_heatmap', { p: cleanFilters(f), p_dim: dim, p_top: top }),
  fechaEntrega: (f: AptFilters) => call<AptFechaEntrega>('apt_fecha_entrega', { p: cleanFilters(f) }),
  filterOptions: () => call<AptFilterOptions>('apt_filter_options'),
  quality: () => call<AptQuality>('apt_quality'),
  settings: () => call<AptSettings>('apt_get_settings'),
  // Los parámetros recalculan la estadía; el flujo multi-almacén se recalcula en una segunda petición
  saveSettings: async (p: { cutoff_date: string | null; tolerance: number; alert_days: number; ranges: Array<{ desde: number; label: string }> }) => {
    const out = await call<{ model: unknown }>('apt_save_settings', { p })
    await procesar({ accion: 'flujo' })
    return out
  },
  // Cobertura de fechas cargadas y alertas de secuencia; preview evalúa una carga antes de confirmarla
  coverage: (preview?: Partial<Record<AptUploadKind, { desde: string; hasta: string }>>) =>
    call<AptCoverage>('apt_coverage', { p_preview: preview && Object.keys(preview).length ? preview : null }),
  uploadBegin: (fileName: string) => call<{ id: string }>('apt_upload_begin', { p_file_name: fileName }),
  uploadRows: (uploadId: string, kind: AptUploadKind, rows: Record<string, unknown>[]) =>
    call<{ rows: number }>('apt_upload_rows', { p_upload_id: uploadId, p_kind: kind, p_rows: rows }),
  rebuildModels,
  uploadApply: async (uploadId: string) => {
    let summary: AptUpload['summary']
    try {
      const srv = await procesar({ accion: 'aplicar', upload_id: uploadId })
      summary = srv.summary as AptUpload['summary']
    } catch (error) {
      // La respuesta pudo perderse después de confirmar la transacción. Consultar
      // el estado evita descartar una carga aplicada o reemplazar otra vez sus filas.
      const { data, error: statusError } = await supabase.from('apt_uploads')
        .select('status, summary').eq('id', uploadId).maybeSingle()
      if (statusError || data?.status !== 'APLICADA') throw error
      summary = data.summary as AptUpload['summary']
    }
    try {
      return { summary, ...await rebuildModels(), warning: null }
    } catch (error) {
      return { summary, warning: `La carga está aplicada. El recálculo quedó pendiente: ${error instanceof Error ? error.message : 'error del servidor'}` }
    }
  },
  uploadDiscard: (uploadId: string) => call<Record<string, never>>('apt_upload_discard', { p_upload_id: uploadId }),
  uploads: async (limit = 50) => {
    const { data, error } = await supabase.from('apt_uploads').select('*').neq('status', 'CARGANDO')
      .order('created_at', { ascending: false }).limit(limit)
    if (error) throw new Error(error.message)
    return data || []
  },
}

// Flujo multi-almacén (647 · 540 · ST VENTAS)
export const flowApi = {
  summary: (f: FlowFilters) => call<FlowSummary>('apt_flow_summary', { p: cleanFilters(f) }),
  stock: (f: FlowFilters) => call<FlowStock>('apt_flow_stock', { p: cleanFilters(f) }),
  leadtime: (f: FlowFilters, dim: FlowLeadDim) => call<FlowLeadtime>('apt_flow_leadtime', { p: cleanFilters(f), p_dim: dim }),
  st: (f: FlowFilters) => call<FlowSt>('apt_flow_st', { p: cleanFilters(f) }),
  adelantos: (f: FlowFilters) => call<FlowAdelantos>('apt_flow_adelantos', { p: cleanFilters(f) }),
  trace: (q: string) => call<FlowTrace>('apt_flow_trace', { p_q: q }),
  quality: () => call<FlowQuality>('apt_flow_quality'),
  rebuild: () => call<{ cutoff: string | null }>('apt_flow_rebuild'),
  kardex: (f: KardexFilters, nivel: KardexNivel, porAlmacen: boolean, limit = 500, offset = 0) =>
    call<Kardex>('apt_kardex', { p: cleanFilters(f), p_nivel: nivel, p_por_almacen: porAlmacen, p_limit: limit, p_offset: offset }),
  familia: (q: string) => call<OtFamilia>('apt_ot_familia', { p_q: q }),
}

