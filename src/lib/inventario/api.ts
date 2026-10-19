import { createClient } from '@/lib/supabase/client'
import type { InvParsedPart } from './parse'
import type { InvCatalogs, InvDwell, InvFlow, InvOverview, InvStatus, InvStock, InvStockFilters, InvTrace } from './types'

// Acceso a las funciones public.inv_* (inventario multi-almacén). Todas devuelven { success, error?, ... }.
const supabase = createClient()

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
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

// Bloques chicos: cada petición del navegador tiene 8 s y una red inestable no debe tumbar toda la carga
const CHUNK = 500
const RETRIES = 3
const transient = (msg: string) => /fetch|network|timeout|tiempo de espera|conexi|load failed|50[0234]|gateway|aborted|statement timeout|canceling statement/i.test(msg)

async function withRetry<T>(fn: () => Promise<T>, onRetry?: (n: number) => void): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (attempt >= RETRIES || !transient(msg)) throw e
      onRetry?.(attempt)
      await new Promise(r => setTimeout(r, 1500 * attempt))
    }
  }
}

type ServerStep = { success?: boolean; error?: string; partial?: boolean; fallback?: boolean } & Record<string, unknown>

async function server(body: Record<string, unknown>): Promise<ServerStep> {
  const res = await fetch('/api/inventario/procesar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let out: ServerStep = {}
  try { out = await res.json() } catch { out = { success: false, error: `El servidor respondió ${res.status}${res.status === 504 ? ' (tiempo de espera agotado)' : ''}` } }
  return out
}

export class InvUploadError extends Error {
  partial: boolean
  constructor(message: string, partial = false) { super(message); this.partial = partial }
}

// Sube una parte (Entradas, Salidas o foto de stock): iniciar, enviar filas por bloques y aplicar en el servidor
export async function uploadPart(part: InvParsedPart, opts: { cutoff?: string; force?: boolean; onProgress?: (m: string) => void }) {
  const begin = await call<{ upload_id: string }>('inv_upload_begin', {
    p_side: part.side, p_file_name: `${part.fileName} · ${part.sheetName}`.slice(0, 300), p_cutoff: part.side === 'STOCK' ? opts.cutoff || null : null,
  })
  const id = begin.upload_id
  const blocks = Math.ceil(part.rows.length / CHUNK)
  try {
    for (let i = 0, b = 1; i < part.rows.length; i += CHUNK, b++) {
      const label = `Enviando filas ${i + 1}–${Math.min(i + CHUNK, part.rows.length)} de ${part.rows.length}`
      opts.onProgress?.(`${label}…`)
      try {
        await withRetry(() => call('inv_upload_rows', { p_upload_id: id, p_rows: part.rows.slice(i, i + CHUNK) }),
          n => opts.onProgress?.(`${label} · reintento ${n}…`))
      } catch (e) {
        throw new InvUploadError(`Bloque ${b} de ${blocks} (filas ${i + 1}–${Math.min(i + CHUNK, part.rows.length)}): ${e instanceof Error ? e.message : e}`)
      }
    }
    opts.onProgress?.('Aplicando la carga (reemplazo por fechas)…')
    let applied = await server({ accion: 'aplicar', upload_id: id, force: !!opts.force })
    // Sin llave de servicio en el entorno: se aplica con el permiso del usuario (cargas chicas)
    if (applied.fallback) applied = await call<ServerStep>('inv_upload_apply', { p_upload_id: id, p_force: !!opts.force })
    if (!applied.success) throw new InvUploadError(`Aplicar la carga: ${applied.error || 'sin respuesta del servidor'}`, !!applied.partial)
    return applied
  } catch (e) {
    await supabase.rpc('inv_upload_discard', { p_upload_id: id })
    throw e
  }
}

// Recalcula en el servidor. Si la petición no alcanza (archivos muy grandes), el trabajo programado de la base termina
// el recálculo en unos minutos: la carga ya quedó aplicada y no hay que volver a subirla.
export async function recalcular(onProgress?: (m: string) => void): Promise<{ ok: boolean; message?: string }> {
  onProgress?.('Recalculando stock, estadía y trazabilidad…')
  let out: ServerStep
  try {
    out = await server({ accion: 'recalcular' })
    if (out.fallback) out = await call<ServerStep>('inv_recalcular')
  } catch (e) {
    out = { success: false, error: e instanceof Error ? e.message : String(e) }
  }
  notifyInvUpdated()
  if (!out.success) return { ok: false, message: out.error || 'sin respuesta' }
  return { ok: true }
}
