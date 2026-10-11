// Formatos de una sola línea para celdas de tabla (el detalle completo va en "Ver detalle" o en el title).

/** Fecha y hora de Lima en una línea: "05/10 11:00"; de otro año, con el año ("31/12/25 23:00") para que se
 *  lea y se ordene sin ambigüedad. */
export function cellDateTime(value: string | null | undefined): string {
  if (!value) return 'Sin fecha'
  const d = new Date(value)
  const limaYear = (date: Date) => date.toLocaleDateString('en-CA', { timeZone: 'America/Lima', year: 'numeric' })
  const otherYear = limaYear(d) !== limaYear(new Date())
  const day = d.toLocaleDateString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', ...(otherYear ? { year: '2-digit' } : {}) })
  const time = d.toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false })
  return `${day} ${time}`
}

/** Fecha y hora completas para el title de la celda. */
export function fullDateTime(value: string | null | undefined): string | undefined {
  return value ? new Date(value).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'full', timeStyle: 'short', hour12: false }) : undefined
}
