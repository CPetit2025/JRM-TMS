// Distrito de una dirección para mostrar en tablas (la dirección completa queda en el detalle o en el title).
// Solo es presentación: el tarifario usa su propia lógica de distrito (no se cambia aquí).

const DISTRICTS = [
  // Lima Metropolitana
  'Ancón', 'Ate', 'Barranco', 'Breña', 'Carabayllo', 'Cercado de Lima', 'Chaclacayo', 'Chorrillos', 'Cieneguilla', 'Comas',
  'El Agustino', 'Independencia', 'Jesús María', 'La Molina', 'La Victoria', 'Lince', 'Los Olivos', 'Lurigancho', 'Chosica',
  'Lurín', 'Magdalena del Mar', 'Magdalena', 'Miraflores', 'Pachacámac', 'Pucusana', 'Pueblo Libre', 'Puente Piedra',
  'Punta Hermosa', 'Punta Negra', 'Rímac', 'San Bartolo', 'San Borja', 'San Isidro', 'San Juan de Lurigancho',
  'San Juan de Miraflores', 'San Luis', 'San Martín de Porres', 'San Miguel', 'Santa Anita', 'Santa María del Mar',
  'Santa Rosa', 'Santiago de Surco', 'Surco', 'Surquillo', 'Villa El Salvador', 'Villa María del Triunfo', 'Huachipa', 'Jicamarca',
  // Callao
  'Callao', 'Bellavista', 'Carmen de la Legua', 'La Perla', 'La Punta', 'Ventanilla', 'Mi Perú',
  // Provincias cercanas frecuentes
  'Chilca', 'Mala', 'Cañete', 'Huaral', 'Chancay', 'Huacho', 'Chincha', 'Pisco', 'Ica', 'Huarochirí',
]

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const INDEX = DISTRICTS.map(name => ({ name, key: fold(name) }))
const NOISE = /^(lima|lima metropolitana|lima - lima|peru|perú|provincia de lima|departamento de lima|\d{3,6})$/i

/** Distrito para tablas. Usa el distrito guardado si existe; si no, lo reconoce en la dirección. */
export function districtOf(address?: string | null, district?: string | null): string {
  if (district && district.trim()) return district.trim()
  if (!address || !address.trim()) return 'Sin dirección'
  const text = fold(address)
  // Coincidencia de palabra completa; gana la que termina más a la derecha y, si empatan, la más larga
  let best: { name: string; end: number; len: number } | null = null
  for (const { name, key } of INDEX) {
    const re = new RegExp(`(^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^a-z0-9])`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const end = m.index + m[0].length
      if (!best || end > best.end || (end === best.end && key.length > best.len)) best = { name, end, len: key.length }
    }
  }
  if (best) return best.name === 'Surco' ? 'Santiago de Surco' : best.name === 'Magdalena' ? 'Magdalena del Mar' : best.name
  // Sin coincidencia: último tramo útil separado por comas o guiones
  const parts = address.split(/,| - /).map(p => p.trim()).filter(p => p && !NOISE.test(p))
  const last = parts[parts.length - 1] || address.trim()
  return last.length > 28 ? `${last.slice(0, 27)}…` : last
}
