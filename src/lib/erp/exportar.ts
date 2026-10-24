// Exportación completa por páginas: la base entrega como máximo 20.000 filas por consulta, así que se pide página por
// página con orden estable y al final se comprueba que lo exportado coincide con el total filtrado (sin faltantes ni
// repetidos). Cada página informa las cargas del ERP con que se calculó (version); si cambian a mitad de la exportación,
// aunque el total y las claves sigan iguales, se detiene en vez de entregar un archivo que mezcla cortes.
export interface ErpPage<T> { total: number; filas: T[]; version?: string }

export async function fetchAllRows<T>(
  fetchPage: (offset: number, limit: number) => Promise<ErpPage<T>>,
  opts: { pageSize?: number; keyOf?: (row: T) => string; onProgress?: (done: number, total: number) => void; version?: string } = {},
): Promise<{ rows: T[]; total: number; version?: string }> {
  const pageSize = opts.pageSize ?? 5000
  const rows: T[] = []
  let total: number | null = null
  let version = opts.version
  for (let offset = 0; total === null || offset < total; offset += pageSize) {
    const page = await fetchPage(offset, pageSize)
    if (total === null) total = page.total
    else if (page.total !== total) throw new Error(`Los datos cambiaron durante la exportación (total ${total} → ${page.total}). Vuelva a exportar.`)
    if (version === undefined) version = page.version
    else if (page.version !== version) throw new Error('Las cargas del ERP cambiaron durante la exportación. No se generó el archivo; vuelva a exportar.')
    rows.push(...page.filas)
    opts.onProgress?.(rows.length, total)
    if (!page.filas.length) break
  }
  const expected = total ?? 0
  if (rows.length !== expected) throw new Error(`Exportación incompleta: ${rows.length} de ${expected} filas. No se generó el archivo.`)
  if (opts.keyOf && new Set(rows.map(opts.keyOf)).size !== rows.length) throw new Error('La exportación trajo filas repetidas. No se generó el archivo.')
  return { rows, total: expected, version }
}
