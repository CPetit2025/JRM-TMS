// Orden genérico de tablas: interpreta el texto visible de una celda (o su data-sort-value) como número, monto,
// fecha o texto, para que cualquier columna se ordene de forma natural. Vacíos y guiones siempre al final.

export type SortDirection = 'ascending' | 'descending'
type Key = { kind: 'empty' } | { kind: 'number'; value: number } | { kind: 'text'; value: string }

const EMPTY = /^(?:|—|-|–|n\/d|s\/d|sin dato|sin datos)$/i
const DATE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?:[ ,]+(\d{1,2}):(\d{2})(?:\s*([ap])\.?\s*m\.?)?)?/i
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/

function dateKey(text: string): number | null {
  const iso = ISO.exec(text)
  if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3], +(iso[4] || 0), +(iso[5] || 0))
  const m = DATE.exec(text)
  if (!m) return null
  const day = +m[1], month = +m[2]
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  let year = m[3] ? +m[3] : new Date().getFullYear()
  if (year < 100) year += 2000
  let hour = m[4] ? +m[4] : 0
  if (m[6]) { const pm = m[6].toLowerCase() === 'p'; if (pm && hour < 12) hour += 12; if (!pm && hour === 12) hour = 0 }
  return Date.UTC(year, month - 1, day, hour, m[5] ? +m[5] : 0)
}

function numberKey(text: string): number | null {
  // Montos y cantidades: «S/ 1,234.56», «-12.5 %», «1 250 kg», «3.2 h»
  const clean = text.replace(/^(?:S\/|US\$|\$|PEN|USD)\s*/i, '').replace(/\s*(?:%|km|kg|t|h|d|días|und|u)\.?$/i, '').replace(/\s/g, '')
  if (!/^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(clean)) return null
  const value = Number(clean.replace(/,/g, ''))
  return Number.isFinite(value) ? value : null
}

export function sortKey(raw: string | null | undefined): Key {
  const text = (raw || '').replace(/\s+/g, ' ').trim()
  if (EMPTY.test(text)) return { kind: 'empty' }
  const date = dateKey(text)
  if (date !== null) return { kind: 'number', value: date }
  const number = numberKey(text)
  if (number !== null) return { kind: 'number', value: number }
  return { kind: 'text', value: text }
}

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' })

/** Compara dos celdas; los vacíos quedan al final en ambos sentidos. */
export function compareCells(a: string | null | undefined, b: string | null | undefined, direction: SortDirection): number {
  const x = sortKey(a), y = sortKey(b)
  if (x.kind === 'empty' || y.kind === 'empty') return x.kind === y.kind ? 0 : x.kind === 'empty' ? 1 : -1
  const sign = direction === 'ascending' ? 1 : -1
  if (x.kind === 'number' && y.kind === 'number') return sign * (x.value - y.value)
  if (x.kind === 'number') return -sign // números antes que texto
  if (y.kind === 'number') return sign
  return sign * collator.compare(x.value, y.value)
}

/** Siguiente estado al hacer clic: ascendente → descendente → sin orden. */
export function nextDirection(current: SortDirection | null): SortDirection | null {
  return current === null ? 'ascending' : current === 'ascending' ? 'descending' : null
}
