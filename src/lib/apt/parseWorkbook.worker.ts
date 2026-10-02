import { parseWorkbooks } from './parseWorkbook'

// Lee los libros fuera del hilo principal para que la pantalla siga respondiendo con archivos grandes (~15 MB)
type Out = { type: 'progress'; message: string } | { type: 'done'; result: ReturnType<typeof parseWorkbooks> } | { type: 'error'; message: string }
const ctx = self as unknown as { postMessage: (m: Out) => void; onmessage: ((e: MessageEvent<{ files: File[] }>) => void) | null }

ctx.onmessage = async e => {
  try {
    const inputs = await Promise.all(e.data.files.map(async f => ({ name: f.name, data: await f.arrayBuffer() })))
    const result = parseWorkbooks(inputs, message => ctx.postMessage({ type: 'progress', message }))
    ctx.postMessage({ type: 'done', result })
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : 'No se pudo leer el archivo' })
  }
}
