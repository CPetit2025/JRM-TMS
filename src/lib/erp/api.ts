import { createClient } from '@/lib/supabase/client'
import type { ErpParsedFile } from './parse'
import type { ErpAnalisis, ErpAnalisisDetalle, ErpAnalisisFiltros, ErpCalidad, ErpCargasLog, ErpEstado, ErpGuias, ErpOtDetalle, ErpOts, ErpReglas, ErpStock,
  ErpStockCruce } from './types'

// Datos del ERP (Actualizable Despacho y Stock Bodega Despacho): carga manual y consultas public.erp_*
const supabase = createClient()

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw Object.assign(new Error(error.message), { retryable: error.code === '57014' || error.code?.startsWith('08') || /fetch|network|timeout/i.test(error.message) })
  const out = data as { success?: boolean; error?: string; partial?: boolean } | null
  if (!out || out.success === false) throw Object.assign(new Error(out?.error || 'No se pudo consultar los datos del ERP'), { partial: !!out?.partial })
  return out as T
}

export interface ErpDeriveDia { fecha: string; base_fecha: string; base_fuente: 'DATA' | 'ERP' | 'VACIA'; created_at: string; es_base: boolean
  resumen: { guias: number; despachos: number; traspasos: number; ingresos: number; ajustes: number; bodegas: string[] } }
export const erpDeriveEstado = () => call<{ success: true; dias: ErpDeriveDia[] }>('erp_derive_estado')

export const erpApi = {
  estado: () => call<ErpEstado>('erp_estado'),
  ots: (p: { q?: string; estado?: 'PENDIENTE' | 'TODAS'; incluir_servicios?: boolean; incluir_errores?: boolean; limit?: number }) => call<ErpOts>('erp_ots', { p }),
  ot: (ot: string) => call<ErpOtDetalle>('erp_ot_detalle', { p_ot: ot }),
  guias: (p: { desde?: string; hasta?: string; referencia?: string; origen?: string; tolerancia?: number; q?: string; limit?: number }) => call<ErpGuias>('erp_guias', { p }),
  stock: (p: { q?: string; situacion?: string; bodega?: string; limit?: number }) => call<ErpStock>('erp_stock', { p }),
  // Análisis con cruce exacto (sin reglas de conversión), calidad de datos, comparación de reglas y registro de cargas
  analisis: (p: ErpAnalisisFiltros) => call<ErpAnalisis>('erp_analisis', { p }),
  analisisDetalle: (documento: string, producto: string, unidad: string) =>
    call<ErpAnalisisDetalle>('erp_analisis_detalle', { p_documento: documento, p_producto: producto, p_unidad: unidad }),
  stockCruce: (p: { bodega?: string; cruce?: string; q?: string; unidad?: string; limit?: number }) => call<ErpStockCruce>('erp_stock_cruce', { p }),
  calidad: () => call<ErpCalidad>('erp_calidad'),
  reglas: () => call<ErpReglas>('erp_reglas_comparacion'),
  cargas: (limit = 100) => call<ErpCargasLog>('erp_cargas_log', { p_limit: limit }),
}

// Registro de cada intento de carga (también los fallidos). Si el registro no está disponible, la carga sigue igual;
// solo una carga del mismo archivo en curso de otro usuario la detiene.
export type ErpLogKind = 'CONTRATOS' | 'STOCK' | 'MOVIMIENTOS' | 'LECTURA'
export async function erpLogStart(p: { kind: ErpLogKind; file_name?: string; cut_at?: string | null; rows_expected?: number; detalle?: Record<string, unknown> }): Promise<string | null> {
  const { data, error } = await supabase.rpc('erp_log_start', { p })
  if (error) return null
  const out = data as { success?: boolean; id?: string; error?: string } | null
  if (out?.success === false && /otra carga/i.test(out.error || '')) throw new Error(out.error)
  return out?.id ?? null
}
export async function erpLogFinish(id: string | null, p: { status: 'OK' | 'ERROR'; rows_loaded?: number; import_id?: string; error?: string; detalle?: Record<string, unknown> }) {
  if (!id) return
  try { await supabase.rpc('erp_log_finish', { p: { id, ...p } }) } catch { /* el registro no detiene la carga */ }
}
export async function erpLogError(kind: ErpLogKind, file_name: string, error: string) {
  try { await erpLogFinish(await erpLogStart({ kind, file_name }), { status: 'ERROR', error }) } catch { /* idem */ }
}

const CHUNK = 1000
const uploads = new WeakMap<ErpParsedFile, { id: string; next: number }>()

