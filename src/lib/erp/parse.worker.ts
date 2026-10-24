import { parseErpWorkbooks } from './parse'

// Lee los Excel del ERP fuera del hilo principal (el Actualizable pesa ~12 MB)
type Out = { type: 'progress'; message: string } | { type: 'done'; result: ReturnType<typeof parseErpWorkbooks> } | { type: 'error'; message: string }
const ctx = self as unknown as { postMessage: (m: Out) => void; onmessage: ((e: MessageEvent<{ files: File[] }>) => void) | null }

ctx.onmessage = async e => {
  try {
    const inputs = await Promise.all(e.data.files.map(async f => ({ name: f.name, data: await f.arrayBuffer() })))
    const result = parseErpWorkbooks(inputs, message => ctx.postMessage({ type: 'progress', message }))
    ctx.postMessage({ type: 'done', result })
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : 'No se pudo leer el archivo' })
  }
}
