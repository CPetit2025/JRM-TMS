import { createClient } from '@/lib/supabase/client'
import type { FleetSheetKind } from './parseFleetWorkbook'
import type { FeIpr, FeIprFactorCodigo, FeDatos, FeEquipo, FeFilters, FeMensualRow, FeParams, FeRecambios, FeResumen, FeRutas, FeTransporte, FeUploadSummary, FeAsset } from './types'

// Acceso a las funciones public.fe_* (Eficiencia de Flota). Todas devuelven { success, error?, ... }.
const supabase = createClient()

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
  const out = data as { success?: boolean; error?: string } | null
  if (!out || out.success === false) throw new Error(out?.error || 'No se pudo obtener la información de Eficiencia de Flota')
  return out as T
}

const clean = (f: FeFilters) => Object.fromEntries(Object.entries(f).filter(([, v]) => v))

export const fleetApi = {
  resumen: (f: FeFilters) => call<FeResumen>('fe_resumen', { p: clean(f) }),
  mensual: (f: FeFilters) => call<{ desde: string; hasta: string; filas: FeMensualRow[] }>('fe_mensual', { p: clean(f) }),
  rutas: (f: FeFilters) => call<FeRutas>('fe_rutas', { p: clean(f) }),
  recambios: () => call<FeRecambios>('fe_recambios'),
  ipr: (f: FeFilters) => call<FeIpr>('fe_ipr', { p: clean(f) }),
  iprGuardar: (pesos: Partial<Record<FeIprFactorCodigo, number>> | null, evaluacion: { code: string; obsolescencia: number | null; adecuacion: number | null; nota: string } | null) =>
    call<object>('fe_ipr_guardar', { p_pesos: pesos, p_eval: evaluacion }),
  datos: () => call<FeDatos>('fe_datos'),
  activo: (plate: string) => call<{ desde?: string; hasta?: string; activo: (FeTransporte | FeEquipo) | null }>('fe_activo', { p_plate: plate }),
  saveSettings: (p: { desde?: string; corte?: string | null; params?: Partial<FeParams> }) => call<object>('fe_save_settings', { p }),
  saveAsset: (a: Partial<FeAsset>) => call<{ code: string }>('fe_save_asset', { p: a }),
  saveHours: (code: string, fecha: string, horas: number, nota?: string) =>
    call<object>('fe_save_hours', { p_code: code, p_fecha: fecha, p_horas: horas, p_nota: nota || null }),
  uploadBegin: (fileName: string) => call<{ id: string }>('fe_upload_begin', { p_file_name: fileName }),
  uploadRows: (id: string, kind: FleetSheetKind, rows: object[]) => call<{ rows: number }>('fe_upload_rows', { p_upload_id: id, p_kind: kind, p_rows: rows }),
  uploadApply: (id: string) => call<{ summary: FeUploadSummary }>('fe_upload_apply', { p_upload_id: id }),
  uploadDiscard: (id: string) => call<object>('fe_upload_discard', { p_upload_id: id }),
}

// Formatos
const nf = (d: number) => new Intl.NumberFormat('es-PE', { minimumFractionDigits: d, maximumFractionDigits: d })
export const fmt = (v: number | null | undefined, d = 0) => (v === null || v === undefined || !isFinite(Number(v)) ? '—' : nf(d).format(Number(v)))
export const soles = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? '—' : `S/ ${fmt(v, d)}`)
export const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${fmt(Number(v) * 100)} %`)
export const mes = (iso: string | null | undefined) => {
  if (!iso) return '—'
  const [y, m] = iso.split('-')
  return `${['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic'][Number(m) - 1]}-${y.slice(2)}`
}
export const fecha = (iso: string | null | undefined) => (iso ? new Date(iso.length === 10 ? iso + 'T12:00:00' : iso).toLocaleDateString('es-PE') : '—')
