// Peso contractual: el formulario se captura en toneladas y se guarda en kg (contracts.total_weight_kg, DECIMAL(10,2)).
export const MAX_TONS = 99_999.99
const MAX_VOLUME_M3 = 99_999_999.99

export function tonsToKg(value: string | number | null | undefined): number {
  const tons = Number(value || 0)
  if (!Number.isFinite(tons) || tons < 0) throw new Error('El peso debe ser un número positivo (en toneladas).')
  if (tons > MAX_TONS) {
    throw new Error(`El peso se ingresa en toneladas: ${tons.toLocaleString('es-PE')} t supera el máximo de ${MAX_TONS.toLocaleString('es-PE')} t. ¿Lo ingresó en kilogramos?`)
  }
  return Math.round(tons * 1000 * 100) / 100
}

export function checkVolume(value: string | number | null | undefined): number {
  const m3 = Number(value || 0)
  if (!Number.isFinite(m3) || m3 < 0 || m3 > MAX_VOLUME_M3) throw new Error('El volumen (m³) no es válido.')
  return m3
}

export const kgHint = (tons: string | number | null | undefined) => {
  const n = Number(tons || 0)
  return n > 0 ? `= ${(n * 1000).toLocaleString('es-PE', { maximumFractionDigits: 2 })} kg` : ''
}
