import { parseInventoryWorkbooks } from './parse'

// Lee los reportes fuera del hilo principal para que la pantalla siga respondiendo con archivos grandes
type Out = { type: 'progress'; message: string } | { type: 'done'; result: ReturnType<typeof parseInventoryWorkbooks> } | { type: 'error'; message: string }
const ctx = self as unknown as { postMessage: (m: Out) => void; onmessage: ((e: MessageEvent<{ files: File[] }>) => void) | null }

ctx.onmessage = async e => {
  try {
    const inputs = await Promise.all(e.data.files.map(async f => ({ name: f.name, data: await f.arrayBuffer() })))
    const result = parseInventoryWorkbooks(inputs, message => ctx.postMessage({ type: 'progress', message }))
    ctx.postMessage({ type: 'done', result })
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : 'No se pudo leer el archivo' })
  }
}
