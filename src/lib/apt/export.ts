import * as XLSX from 'xlsx'

// Exportación a Excel de cualquier tabla del módulo (una hoja por arreglo)
export function exportAptXlsx(fileName: string, sheets: Record<string, Array<Record<string, unknown>>>) {
  const wb = XLSX.utils.book_new()
  Object.entries(sheets).forEach(([name, rows]) => {
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ '': 'Sin datos' }])
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31))
  })
  XLSX.writeFile(wb, fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`)
}