async function retry<T>(work: () => Promise<T>, progress?: (m: string) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await work() } catch (e) {
      const transient = e instanceof TypeError || (e as { retryable?: boolean }).retryable
      if (!transient || attempt >= 2) throw e
      progress?.(`Recuperando la conexión, intento ${attempt + 2} de 3…`)
      await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)))
    }
  }
}

// Iniciar, enviar por bloques (un reintento no duplica: la base ignora filas repetidas) y aplicar. Si se corta, el
// siguiente intento sigue desde el último bloque confirmado.
export async function uploadErpFile(file: ErpParsedFile, onProgress?: (m: string) => void) {
  const log = await erpLogStart({ kind: file.kind, file_name: `${file.fileName} · ${file.sheetName}`, cut_at: file.cutAt, rows_expected: file.rows.length,
    detalle: { reanudada: uploads.has(file) } })
  try {
    const out = await uploadErpFileCore(file, onProgress)
    await erpLogFinish(log, { status: 'OK', rows_loaded: out.rows, import_id: out.upload_id })
    return out
  } catch (e) {
    await erpLogFinish(log, { status: 'ERROR', error: e instanceof Error ? e.message : 'No se pudo cargar', import_id: uploads.get(file)?.id })
    throw e
  }
}

async function uploadErpFileCore(file: ErpParsedFile, onProgress?: (m: string) => void) {
  let state = uploads.get(file)
  if (!state) {
    const begin = await call<{ upload_id: string }>('erp_upload_begin', {
      p_kind: file.kind, p_file_name: `${file.fileName} · ${file.sheetName}`, p_cut_at: file.cutAt, p_expected: file.rows.length,
    })
    state = { id: begin.upload_id, next: 0 }
    uploads.set(file, state)
  }
  for (let i = state.next; i < file.rows.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, file.rows.length)
    onProgress?.(`Enviando filas ${i + 1}–${end} de ${file.rows.length} (${Math.round(end * 100 / file.rows.length)} %)…`)
    await retry(() => call('erp_upload_rows', { p_upload_id: state!.id, p_rows: file.rows.slice(i, end) }), onProgress)
    state.next = end
  }
  onProgress?.('Aplicando y cruzando con el TMS…')
  const out = await applyOnServer(state.id) ?? await retry(() => call<Applied>('erp_upload_apply', { p_upload_id: state!.id }), onProgress)
  uploads.delete(file)
  return { ...out, upload_id: state.id }
}

type Applied = { rows: number; summary: Record<string, unknown> }

// Después de aplicar el Actualizable: corrige el cliente de las OT madre según el RUC del ERP (registra el cliente si no
// existe; solo solicitudes abiertas; historial y aviso al responsable). null si la base aún no lo tiene o no hay permiso.
export async function erpSincronizarClientes(): Promise<{ corregidas: number; clientes_creados: number; ruc_invalido: number; errores: number } | null> {
  const { data, error } = await supabase.rpc('erp_contratos_sincronizar_clientes', { p_simular: false })
  const out = data as { success?: boolean; corregidas: number; clientes_creados: number; ruc_invalido: number; errores: number } | null
  return error || !out?.success ? null : out
}

// Alta automática de las OT activas del ERP que no existen en el TMS (madre con su cliente por RUC, subcontratos y
// errores; sin partida). Se ejecuta en el servidor (sin el límite de 8 s); si no está disponible, desde el navegador.
export type ErpAltaResultado = {
  success: boolean; error?: string; simulacion?: boolean; madres: number; hijos: number; clientes_creados: number
  ruc_invalido: number; sin_madre: number; garantias: number; errores: number
  detalle?: { codigo: string; tipo?: string; cliente?: string; cliente_creado?: boolean; error?: string }[]
}
export async function erpAltaAutomatica(simular = false): Promise<ErpAltaResultado | null> {
  try {
    const res = await fetch('/api/erp/aplicar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: 'alta_ot', simular }) })
    const out = await res.json() as ErpAltaResultado & { fallback?: boolean }
    if (!out.fallback) return out
  } catch { /* se intenta desde el navegador */ }
  const { data, error } = await supabase.rpc('erp_contratos_alta_automatica', { p_simular: simular })
  if (error) return null
  return data as ErpAltaResultado
}

// En el servidor no rige el límite de 8 s del navegador. null = el servidor no está disponible: se aplica desde aquí.
async function applyOnServer(id: string): Promise<Applied | null> {
  let res: Response
  try {
    res = await fetch('/api/erp/aplicar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upload_id: id }) })
  } catch { return null }
  let out: { success?: boolean; error?: string; partial?: boolean; fallback?: boolean } & Partial<Applied>
  try { out = await res.json() } catch { return null }
  if (out.fallback) return null
  if (!out.success) throw Object.assign(new Error(out.error || 'No se pudo aplicar la carga'), { partial: !!out.partial })
  return out as Applied
}
