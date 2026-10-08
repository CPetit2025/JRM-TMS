// Formatos de una sola línea para celdas de tabla (el detalle completo va en "Ver detalle" o en el title).

/** Fecha y hora de Lima en una línea: "05/10 11:00". */
export function cellDateTime(value: string | null | undefined): string {
  if (!value) return 'Sin fecha'
  const d = new Date(value)
  const day = d.toLocaleDateString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit' })
  const time = d.toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false })
  return `${day} ${time}`
}

/** Fecha y hora completas para el title de la celda. */
export function fullDateTime(value: string | null | undefined): string | undefined {
  return value ? new Date(value).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'full', timeStyle: 'short', hour12: false }) : undefined
}
