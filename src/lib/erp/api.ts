import { createClient } from '@/lib/supabase/client'
import type { ErpParsedFile } from './parse'
import type { ErpEstado, ErpGuias, ErpOtDetalle, ErpOts, ErpStock } from './types'

// Datos del ERP (Actualizable Despacho y Stock Bodega Despacho): carga manual y consultas public.erp_*
const supabase = createClient()

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw Object.assign(new Error(error.message), { retryable: error.code === '57014' || error.code?.startsWith('08') || /fetch|network|timeout/i.test(error.message) })
  const out = data as { success?: boolean; error?: string; partial?: boolean } | null
  if (!out || out.success === false) throw Object.assign(new Error(out?.error || 'No se pudo consultar los datos del ERP'), { partial: !!out?.partial })
  return out as T
}

export const erpApi = {
  estado: () => call<ErpEstado>('erp_estado'),
  ots: (p: { q?: string; estado?: 'PENDIENTE' | 'TODAS'; incluir_servicios?: boolean; incluir_errores?: boolean; limit?: number }) => call<ErpOts>('erp_ots', { p }),
  ot: (ot: string) => call<ErpOtDetalle>('erp_ot_detalle', { p_ot: ot }),
  guias: (p: { desde?: string; hasta?: string; referencia?: string; origen?: string; tolerancia?: number; q?: string; limit?: number }) => call<ErpGuias>('erp_guias', { p }),
  stock: (p: { q?: string; situacion?: string; bodega?: string; limit?: number }) => call<ErpStock>('erp_stock', { p }),
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
  return out
}

type Applied = { rows: number; summary: Record<string, unknown> }

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
