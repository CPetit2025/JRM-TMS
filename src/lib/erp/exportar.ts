// Exportación completa por páginas: la base entrega como máximo 20.000 filas por consulta, así que se pide página por
// página con orden estable y al final se comprueba que lo exportado coincide con el total filtrado (sin faltantes ni
// repetidos). Si los datos cambian a mitad de la exportación, se detiene en vez de entregar un archivo incompleto.
export interface ErpPage<T> { total: number; filas: T[] }

export async function fetchAllRows<T>(
  fetchPage: (offset: number, limit: number) => Promise<ErpPage<T>>,
  opts: { pageSize?: number; keyOf?: (row: T) => string; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ rows: T[]; total: number }> {
  const pageSize = opts.pageSize ?? 5000
  const rows: T[] = []
  let total: number | null = null
  for (let offset = 0; total === null || offset < total; offset += pageSize) {
    const page = await fetchPage(offset, pageSize)
    if (total === null) total = page.total
    else if (page.total !== total) throw new Error(`Los datos cambiaron durante la exportación (total ${total} → ${page.total}). Vuelva a exportar.`)
    rows.push(...page.filas)
    opts.onProgress?.(rows.length, total)
    if (!page.filas.length) break
  }
  const expected = total ?? 0
  if (rows.length !== expected) throw new Error(`Exportación incompleta: ${rows.length} de ${expected} filas. No se generó el archivo.`)
  if (opts.keyOf && new Set(rows.map(opts.keyOf)).size !== rows.length) throw new Error('La exportación trajo filas repetidas. No se generó el archivo.')
  return { rows, total: expected }
}
