import { aptApi } from '@/lib/apt/api'
import { isoOf, parseWorkbooks, type AptParseResult } from '@/lib/apt/parseWorkbook'

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

// Devuelve null si terminó bien, o el motivo por el que el APT anterior no se actualizó (no bloquea el inventario).
// Un historial largo (p. ej. 2025–2026) se aplica mes a mes: cada mes reemplaza solo sus fechas por tipo de hoja y el
// servidor no excede su tiempo por consulta; la estadía y el flujo se recalculan una sola vez al final.
export async function syncLegacyApt(files: File[], onProgress: (m: string) => void): Promise<string | null> {
  let parsed: AptParseResult
  try {
    parsed = await readLegacy(files, m => onProgress(`Servicios y guías: ${m}`))
  } catch (e) {
    return e instanceof Error ? e.message : 'No se pudo leer el archivo para el APT anterior'
  }
  if (!parsed.sheets.length) return 'El archivo no trae movimientos de 647, 540 o ST-VENTAS'
  const months = new Map<string, Map<AptParseResult['sheets'][number]['kind'], AptParseResult['sheets'][number]['rows']>>()
  for (const s of parsed.sheets) {
    for (const row of s.rows) {
      const month = isoOf(row.Fecha)?.slice(0, 7) ?? ''  // sin fecha: va con el primer mes (quedan como excluidas)
      if (!months.has(month)) months.set(month, new Map())
      const byKind = months.get(month)!
      if (!byKind.has(s.kind)) byKind.set(s.kind, [])
      byKind.get(s.kind)!.push(row)
    }
  }
  const order = [...months.keys()].filter(Boolean).sort()
  if (months.has('') && order.length) {
    for (const [kind, rows] of months.get('')!) {
      const first = months.get(order[0])!
      first.set(kind, [...(first.get(kind) ?? []), ...rows])
    }
  }
  if (!order.length) return 'El archivo no trae movimientos con fecha'
  const name = files.map(f => f.name).join(' + ')
  let applied = 0
  for (const month of order) {
    const label = order.length > 1 ? ` (${month}, ${applied + 1} de ${order.length})` : ''
    let id: string | null = null
    try {
      id = (await aptApi.uploadBegin(order.length > 1 ? `${name} · ${month}` : name)).id
      const kinds = [...months.get(month)!]
      const total = kinds.reduce((t, [, rows]) => t + rows.length, 0)
      let sent = 0
      for (const [kind, rows] of kinds) {
        for (let i = 0; i < rows.length; i += BATCH) {
          onProgress(`Servicios y guías${label}: enviando ${sent + 1}–${Math.min(sent + BATCH, total)} de ${total}…`)
          const batch = rows.slice(i, i + BATCH)
          await withRetry(() => aptApi.uploadRows(id as string, kind, batch))
          sent += batch.length
        }
      }
      onProgress(`Servicios y guías${label}: aplicando…`)
      await aptApi.uploadApplyOnly(id)
      applied++
    } catch (e) {
      if (id) await aptApi.uploadDiscard(id).catch(() => undefined)
      const why = e instanceof Error ? e.message : 'No se pudo actualizar el APT anterior'
      return applied ? `se aplicó hasta ${order[applied - 1]}; ${month}: ${why}` : `${month}: ${why}`
    }
  }
  onProgress('Servicios y guías: recalculando estadía y flujo…')
  try { await aptApi.rebuildModels() } catch (e) {
    return `la carga quedó aplicada; el recálculo quedó pendiente (${e instanceof Error ? e.message : 'error del servidor'}). Use «Recalcular y vincular todo».`
  }
  return null
}
