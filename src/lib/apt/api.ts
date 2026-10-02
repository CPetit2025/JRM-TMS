import { createClient } from '@/lib/supabase/client'
import type {
  AptDashboard, AptDetail, AptDim, AptFechaEntrega, AptFilterOptions, AptFilters, AptGrain, AptHeatmap, AptLevel, AptLoteFicha,
  AptPareto, AptQuality, AptSettings, AptTrendPoint, AptUpload,
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

// Quita claves vacías para que la URL y las consultas solo lleven filtros activos
export function cleanFilters(f: AptFilters): AptFilters {
  const out: Record<string, unknown> = {}
  Object.entries(f).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '' || v === false) return
    if (Array.isArray(v) && v.length === 0) return
    out[k] = typeof v === 'string' ? v.trim() : v
  })
  return out as AptFilters
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
  saveSettings: (p: { cutoff_date: string | null; tolerance: number; alert_days: number; ranges: Array<{ desde: number; label: string }> }) =>
    call<{ model: unknown }>('apt_save_settings', { p }),
  uploadBegin: (fileName: string) => call<{ id: string }>('apt_upload_begin', { p_file_name: fileName }),
  uploadRows: (uploadId: string, kind: 'ENTRADA' | 'SALIDA', rows: Record<string, unknown>[]) =>
    call<{ rows: number }>('apt_upload_rows', { p_upload_id: uploadId, p_kind: kind, p_rows: rows }),
  // Dos peticiones: aplicar la carga (reemplazo por fechas) y recalcular el FIFO; cada una con su propio límite de tiempo
  uploadApply: async (uploadId: string) => {
    const applied = await call<{ summary: AptUpload['summary'] }>('apt_upload_apply', { p_upload_id: uploadId, p_rebuild: false })
    const model = await call<{ cutoff: string | null; capas: number; asignaciones: number }>('apt_model_rebuild')
    return { summary: applied.summary, model }
  },
  uploadDiscard: (uploadId: string) => call<Record<string, never>>('apt_upload_discard', { p_upload_id: uploadId }),
  uploads: async (limit = 50) => {
    const { data, error } = await supabase.from('apt_uploads').select('*').neq('status', 'CARGANDO')
      .order('created_at', { ascending: false }).limit(limit)
    if (error) throw new Error(error.message)
    return data || []
  },
}
