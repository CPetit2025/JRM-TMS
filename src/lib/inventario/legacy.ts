import { aptApi } from '@/lib/apt/api'
import { parseWorkbooks, type AptParseResult } from '@/lib/apt/parseWorkbook'

// Carga única: los mismos archivos del inventario alimentan también el modelo APT anterior (647 · 540 · ST), del que aún
// leen Registro de Servicios (peso APT), Eficiencia de flota, el detalle de guías, los contadores del menú y la IA.
const BATCH = 250

function readLegacy(files: File[], onProgress: (m: string) => void): Promise<AptParseResult> {
  return new Promise((resolve, reject) => {
    const fallback = () => {
      setTimeout(async () => {
        try {
          const inputs = await Promise.all(files.map(async f => ({ name: f.name, data: await f.arrayBuffer() })))
          resolve(parseWorkbooks(inputs, onProgress))
        } catch (e) { reject(e) }
      }, 50)
    }
    let worker: Worker
    try { worker = new Worker(new URL('../apt/parseWorkbook.worker.ts', import.meta.url), { type: 'module' }) } catch { fallback(); return }
    worker.onmessage = (e: MessageEvent<{ type: string; message?: string; result?: AptParseResult }>) => {
      if (e.data.type === 'progress') onProgress(e.data.message || 'Leyendo…')
      else {
        worker.terminate()
        if (e.data.type === 'done' && e.data.result) resolve(e.data.result)
        else reject(new Error(e.data.message || 'No se pudo leer el archivo'))
      }
    }
    worker.onerror = ev => { ev.preventDefault(); worker.terminate(); fallback() }
    worker.postMessage({ files })
  })
}

async function withRetry<T>(work: () => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try { return await work() } catch (e) {
      if (attempt >= 2 || !(e instanceof TypeError)) throw e
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)))
    }
  }
}

// Devuelve null si terminó bien, o el motivo por el que el APT anterior no se actualizó (no bloquea el inventario)
export async function syncLegacyApt(files: File[], onProgress: (m: string) => void): Promise<string | null> {
  let parsed: AptParseResult
  try {
    parsed = await readLegacy(files, m => onProgress(`Servicios y guías: ${m}`))
  } catch (e) {
    return e instanceof Error ? e.message : 'No se pudo leer el archivo para el APT anterior'
  }
  if (!parsed.sheets.length) return 'El archivo no trae movimientos de 647, 540 o ST-VENTAS'
  let id: string | null = null
  try {
    id = (await aptApi.uploadBegin(files.map(f => f.name).join(' + '))).id
    const total = parsed.sheets.reduce((t, s) => t + s.rows.length, 0)
    let sent = 0
    for (const s of parsed.sheets) {
      for (let i = 0; i < s.rows.length; i += BATCH) {
        onProgress(`Servicios y guías: enviando ${sent + 1}–${Math.min(sent + BATCH, total)} de ${total}…`)
        const batch = s.rows.slice(i, i + BATCH)
        await withRetry(() => aptApi.uploadRows(id as string, s.kind, batch))
        sent += batch.length
      }
    }
    onProgress('Servicios y guías: aplicando…')
    const res = await aptApi.uploadApply(id)
    return res.warning ?? null
  } catch (e) {
    if (id) await aptApi.uploadDiscard(id).catch(() => undefined)
    return e instanceof Error ? e.message : 'No se pudo actualizar el APT anterior'
  }
}
