import { createClient } from '@/lib/supabase/client'
import type { InvParsedPart } from './parse'
import type { InvCatalogs, InvDwell, InvFlow, InvOverview, InvStatus, InvStock, InvStockFilters, InvTrace } from './types'

// Acceso a las funciones public.inv_* (inventario multi-almacén). Todas devuelven { success, error?, ... }.
const supabase = createClient()

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw Object.assign(new Error(error.message), { code: error.code, retryable: error.code === '57014' || error.code === '55P03' || error.code?.startsWith('08') || /fetch|network|timeout/i.test(error.message) })
  const out = data as { success?: boolean; error?: string } | null
  if (!out || out.success === false) throw new Error(out?.error || 'No se pudo obtener la información del inventario')
  return out as T
}

export const INV_UPDATED = 'inv:updated'
export const notifyInvUpdated = () => window.dispatchEvent(new Event(INV_UPDATED))

export const invApi = {
  status: () => call<InvStatus>('inv_status'),
  overview: (desde?: string, hasta?: string) => call<InvOverview>('inv_overview', { p_desde: desde || null, p_hasta: hasta || null }),
  stock: (f: InvStockFilters) => call<InvStock>('inv_stock', { p: f }),
  dwell: (f: { desde?: string; hasta?: string; bodegas?: string[] }) => call<InvDwell>('inv_dwell', { p: f }),
  flow: (f: { desde?: string; hasta?: string }) => call<InvFlow>('inv_flow', { p: f }),
  trace: (q: string) => call<InvTrace>('inv_trace', { p_q: q }),
  catalogs: () => call<InvCatalogs>('inv_catalogs'),
  saveCatalog: (p: { bodega: string; kind: string } | { tipodocto: string; clase: string }) => call<{ success: true }>('inv_catalog_save', { p }),
}

// Keep each authenticated RPC well below the database statement timeout.
const CHUNK = 500
const uploads = new WeakMap<InvParsedPart, { id: string; next: number; cutoff: string | undefined; applied: ServerStep | null }>()

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

type ServerStep = { success?: boolean; error?: string; partial?: boolean; fallback?: boolean } & Record<string, unknown>

async function server(body: Record<string, unknown>): Promise<ServerStep> {
  const res = await fetch('/api/inventario/procesar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let out: ServerStep = {}
  try { out = await res.json() } catch { out = { success: false, error: `El servidor respondió ${res.status}` } }
  return out
}

// Sube una parte (Entradas, Salidas o foto de stock): iniciar, enviar filas por bloques y aplicar en el servidor
export async function uploadPart(part: InvParsedPart, opts: { cutoff?: string; force?: boolean; onProgress?: (m: string) => void }) {
  let state = uploads.get(part)
  if (!state || (part.side === 'STOCK' && state.cutoff !== opts.cutoff)) {
    const begin = await call<{ upload_id: string }>('inv_upload_begin', {
      p_side: part.side, p_file_name: `${part.fileName} · ${part.sheetName}`, p_cutoff: part.side === 'STOCK' ? opts.cutoff || null : null,
    })
    state = { id: begin.upload_id, next: 0, cutoff: opts.cutoff, applied: null }
    uploads.set(part, state)
  }
  if (state.applied) return state.applied
  // Advance only after acknowledgement. The SQL receipt makes an ambiguous retry safe.
  for (let i = state.next; i < part.rows.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, part.rows.length)
    opts.onProgress?.(`Enviando filas ${i + 1}–${end} de ${part.rows.length} (${Math.round(end * 100 / part.rows.length)} %)…`)
    await retry(() => call('inv_upload_rows', { p_upload_id: state!.id, p_rows: part.rows.slice(i, end) }), opts.onProgress)
    state.next = end
  }
  opts.onProgress?.('Aplicando la carga…')
  let applied = await server({ accion: 'aplicar', upload_id: state.id, force: !!opts.force })
  if (applied.fallback) applied = await call<ServerStep>('inv_upload_apply', { p_upload_id: state.id, p_force: !!opts.force })
  if (!applied.success) throw Object.assign(new Error(applied.error || 'No se pudo aplicar la carga'), { partial: !!applied.partial })
  state.applied = applied
  return applied
}

export async function recalcular(onProgress?: (m: string) => void) {
  onProgress?.('Recalculando stock, estadía y trazabilidad…')
  let out = await server({ accion: 'recalcular' })
  if (out.fallback) out = await call<ServerStep>('inv_recalcular')
  if (!out.success) throw new Error(out.error || 'No se pudo recalcular el inventario')
  notifyInvUpdated()
  return out
}
