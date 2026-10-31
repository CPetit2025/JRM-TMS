// Validaciones del armado de ruta, por etapa. «block» impide avanzar y programar; «warn» exige atención pero no bloquea;
// «info» solo informa. Una alerta informativa nunca reemplaza una validación bloqueante.

export type RouteStep = 1 | 2 | 3 | 4 | 5
export type CheckLevel = 'block' | 'warn' | 'info'
export type RouteCheck = { key: string; label: string; step: RouteStep; level: CheckLevel }

export const ROUTE_STEPS: { step: RouteStep; title: string; hint: string }[] = [
  { step: 1, title: 'Servicios', hint: 'Selecciona las solicitudes' },
  { step: 2, title: 'Transporte', hint: 'Unidad, personal y flete' },
  { step: 3, title: 'Adicionales', hint: 'Servicios especiales' },
  { step: 4, title: 'Salida', hint: 'Programa la ruta' },
  { step: 5, title: 'Validación', hint: 'Revisa y confirma' },
]

/** Lista de validaciones sin las condiciones falsas. */
export function collectChecks(entries: Array<RouteCheck | false | null | undefined>): RouteCheck[] {
  return entries.filter((c): c is RouteCheck => Boolean(c))
}

export const blocking = (checks: RouteCheck[], step?: RouteStep) => checks.filter(c => c.level === 'block' && (step == null || c.step === step))

/** Primera etapa con un bloqueo antes de la indicada (para no saltar validaciones al avanzar). */
export function firstBlockedStep(checks: RouteCheck[], upTo: RouteStep): RouteStep | null {
  const steps = blocking(checks).map(c => c.step).filter(s => s <= upTo)
  return steps.length ? (Math.min(...steps) as RouteStep) : null
}

type Attention = { request_number: string; required_at?: string | null; required_date?: string | null; time_window?: string | null }

/** Fin de la ventana de atención «08:00 - 12:00» (o «08:00 a 12:00»); null si no se puede leer. */
export function windowEnd(window: string | null | undefined): string | null {
  const m = (window || '').match(/(\d{1,2}:\d{2})\s*(?:-|–|a|al|hasta)\s*(\d{1,2}:\d{2})/i)
  return m ? m[2].padStart(5, '0') : null
}

/**
 * Paradas cuya atención requerida queda antes de la salida programada (valor de datetime-local, hora de Lima).
 * Con hora exacta se compara la hora; con fecha, el día y, si la hay, el fin de la ventana de atención.
 */
export function lateStops(requests: Attention[], departure: string): Attention[] {
  if (!departure) return []
  const day = departure.slice(0, 10), time = departure.slice(11, 16)
  return requests.filter(r => {
    if (r.required_at) {
      const due = Date.parse(r.required_at), dep = Date.parse(`${departure}:00-05:00`)
      return Number.isFinite(due) && Number.isFinite(dep) && dep > due
    }
    const date = r.required_date?.slice(0, 10)
    if (!date) return false
    if (day > date) return true
    const end = windowEnd(r.time_window)
    return day === date && !!end && !!time && time > end
  })
}

/** Uso de capacidad en %; null si la capacidad no se conoce. */
export const capacityPct = (value: number, capacity: number | null | undefined) => (capacity && capacity > 0 ? (value / capacity) * 100 : null)
