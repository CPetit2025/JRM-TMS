import { createClient } from '@/lib/supabase/client'
import type { InvParsedPart } from './parse'
import type { InvVerify, InvCatalogs, InvDwell, InvFlow, InvOverview, InvStatus, InvStock, InvStockFilters, InvTrace } from './types'

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
  verify: () => call<InvVerify>('inv_verify'),
  saveCatalog: (p: { bodega: string; kind: string } | { tipodocto: string; clase: string }) => call<{ success: true }>('inv_catalog_save', { p }),
}

// Keep each authenticated RPC well below the database statement timeout.
const CHUNK = 500
const uploads = new WeakMap<InvParsedPart, { id: string; next: number; cutoff: string | undefined; applied: ServerStep | null }>()

// Olvida el avance de una parte para que el próximo intento la vuelva a subir completa
export const resetUpload = (part: InvParsedPart) => { uploads.delete(part) }

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

type ServerStep = { success?: boolean; error?: string; partial?: boolean; fallback?: boolean; timeout?: boolean; busy?: boolean; pending?: boolean } & Record<string, unknown>

async function server(body: Record<string, unknown>): Promise<ServerStep> {
  const res = await fetch('/api/inventario/procesar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let out: ServerStep = {}
  // Sin JSON = la plataforma cortó la petición (tiempo agotado); el trabajo puede seguir en la base
  try { out = await res.json() } catch { out = { success: false, error: `El servidor respondió ${res.status}`, timeout: true } }
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
  let applied: ServerStep = {}
  // Un recálculo en curso toma el bloqueo del inventario: la base responde «busy» y se reintenta (hasta ~8 min)
  for (let wait = 0; ; wait++) {
    applied = await server({ accion: 'aplicar', upload_id: state.id, force: !!opts.force })
    if (applied.fallback) applied = await call<ServerStep>('inv_upload_apply', { p_upload_id: state.id, p_force: !!opts.force })
    if (!applied.busy || wait >= 24) break
    opts.onProgress?.(`Esperando que termine el recálculo en curso para aplicar (${wait + 1})…`)
    await new Promise(resolve => setTimeout(resolve, 15000))
  }
  if (!applied.success) throw Object.assign(new Error(applied.error || 'No se pudo aplicar la carga'), { partial: !!applied.partial })
  state.applied = applied
  return applied
}

// Recalcula en el servidor. Si la petición se corta por tiempo (archivos muy grandes), el trabajo programado de la base
// (inv_rebuild_if_dirty, cada 2 min) termina el recálculo: se informa como pendiente. Un error del recálculo se muestra.
export async function recalcular(onProgress?: (m: string) => void): Promise<{ pending: boolean }> {
  onProgress?.('Recalculando stock, estadía y trazabilidad…')
  let out: ServerStep
  try {
    out = await server({ accion: 'recalcular' })
  } catch (e) {
    if (e instanceof TypeError) { notifyInvUpdated(); return { pending: true } }
    throw e
  }
  if (out.fallback) out = await call<ServerStep>('inv_recalcular')
  notifyInvUpdated()
  if (out.timeout || (out.success && out.pending)) return { pending: true }
  // Un corte por tiempo del recálculo web no pierde nada: el recálculo programado lo completa
  if (!out.success && /statement timeout|canceling statement/i.test(out.error || '')) return { pending: true }
  if (!out.success) throw new Error(out.error || 'No se pudo recalcular el inventario')
  return { pending: false }
}
