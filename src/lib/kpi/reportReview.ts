type EstadoRevision = 'REVISADO' | 'OBSERVADO'

// Los pendientes abarcan cualquier mes; el historial corresponde al mes elegido y los dos anteriores.
export function informesDelPeriodo<T extends Record<string, unknown>>(informes: T[], periodo: string): T[] {
  const [year, month] = periodo.split('-').map(Number)
  const inicio = new Date(Date.UTC(year, month - 3, 1)).toISOString().slice(0, 10)
  const fin = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10)
  return informes.filter(i => typeof i.periodo === 'string' && i.periodo >= inicio && i.periodo < fin)
}

export async function revisarInforme<T>(estado: EstadoRevision, acciones: {
  prompt: (mensaje: string) => string | null
  confirm: (mensaje: string) => boolean
  guardar: (comentario: string | null) => PromiseLike<T>
}): Promise<T | null> {
  const comentario = acciones.prompt(estado === 'OBSERVADO' ? '¿Qué debe corregir?' : 'Comentario (opcional):')
  if (comentario === null) return null
  if (estado === 'OBSERVADO' && !comentario.trim()) return null
  if (estado === 'REVISADO' && !acciones.confirm('¿Confirmar que el informe ha sido revisado?')) return null
  return acciones.guardar(comentario.trim() || null)
}
